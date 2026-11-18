const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectTaskKind } = require('../dist/agents/agentDetector');

test('detects the actual executable through common wrappers', () => {
  for (const command of [
    'codex --full-auto',
    'sudo -u fmt codex --full-auto',
    'env CODEX_HOME=/tmp/codex codex',
    'env -u CODEX_HOME codex',
    'npx --yes @openai/codex',
    'npm exec -- codex',
    '"/opt/Codex Tools/codex" --help',
    'C:\\Tools\\codex.exe --help'
  ]) assert.equal(detectTaskKind(command), 'codex', command);
  assert.equal(detectTaskKind('claude --dangerously-skip-permissions'), 'claude');
});

test('does not classify arguments or script names as agent executables', () => {
  for (const command of ['echo codex', 'git add agent.ts', 'python script.py codex', 'npm run codex', 'echo "claude"']) {
    assert.equal(detectTaskKind(command), command.startsWith('python') ? 'python' : 'other', command);
  }
});
