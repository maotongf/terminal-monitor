const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = {
  window: { activeTerminal: undefined },
  Uri: { file: path => path, joinPath: (...parts) => parts.join('/') },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) }
};
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { DashboardProvider } = require('../dist/ui/dashboardProvider');
const { CodexMonitor } = require('../dist/codex/codexMonitor');
const { AppServerClient } = require('../dist/codex/appServerClient');
Module._load = originalLoad;

function bareCodexMonitor(client, diagnostic = () => {}) {
  const monitor = Object.create(CodexMonitor.prototype);
  Object.assign(monitor, {
    client, polling: false, started: false, refreshRequested: false, available: false,
    failureCount: 0, tasks: [], lastSnapshot: '', lastConnectionState: undefined,
    lastPollMetricsSnapshot: '', recentTaskCache: new Map(), recentReplyCache: new Map(),
    notificationStates: new Map(), notifiedCodexTransitions: new Set(),
    notificationBaselineReady: false, onChange: () => {}, diagnostic
  });
  return monitor;
}

test('same-folder tasks remain visible; strong title match replaces fallback', () => {
  const a = { id: 'a', name: 'shell', cwd: '/p', terminal: {}, createdAt: 1 };
  const b = { id: 'b', name: 'shell', cwd: '/p', terminal: {}, createdAt: 2 };
  vscode.window.activeTerminal = a.terminal;
  const p = Object.create(DashboardProvider.prototype);
  p.tasks = { getTerminals: () => [a,b], getTerminalInfo: t => t === a.terminal ? a : b, getTerminalById: id => [a,b].find(t => t.id === id), getActiveTasks: () => [{id:'1',terminalId:'a',type:'codex',cwd:'/p'}, {id:'2',terminalId:'b',type:'codex',cwd:'/p'}], getHistory: () => [] };
  p.codexTerminalBindings = new Map(); p.historyFallbackTerminals = new Map(); p.terminalActivity = new Map(); p.terminalOrder = new Map();
  const task = { id:'thread', name:'Fix project', cwd:'/p', source:'cli', status:'running', startTime:1 };
  const fallbackBinding = p.bindCodexTask(task);
  assert.equal(fallbackBinding.terminalId, 'a');
  assert.equal(fallbackBinding.terminalBindingConfidence, 1);
  assert.equal(fallbackBinding.terminalBindingReason, 'recentActivity');
  let state; p.view = { webview: { postMessage: x => { state=x; return Promise.resolve(true); } } };
  p.codex = { getTasks: () => [task], isAvailable: () => true, getLastSync: () => 1 }; p.diagnostic = () => {};
  p.postState(); assert.equal(state.active.length, 2);
  b.name = 'Fix project';
  const correctedBinding = p.bindCodexTask(task);
  assert.equal(correctedBinding.terminalId, 'b');
  assert.equal(correctedBinding.terminalBindingConfidence, 2);
  assert.equal(correctedBinding.terminalBindingReason, 'titleAndFolder');
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
  p.codexTerminalBindings = new Map(); p.historyFallbackTerminals = new Map(); p.terminalActivity = new Map(); p.terminalOrder = new Map();
  const task={id:'thread',name:'CLI task',source:'cli',cwd:'/p',status:'running',startTime:10000,updatedAt:10000};
  let state; p.view={webview:{postMessage:x=>{state=x;return Promise.resolve(true)}}};
  p.codex={getTasks:()=>[task],isAvailable:()=>true,getLastSync:()=>10000}; p.diagnostic=()=>{};
  p.postState();
  assert.equal(state.active.length,1);
  assert.equal(state.active[0].terminalId,'b');
  assert.equal(state.codex[0].terminalBindingReason,'relatedTask');
  assert.equal(state.codex[0].terminalBindingConfidence,2);
});

test('postState prunes terminal and Codex bindings that are no longer live', () => {
  const live = { id: 'live', name: 'zsh', terminal: {}, createdAt: 1 };
  const p = Object.create(DashboardProvider.prototype);
  p.tasks = { getTerminals: () => [live], getHistory: () => [] };
  p.codex = { getTasks: () => [{ id: 'current' }] };
  p.terminalOrder = new Map([['live', 0], ['closed', 1]]);
  p.terminalActivity = new Map([['live', 1], ['closed', 2]]);
  p.codexTerminalBindings = new Map([
    ['current', { id: 'live', confidence: 3 }],
    ['old-task', { id: 'live', confidence: 3 }],
    ['closed-terminal', { id: 'closed', confidence: 3 }]
  ]);
  p.historyFallbackTerminals = new Map();

  p.postState();
  assert.deepEqual([...p.terminalOrder.keys()], ['live']);
  assert.deepEqual([...p.terminalActivity.keys()], ['live']);
  assert.deepEqual([...p.codexTerminalBindings.keys()], ['current']);
});

