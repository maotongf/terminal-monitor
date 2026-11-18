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

test('postState prunes terminal and Codex bindings that are no longer live', () => {
  const live = { id: 'live', name: 'zsh', terminal: {}, createdAt: 1 };
  const p = Object.create(DashboardProvider.prototype);
  p.tasks = { getTerminals: () => [live] };
  p.codex = { getTasks: () => [{ id: 'current' }] };
  p.terminalOrder = new Map([['live', 0], ['closed', 1]]);
  p.terminalActivity = new Map([['live', 1], ['closed', 2]]);
  p.codexTerminalBindings = new Map([
    ['current', { id: 'live', confidence: 3 }],
    ['old-task', { id: 'live', confidence: 3 }],
    ['closed-terminal', { id: 'closed', confidence: 3 }]
  ]);

  p.postState();
  assert.deepEqual([...p.terminalOrder.keys()], ['live']);
  assert.deepEqual([...p.terminalActivity.keys()], ['live']);
  assert.deepEqual([...p.codexTerminalBindings.keys()], ['current']);
});

test('idle terminal count excludes VS Code terminals hidden from the user', () => {
  const visible = { id: 'visible', name: 'zsh', terminal: { creationOptions: {} }, createdAt: 1 };
  const hidden = { id: 'hidden', name: 'Codex internal', terminal: { creationOptions: { hideFromUser: true } }, createdAt: 2 };
  const p = Object.create(DashboardProvider.prototype);
  p.tasks = { getTerminals: () => [visible, hidden], getActiveTasks: () => [], getHistory: () => [] };
  p.codexTerminalBindings = new Map();
  p.terminalActivity = new Map();
  p.terminalOrder = new Map();
  p.codex = { getTasks: () => [], isAvailable: () => true, getLastSync: () => 1 };
  p.diagnostic = () => {};
  let state;
  p.view = { webview: { postMessage: message => { state = message; return Promise.resolve(true); } } };

  p.postState();
  assert.deepEqual(state.idle.map(task => task.terminalId), ['visible']);
});

test('dashboard skips unchanged and hidden state pushes, then sends the latest state on reveal', () => {
  const terminal = { id: 'visible', name: 'zsh', terminal: {}, createdAt: 1, shellIntegrationAvailable: true };
  const provider = Object.create(DashboardProvider.prototype);
  let visible = true;
  const messages = [];
  provider.tasks = {
    getTerminals: () => [terminal], getActiveTasks: () => [], getHistory: () => [],
    getTerminalInfo: () => terminal, getTerminalById: id => id === terminal.id ? terminal : undefined
  };
  provider.codex = { getTasks: () => [], isAvailable: () => true, getLastSync: () => 1 };
  provider.codexTerminalBindings = new Map();
  provider.terminalActivity = new Map();
  provider.terminalOrder = new Map();
  provider.lastPostedStateSnapshot = '';
  provider.lastPostCounts = '';
  provider.diagnostic = () => {};
  provider.view = {
    get visible() { return visible; },
    webview: { postMessage: message => { messages.push(message); return Promise.resolve(true); } }
  };

  provider.postState();
  provider.postState();
  assert.equal(messages.length, 1);

  visible = false;
  terminal.name = 'bash';
  provider.postState();
  assert.equal(messages.length, 1);

  visible = true;
  provider.postState();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].idle[0].terminalName, 'bash');
});

test('dashboard retries unchanged state after the webview rejects a post', async () => {
  const provider = Object.create(DashboardProvider.prototype);
  let accepted = false;
  let posts = 0;
  provider.tasks = { getTerminals: () => [], getActiveTasks: () => [], getHistory: () => [] };
  provider.codex = { getTasks: () => [], isAvailable: () => true, getLastSync: () => 1 };
  provider.codexTerminalBindings = new Map();
  provider.terminalActivity = new Map();
  provider.terminalOrder = new Map();
  provider.lastPostedStateSnapshot = '';
  provider.lastPostCounts = '';
  provider.diagnostic = () => {};
  provider.view = { visible: true, webview: { postMessage: () => { posts++; return Promise.resolve(accepted); } } };

  provider.postState();
  await Promise.resolve();
  assert.equal(provider.lastPostedStateSnapshot, '');

  accepted = true;
  provider.postState();
  await Promise.resolve();
  assert.equal(posts, 2);
  assert.notEqual(provider.lastPostedStateSnapshot, '');
});

