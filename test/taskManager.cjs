const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = {
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }
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