test('closing a linked terminal hides its Codex turn until a new turn starts', () => {
  const terminal = { id: 'terminal-1', name: 'Codex', cwd: '/project', terminal: {}, createdAt: 1, shellIntegrationAvailable: true };
  let terminals = [terminal];
  let turnId = 'turn-1';
  let state;
  const p = Object.create(DashboardProvider.prototype);
  p.tasks = {
    getTerminals: () => terminals,
    getTerminalById: id => terminals.find(item => item.id === id),
    getActiveTasks: () => [],
    getHistory: () => []
  };
  p.codex = {
    getTasks: () => [{ id: 'thread-1', turnId, name: 'Codex', cwd: '/project', source: 'cli', status: 'completed', startTime: 1, updatedAt: 2 }],
    isAvailable: () => true,
    getLastSync: () => 2
  };
  p.codexTerminalBindings = new Map([['thread-1', { id: terminal.id, confidence: 3, reason: 'manual' }]]);
  p.knownTerminalIds = new Set([terminal.id]);
  p.historyFallbackTerminals = new Map();
  p.terminalActivity = new Map();
  p.terminalOrder = new Map();
  p.diagnostic = () => {};
  p.view = { visible: true, webview: { postMessage: message => { state = message; return Promise.resolve(true); } } };

  p.postState();
  assert.equal(state.codex.length, 1);
  terminals = [];
  p.captureClosedTerminalTasks();
  p.postState();
  assert.equal(state.codex.length, 0);
  assert.equal(p.closedCodexTaskTurns.get('thread-1'), 'turn-1');

  turnId = 'turn-2';
  p.postState();
  assert.equal(state.codex.length, 1);
  assert.equal(p.closedCodexTaskTurns.has('thread-1'), false);
});

test('closed history tasks explain and reuse their fallback terminal', () => {
  const task = { id: 'task-1', terminalId: 'closed', name: 'Build', cwd: '/workspace/project', status: 'completed', startTime: 1, recentOutput: [] };
  const oldTerminals = vscode.window.terminals;
  const oldCreateTerminal = vscode.window.createTerminal;
  const oldUriFile = vscode.Uri.file;
  const fallback = { show() { this.showCount = (this.showCount || 0) + 1; } };
  let createCount = 0;
  vscode.window.terminals = [];
  vscode.window.createTerminal = options => { createCount++; fallback.options = options; vscode.window.terminals.push(fallback); return fallback; };
  vscode.window.showInformationMessage = () => {};
  vscode.Uri.file = path => path;

  const p = Object.create(DashboardProvider.prototype);
  p.tasks = {
    getTerminalById: () => undefined,
    getTerminalInfo: terminal => terminal === fallback ? { id: 'reopened', terminal } : undefined,
    getHistory: () => [task],
    getActiveTasks: () => []
  };
  p.historyFallbackTerminals = new Map();
  p.terminalOrder = new Map([['reopened', 0]]);

  p.focusTerminal({ terminalId: 'closed', taskId: 'task-1' });
  p.focusTerminal({ terminalId: 'closed', taskId: 'task-1' });
  const dashboardTask = p.toDashboard(task);
  assert.equal(createCount, 1);
  assert.equal(fallback.showCount, 2);
  assert.equal(fallback.options.cwd, '/workspace/project');
  assert.equal(dashboardTask.terminalId, 'reopened');
  assert.equal(dashboardTask.terminalOpen, true);

  vscode.window.terminals = oldTerminals;
  if (oldCreateTerminal === undefined) delete vscode.window.createTerminal;
  else vscode.window.createTerminal = oldCreateTerminal;
  vscode.Uri.file = oldUriFile;
});