test('Codex polling only signals changed data or connection state', async () => {
  const monitor = Object.create(CodexMonitor.prototype);
  let changes = 0;
  monitor.polling = false;
  monitor.available = false;
  monitor.tasks = [];
  monitor.lastSnapshot = '';
  monitor.lastConnectionState = undefined;
  monitor.recentReplyCache = new Map();
  monitor.notificationStates = new Map();
  monitor.notifiedCodexTransitions = new Set();
  monitor.notificationBaselineReady = false;
  monitor.onChange = () => { changes++; };
  monitor.diagnostic = () => {};
  monitor.client = { request: async () => ({ data: [] }) };

  await monitor.poll();
  await monitor.poll();
  assert.equal(changes, 1);

  monitor.client = { request: async () => { throw new Error('offline'); } };
  await monitor.poll();
  await monitor.poll();
  assert.equal(changes, 2);
});

test('temporary disconnection retains tasks and recovery updates state', async () => {
  const p = Object.create(CodexMonitor.prototype);
  p.polling = false; p.available = true; p.tasks = [{ id:'old' }]; p.recentReplyCache = new Map(); p.recentReplyRequests = new Map(); p.notificationStates = new Map(); p.notifiedCodexTransitions = new Set(); p.notificationBaselineReady = false; p.diagnostic=()=>{}; p.onChange=()=>{};
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

test('recent Codex reply is fetched only for the requested turn and cached', async () => {
  const monitor = Object.create(CodexMonitor.prototype);
  monitor.available = true;
  monitor.tasks = [{ id: 'thread-1', turnId: 'turn-a' }];
  monitor.recentReplyCache = new Map();
  monitor.recentReplyRequests = new Map();
  let calls = 0;
  let request;
  monitor.client = { request: async (method, params) => {
    calls++;
    request = { method, params };
    return { data: [{ item: { type: 'agentMessage', phase: 'final_answer', text: 'A concise answer.' } }] };
  } };

  assert.equal(await monitor.getRecentReply('thread-1', 'turn-a'), 'A concise answer.');
  assert.equal(await monitor.getRecentReply('thread-1', 'turn-a'), 'A concise answer.');
  assert.equal(await monitor.getRecentReply('thread-1', 'old-turn'), undefined);
  assert.equal(calls, 1);
  assert.equal(request.method, 'thread/items/list');
  assert.deepEqual(request.params, {
    threadId: 'thread-1', turnId: 'turn-a', limit: 10, sortDirection: 'desc',
    deferOutput: { commandExecution: true, mcpToolCall: true }
  });
});

test('Codex notifications follow state transitions once per turn and skip initial history', () => {
  const events = [];
  const monitor = Object.create(CodexMonitor.prototype);
  monitor.available = true;
  monitor.tasks = [];
  monitor.lastSnapshot = '';
  monitor.recentReplyCache = new Map();
  monitor.notificationStates = new Map();
  monitor.notifiedCodexTransitions = new Set();
  monitor.notificationBaselineReady = false;
  monitor.onChange = () => {};
  monitor.onCodexTransition = (_task, transition) => events.push(transition);
  const task = { id: 'thread', turnId: 'turn-1', status: 'completed', waitingReason: undefined };

  monitor.updateTasks([task]); // Initial completed history is only a baseline.
  monitor.updateTasks([{ ...task, status: 'running' }]);
  monitor.updateTasks([{ ...task, status: 'completed' }]);
  monitor.updateTasks([{ ...task, status: 'running' }]);
  monitor.updateTasks([{ ...task, status: 'completed' }]);
  monitor.updateTasks([{ ...task, status: 'failed' }]);
  monitor.updateTasks([{ ...task, status: 'failed' }]);
  assert.deepEqual(events, ['completed', 'failed']);
});

test('Codex approval notification ignores tool waiting and fires when approval is needed', () => {
  const events = [];
  const monitor = Object.create(CodexMonitor.prototype);
  monitor.available = true;
  monitor.tasks = [];
  monitor.lastSnapshot = '';
  monitor.recentReplyCache = new Map();
  monitor.notificationStates = new Map();
  monitor.notifiedCodexTransitions = new Set();
  monitor.notificationBaselineReady = false;
  monitor.onChange = () => {};
  monitor.onCodexTransition = (_task, transition) => events.push(transition);
  const task = { id: 'thread', turnId: 'turn-1', status: 'waiting', waitingReason: 'tool' };

  monitor.updateTasks([task]);
  monitor.updateTasks([{ ...task, waitingReason: 'approval' }]);
  monitor.updateTasks([{ ...task, waitingReason: 'approval' }]);
  assert.deepEqual(events, ['approval']);
});

test('cumulative oversized fragments destroy socket', () => {
  const c = new AppServerClient('/unused'); let destroyed = false;
  c.socket = { destroy: () => { destroyed = true; } };
  c.fragmentOpcode = 1; c.fragments = [Buffer.alloc(8 * 1024 * 1024)]; c.fragmentBytes = 8 * 1024 * 1024;
  c.consumeFrames(Buffer.from([0x80, 0x01, 0x61]));
  assert.equal(destroyed, true);
});
