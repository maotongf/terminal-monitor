const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalOutputStream } = require('../dist/utils/terminalOutputStream');

test('joins text split across chunks and keeps an incomplete line visible', () => {
  const stream = new TerminalOutputStream();
  assert.deepEqual(stream.push('hel', 5), ['hel']);
  assert.deepEqual(stream.push('lo\nnext', 5), ['hello', 'next']);
  assert.deepEqual(stream.flush(5), ['hello', 'next']);
});

test('strips CSI and OSC sequences split across chunks without leaking fragments', () => {
  const stream = new TerminalOutputStream();
  assert.deepEqual(stream.push('\u001b[3', 5), []);
  assert.deepEqual(stream.push('1mred\u001b[0m\n\u001b]0;ti', 5), ['red']);
  assert.deepEqual(stream.push('tle\u0007visible\n', 5), ['red', 'visible']);
});

test('flushes command tail and respects configured recent line limit', () => {
  const stream = new TerminalOutputStream();
  stream.push('one\ntwo\nthree\npartial', 2);
  assert.deepEqual(stream.snapshot(2), ['three', 'partial']);
  assert.deepEqual(stream.flush(2), ['three', 'partial']);
});
