const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = { window: { activeTerminal: undefined }, workspace: {} };
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { DashboardProvider } = require('../dist/ui/dashboardProvider');
const { CodexMonitor } = require('../dist/codex/codexMonitor');
const { AppServerClient } = require('../dist/codex/appServerClient');
Module._load = originalLoad;

test('same-folder tasks remain visible; strong title match replaces fallback', () => {
  const a = { id: 'a', name: 'shell', cwd: '/p', terminal: {}, createdAt: 1 };
  const b = { id: 'b', name: 'shell', cwd: '/p', terminal: {}, createdAt: 2 };
  vscode.window.activeTerminal = a.terminal;
  const p = Object.create(DashboardProvider.prototype);
  p.tasks = { getTerminals: () => [a,b], getTerminalInfo: t => t === a.terminal ? a : b, getTerminalById: id => [a,b].find(t => t.id === id), getActiveTasks: () => [{id:'1',terminalId:'a',type:'codex',cwd:'/p'}, {id:'2',terminalId:'b',type:'codex',cwd:'/p'}], getHistory: () => [] };
  p.codexTerminalBindings = new Map(); p.terminalActivity = new Map(); p.terminalOrder = new Map();
  const task = { id:'thread', name:'Fix project', cwd:'/p', source:'cli', status:'running', startTime:1 };
  assert.equal(p.bindCodexTask(task).terminalId, 'a');
  let state; p.view = { webview: { postMessage: x => { state=x; return Promise.resolve(true); } } };
  p.codex = { getTasks: () => [task], isAvailable: () => true, getLastSync: () => 1 }; p.diagnostic = () => {};
  p.postState(); assert.equal(state.active.length, 2);
  b.name = 'Fix project';
  assert.equal(p.bindCodexTask(task).terminalId, 'b');
  p.postState(); assert.equal(state.active.length, 1);
  assert.equal(state.active[0].terminalId, 'a');
});

test('only a confidently linked Codex CLI terminal is deduplicated', () => {
  const a = { id: 'a', name: 'zsh', cwd: '/p', terminal: {}, createdAt: 1 };
  const b = { id: 'b', name: 'zsh', cwd: '/p', terminal: {}, createdAt: 2 };
  const p = Object.create(DashboardProvider.prototype);
  p.tasks = {
    getTerminals: () => [a,b], getTerminalInfo: t => t === a.terminal ? a : b,
    getTerminalById: id => [a,b].find(t => t.id === id),
    getActiveTasks: () => [
      {id:'run-a',terminalId:'a',type:'codex',cwd:'/p',startTime:10000},
      {id:'run-b',terminalId:'b',type:'codex',cwd:'/p',startTime:900000}
    ], getHistory: () => []
  };
  p.codexTerminalBindings = new Map(); p.terminalActivity = new Map(); p.terminalOrder = new Map();
  const task={id:'thread',name:'CLI task',source:'cli',cwd:'/p',status:'running',startTime:10000,updatedAt:10000};
  let state; p.view={webview:{postMessage:x=>{state=x;return Promise.resolve(true)}}};
  p.codex={getTasks:()=>[task],isAvailable:()=>true,getLastSync:()=>10000}; p.diagnostic=()=>{};
  p.postState();
  assert.equal(state.active.length,1);
  assert.equal(state.active[0].terminalId,'b');
});

test('temporary disconnection retains tasks and recovery updates state', async () => {
  const p = Object.create(CodexMonitor.prototype);
  p.polling = false; p.available = true; p.tasks = [{ id:'old' }]; p.diagnostic=()=>{}; p.onChange=()=>{};
  p.client = { request: async () => { throw Error('offline'); } };
  await p.poll(); assert.equal(p.available, false); assert.equal(p.tasks[0].id, 'old');
  p.client = { request: async () => ({ data: [] }) };
  await p.poll(); assert.equal(p.available, true); assert.equal(p.tasks.length, 0); assert.ok(p.getLastSync());
});

test('oversized frame destroys original socket and disposed client cannot reconnect', async () => {
  const c = new AppServerClient('/unused'); let destroyed = false;
  c.socket = { destroy: () => { destroyed=true; } };
  const frame = Buffer.alloc(10); frame[0]=0x81; frame[1]=127; frame.writeBigUInt64BE(9n*1024n*1024n,2);
  c.consumeFrames(frame); assert.equal(destroyed,true);
  c.dispose(); await assert.rejects(c.request('thread/list', {}), /disposed/);
});

test('Codex turn timing and waiting reasons use server data', async () => {
  const p = Object.create(CodexMonitor.prototype);
  let turn = { status: 'inProgress', items: [{ type:'commandExecution', status:'completed' }] };
  p.client = { request: async () => ({ data: [turn] }) };
  const thread = { id:'t', cwd:'/p', updatedAt:1700000000, status:{ type:'active', activeFlags:[] } };
  let task = await p.readTask(thread);
  assert.equal(task.startTime, 0);
  assert.equal(task.currentStep, 'Codex 正在处理任务');
  turn = { status:'inProgress', startedAt:1700000000, items:[{ type:'commandExecution', status:'inProgress' }] };
  task = await p.readTask(thread);
  assert.equal(task.startTime, 1700000000000);
  assert.equal(task.currentStep, '正在运行命令');
  thread.status.activeFlags = ['waitingOnApproval']; task = await p.readTask(thread);
  assert.equal(task.waitingReason, 'approval');
  thread.status.activeFlags = ['waitingOnExternalTool']; task = await p.readTask(thread);
  assert.equal(task.waitingReason, 'tool');
});

test('cumulative oversized fragments destroy socket', () => {
  const c = new AppServerClient('/unused'); let destroyed = false;
  c.socket = { destroy: () => { destroyed = true; } };
  c.fragmentOpcode = 1; c.fragments = [Buffer.alloc(8 * 1024 * 1024)]; c.fragmentBytes = 8 * 1024 * 1024;
  c.consumeFrames(Buffer.from([0x80, 0x01, 0x61]));
  assert.equal(destroyed, true);
});