test('idle terminal count excludes VS Code terminals hidden from the user', () => {
  const visible = { id: 'visible', name: 'zsh', terminal: { creationOptions: {} }, createdAt: 1 };
  const hidden = { id: 'hidden', name: 'Codex internal', terminal: { creationOptions: { hideFromUser: true } }, createdAt: 2 };
  const p = Object.create(DashboardProvider.prototype);
  p.tasks = { getTerminals: () => [visible, hidden], getActiveTasks: () => [], getHistory: () => [] };
  p.codexTerminalBindings = new Map();
  p.historyFallbackTerminals = new Map();
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
  provider.historyFallbackTerminals = new Map();
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
  provider.historyFallbackTerminals = new Map();
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

test('Codex poll caches completed threads and limits concurrent turn reads', async () => {
  const monitor = Object.create(CodexMonitor.prototype);
  const now = Date.now();
  const activeIds = new Set(Array.from({ length: 6 }, (_, index) => `active-${index}`));
  const rows = [
    ...[...activeIds].map(id => ({ id, updatedAt: now, source: 'cli', status: { type: 'active', activeFlags: [] } })),
    ...['recent-1', 'recent-2'].map(id => ({ id, updatedAt: now - 60_000, source: 'cli', status: { type: 'idle', activeFlags: [] } }))
  ];
  let totalRequests = 0;
  let inFlight = 0;
  let observedPeak = 0;
  monitor.polling = false;
  monitor.available = false;
  monitor.failureCount = 0;
  monitor.tasks = [];
  monitor.lastSnapshot = '';
  monitor.lastConnectionState = undefined;
  monitor.lastPollMetricsSnapshot = '';
  monitor.recentTaskCache = new Map();
  monitor.recentReplyCache = new Map();
  monitor.notificationStates = new Map();
  monitor.notifiedCodexTransitions = new Set();
  monitor.notificationBaselineReady = false;
  monitor.onChange = () => {};
  monitor.diagnostic = () => {};
  monitor.client = { request: async (method, params) => {
    totalRequests++;
    if (method === 'thread/list') return { data: rows };
    inFlight++;
    observedPeak = Math.max(observedPeak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 2));
    inFlight--;
    return { data: [{
      id: `${params.threadId}-turn`, status: activeIds.has(params.threadId) ? 'inProgress' : 'completed',
      startedAt: now - 1000, completedAt: activeIds.has(params.threadId) ? undefined : now
    }] };
  } };

  const beforeFirstPoll = totalRequests;
  await monitor.poll();
  const firstPollRequests = totalRequests - beforeFirstPoll;
  assert.equal(firstPollRequests, 9); // 1 thread list + 8 uncached turn reads.
  assert.equal(observedPeak, 4);

  const beforeSecondPoll = totalRequests;
  await monitor.poll();
  const secondPollRequests = totalRequests - beforeSecondPoll;
  assert.equal(secondPollRequests, 7); // 1 thread list + 6 active turn reads; recent rows came from cache.
  assert.equal(monitor.lastPollMetrics.recentCacheHits, 2);
  assert.equal(monitor.lastPollMetrics.turnRequests, 6);
  assert.ok(monitor.lastPollMetrics.maxConcurrentTurnReads <= 4);
});

test('Codex recent-task cache does not hide a new turn in the same thread', async () => {
  const monitor = Object.create(CodexMonitor.prototype);
  const now = Date.now();
  let thread = { id: 'same-thread', updatedAt: now, source: 'cli', status: { type: 'idle', activeFlags: [] } };
  let turn = { id: 'turn-1', status: 'completed', startedAt: now - 2000, completedAt: now };
  let turnReads = 0;
  monitor.polling = false;
  monitor.available = false;
  monitor.failureCount = 0;
  monitor.tasks = [];
  monitor.lastSnapshot = '';
  monitor.lastConnectionState = undefined;
  monitor.lastPollMetricsSnapshot = '';
  monitor.recentTaskCache = new Map();
  monitor.recentReplyCache = new Map();
  monitor.notificationStates = new Map();
  monitor.notifiedCodexTransitions = new Set();
  monitor.notificationBaselineReady = false;
  monitor.onChange = () => {};
  monitor.diagnostic = () => {};
  monitor.client = { request: async method => {
    if (method === 'thread/list') return { data: [thread] };
    turnReads++;
    return { data: [turn] };
  } };

  await monitor.poll();
  assert.equal(monitor.getTasks()[0].turnId, 'turn-1');
  await monitor.poll();
  assert.equal(turnReads, 1); // unchanged completed turn reused

  thread = { ...thread, updatedAt: now + 1000, status: { type: 'active', activeFlags: [] } };
  turn = { id: 'turn-2', status: 'inProgress', startedAt: now + 1000 };
  await monitor.poll();
  assert.equal(turnReads, 2);
  assert.equal(monitor.getTasks()[0].turnId, 'turn-2');
  assert.equal(monitor.getTasks()[0].status, 'running');

  thread = { ...thread, updatedAt: now + 2000, status: { type: 'idle', activeFlags: [] } };
  turn = { id: 'turn-3', status: 'completed', startedAt: now + 1500, completedAt: now + 2000 };
  await monitor.poll();
  assert.equal(turnReads, 3);
  assert.equal(monitor.getTasks()[0].turnId, 'turn-3');
  assert.equal(monitor.getTasks()[0].status, 'completed');
});

test('Codex connection retry backs off and resets after recovery', async () => {
  const monitor = Object.create(CodexMonitor.prototype);
  monitor.polling = false;
  monitor.available = false;
  monitor.failureCount = 0;
  monitor.tasks = [];
  monitor.lastSnapshot = '';
  monitor.lastConnectionState = undefined;
  monitor.lastPollMetricsSnapshot = '';
  monitor.recentTaskCache = new Map();
  monitor.recentReplyCache = new Map();
  monitor.notificationStates = new Map();
  monitor.notifiedCodexTransitions = new Set();
  monitor.notificationBaselineReady = false;
  monitor.onChange = () => {};
  monitor.diagnostic = () => {};
  monitor.client = { request: async () => { throw new Error('offline'); } };

  await monitor.poll();
  assert.equal(monitor.nextPollDelayMs(), 6000);
  await monitor.poll();
  assert.equal(monitor.nextPollDelayMs(), 12_000);

  monitor.client = { request: async () => ({ data: [] }) };
  await monitor.poll();
  assert.equal(monitor.isAvailable(), true);
  assert.equal(monitor.failureCount, 0);
  assert.equal(monitor.nextPollDelayMs(), 10_000);
  monitor.tasks = [{ status: 'running' }];
  assert.equal(monitor.nextPollDelayMs(), 3000);
});

test('Codex thread polling follows cursor pages and retains sessions after the first 100', async () => {
  const now = Date.now();
  const olderRows = Array.from({ length: 100 }, (_, index) => ({
    id: `old-${index}`, updatedAt: now - 2 * 60 * 60 * 1000, source: 'cli', status: { type: 'idle', activeFlags: [] }
  }));
  const finalActive = { id: 'active-page-2', updatedAt: now, source: 'vscode', status: { type: 'active', activeFlags: [] } };
  const calls = [];
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace/project' } }];
  vscode.workspace.getConfiguration = () => ({ get: (_key, fallback) => fallback });
  const monitor = bareCodexMonitor({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') {
      return params.cursor
        ? { data: [finalActive], nextCursor: null }
        : { data: olderRows, nextCursor: 'opaque-next-cursor' };
    }
    return { data: [{ id: 'turn-current', status: 'inProgress', startedAt: now - 1000 }] };
  } });

  await monitor.poll();
  const pages = calls.filter(call => call.method === 'thread/list');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].params.limit, 100);
  assert.equal(pages[0].params.cwd[0], '/workspace/project');
  assert.equal(pages[1].params.cursor, 'opaque-next-cursor');
  assert.equal(monitor.lastPollMetrics.threadListPages, 2);
  assert.equal(monitor.getTasks()[0].id, 'active-page-2');
  assert.equal(monitor.getScopeLabel(), '当前工作区');
  vscode.workspace.workspaceFolders = [];
});

