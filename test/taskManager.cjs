const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let historyLimit = 10;
const vscode = {
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => historyLimit ?? fallback }) }
};
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { TaskManager } = require('../dist/core/taskManager');
Module._load = originalLoad;

test('reconcileTerminals removes missed close events and finishes their active task', () => {
  const liveTerminal = { name: 'zsh' };
  const staleTerminal = { name: 'old shell' };
  const manager = Object.create(TaskManager.prototype);
  manager.terminals = new Map();
  manager.terminalIds = new WeakMap();
  manager.tasks = new Map();
  manager.history = [];
  manager.outputStreams = new Map();
  manager.changeEmitter = { fire() {} };
  const liveInfo = { id: 'live', terminal: liveTerminal, currentTaskId: undefined };
  const staleInfo = { id: 'stale', terminal: staleTerminal, currentTaskId: 'running-task' };
  manager.terminals.set(liveInfo.id, liveInfo);
  manager.terminals.set(staleInfo.id, staleInfo);
  manager.terminalIds.set(liveTerminal, liveInfo.id);
  manager.terminalIds.set(staleTerminal, staleInfo.id);
  manager.tasks.set('running-task', {
    id: 'running-task', terminalId: 'stale', status: 'running', startTime: 1, recentOutput: []
  });

  manager.reconcileTerminals([liveTerminal]);

  assert.deepEqual(manager.getTerminals().map(info => info.id), ['live']);
  assert.equal(manager.getActiveTasks().length, 0);
  assert.equal(manager.getHistory()[0].status, 'unknown');
});

test('historyLimit consistently retains zero, five, ten and one hundred completed tasks', () => {
  for (const limit of [0, 5, 10, 100]) {
    historyLimit = limit;
    const manager = Object.create(TaskManager.prototype);
    manager.terminals = new Map();
    manager.tasks = new Map();
    manager.history = [];
    manager.outputStreams = new Map();
    manager.changeEmitter = { fire() {} };
    for (let index = 0; index < 12; index++) {
      const id = `task-${index}`;
      manager.tasks.set(id, { id, terminalId: 'terminal', status: 'running', startTime: 1, recentOutput: [] });
      manager.finishTask(id, 0);
    }
    assert.equal(manager.getHistory().length, Math.min(12, limit));
  }
  historyLimit = 10;
});

test('large output is bounded and the final lines are saved when a task finishes', () => {
  const manager = Object.create(TaskManager.prototype);
  manager.terminals = new Map();
  manager.tasks = new Map([['task', { id: 'task', terminalId: 'terminal', status: 'running', startTime: 1, recentOutput: [] }]]);
  manager.history = [];
  manager.outputStreams = new Map();
  manager.pendingOutputs = new Map();
  manager.changeEmitter = { fire() {} };

  manager.appendOutput('task', 'x'.repeat(5_000_000) + '\nfinal line\n');
  assert.equal(manager.tasks.get('task').recentOutput.length, 0);
  assert.ok(manager.pendingOutputs.get('task').text.length <= 32_000);
  manager.finishTask('task', 0);
  assert.equal(manager.getHistory()[0].recentOutput.at(-1), 'final line');
  assert.equal(manager.pendingOutputs.size, 0);
});
