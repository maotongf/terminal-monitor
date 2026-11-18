const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractRecentReply } = require('../dist/codex/recentReply');

test('extracts only the newest explicitly final public agent message', () => {
  const reply = extractRecentReply([
    { item: { type: 'reasoning', summary: ['internal'] } },
    { item: { type: 'agentMessage', phase: 'commentary', text: 'working' } },
    { item: { type: 'agentMessage', phase: 'final_answer', text: 'Latest answer' } },
    { item: { type: 'agentMessage', phase: 'final_answer', text: 'Older answer' } }
  ]);
  assert.equal(reply, 'Latest answer');
});

test('omits unclassified, partial, reasoning, empty and moderated messages', () => {
  const reply = extractRecentReply([
    { item: { type: 'agentMessage', phase: 'partial_answer', text: 'partial' } },
    { item: { type: 'agentMessage', phase: null, text: 'unknown phase' } },
    { item: { type: 'agentMessage', phase: 'final_answer', text: 'hidden', moderation: { moderated: true } } },
    { item: { type: 'reasoning', phase: 'final_answer', text: 'reasoning' } },
    { item: { type: 'agentMessage', phase: 'final_answer', text: '  \n ' } }
  ]);
  assert.equal(reply, undefined);
});

test('normalizes whitespace and truncates long replies', () => {
  const reply = extractRecentReply([{ type: 'agentMessage', phase: 'final_answer', text: ` ${'x'.repeat(500)}\n\n\nnext ` }]);
  assert.equal(reply.length, 420);
  assert.equal(reply.endsWith('…'), true);
  assert.equal(reply.includes('\n\n\n'), false);
});
