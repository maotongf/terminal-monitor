const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const handlers = {};
const vscode = {
  env: {},
  window: {
    terminals: [],
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    onDidOpenTerminal: fn => { handlers.open = fn; return { dispose() {} }; },
    onDidCloseTerminal: fn => { handlers.close = fn; return { dispose() {} }; },
    onDidChangeTerminalShellIntegration: fn => { handlers.integration = fn; return { dispose() {} }; },
    onDidStartTerminalShellExecution: fn => { handlers.start = fn; return { dispose() {} }; },
    onDidEndTerminalShellExecution: fn => { handlers.end = fn; return { dispose() {} }; }
  }
};
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { TerminalWatcher } = require('../dist/monitor/terminalWatcher');
Module._load = originalLoad;

test('end event finishes the task belonging to its execution, not the terminal current task', async () => {
  const terminal = { name: 'zsh' };
  let currentTaskId;
  const finished = [];
  let sequence = 0;
  const tasks = {
    registerTerminal: () => ({ id: 'terminal-1', shellIntegrationAvailable: false }),
    updateTerminalName() {},
    startTask: () => {
      currentTaskId = `task-${++sequence}`;
      return { id: currentTaskId, type: 'other' };
    },
    reconcileTerminals() {},
    getTerminals: () => [],
    finishTask: id => { finished.push(id); return { id, type: 'other' }; }
  };
  const watcher = new TerminalWatcher(tasks, { notifyTaskEnd() {} });
  watcher.start();
  const firstExecution = { commandLine: { value: 'echo first' }, read: async function* () {} };
  const secondExecution = { commandLine: { value: 'echo second' }, read: async function* () {} };
  handlers.start({ terminal, execution: firstExecution });
  handlers.start({ terminal, execution: secondExecution });
  assert.equal(currentTaskId, 'task-2');

  await handlers.end({ terminal, execution: firstExecution, exitCode: 0 });
  assert.deepEqual(finished, ['task-1']);
  assert.equal(currentTaskId, 'task-2');
  watcher.dispose();
});

test('output drain wait is bounded when a shell reader never ends', async () => {
  const watcher = Object.create(TerminalWatcher.prototype);
  watcher.readers = new Map([['stuck', new Promise(() => {})]]);
  const started = Date.now();
  await watcher.waitForReader('stuck', 10);
  assert.ok(Date.now() - started < 250);
});