test('Codex scope defaults to all sessions without a workspace and supports all-session mode', () => {
  let configuredScope = 'workspace';
  vscode.workspace.workspaceFolders = [];
  vscode.workspace.getConfiguration = () => ({ get: (_key, fallback) => configuredScope || fallback });
  const monitor = bareCodexMonitor({ request: async () => ({ data: [], nextCursor: null }) });
  assert.equal(monitor.getScopeLabel(), '全部会话 · 无工作区');

  configuredScope = 'all';
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace/project' } }];
  assert.equal(monitor.getScopeLabel(), '全部会话');
  configuredScope = 'workspace';
  vscode.workspace.workspaceFolders = [];
});

test('Codex pagination cursor loops are surfaced instead of silently claiming completeness', async () => {
  let pages = 0;
  const monitor = bareCodexMonitor({ request: async method => {
    if (method !== 'thread/list') return { data: [] };
    pages++;
    return { data: [{ id: `thread-${pages}`, updatedAt: Date.now() - 2 * 60 * 60 * 1000, status: { type: 'idle' } }], nextCursor: 'same-cursor' };
  } });
  await monitor.poll();
  assert.equal(pages, 2);
  assert.equal(monitor.getPaginationIncomplete(), true);
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

test('App Server initialization opts into the experimental capability used by reply reads', async () => {
  const c = new AppServerClient('/unused', '1.11.0');
  let initializeParams;
  let initializedMessage;
  c.socket = { destroy() {} };
  c.upgraded = true;
  c.requestRaw = async (method, params) => {
    assert.equal(method, 'initialize');
    initializeParams = params;
    return {};
  };
  c.sendMessage = message => { initializedMessage = message; };

  await c.ensureInitialized();

  assert.equal(initializeParams.capabilities.experimentalApi, true);
  assert.equal(initializedMessage.method, 'initialized');
  c.dispose();
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
