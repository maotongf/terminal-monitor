const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let configuration = {};
const messages = [];
const vscode = {
  workspace: { getConfiguration: () => ({ get: (key, fallback) => configuration[key] ?? fallback }) },
  window: {
    showInformationMessage: message => { messages.push(['info', message]); },
    showErrorMessage: message => { messages.push(['error', message]); },
    showWarningMessage: message => { messages.push(['warning', message]); }
  }
};
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { Notifier } = require('../dist/notification/notifier');
Module._load = originalLoad;

test('Codex notification transitions honor independent settings', () => {
  const notifier = new Notifier();
  const task = { id: 't', name: 'Build feature' };
  notifier.notifyCodexTransition(task, 'completed');
  notifier.notifyCodexTransition(task, 'failed');
  notifier.notifyCodexTransition(task, 'approval');
  assert.deepEqual(messages.map(([kind]) => kind), ['info', 'error', 'warning']);

  configuration = {
    codexCompletionNotifications: false,
    codexFailureNotifications: false,
    codexApprovalNotifications: false
  };
  notifier.notifyCodexTransition(task, 'completed');
  notifier.notifyCodexTransition(task, 'failed');
  notifier.notifyCodexTransition(task, 'approval');
  assert.equal(messages.length, 3);
});
