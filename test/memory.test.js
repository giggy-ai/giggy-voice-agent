'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConversationMemory } = require('../memory');
const compactingMemory = () => new ConversationMemory([], { maxMessages: 16, maxCharacters: 6000, keepMessages: 6 });
const options = providerFetch => ({ providerFetch, apiKey: 'test-deepseek-credential', signal: new AbortController().signal });
function fill(memory, count = 18) {
  for (let i = 0; i < count; i++) memory.append(i % 2 ? 'assistant' : 'user', `Message ${i}: ${'context '.repeat(30)}`);
}
test('default policy keeps ordinary history intact, including more than 32 messages', async () => {
  const memory = new ConversationMemory();
  for (let i = 0; i < 50; i++) memory.append(i % 2 ? 'assistant' : 'user', `Message ${i}`);
  await memory.compact(options(() => { throw new Error('Early compaction would cost extra'); }));
  assert.equal(memory.messages().length, 50); assert.equal(memory.messages()[0].content, 'Message 0');
});
test('actual input token usage triggers long-context compaction with eight recent messages', async () => {
  const memory = new ConversationMemory(); fill(memory);
  memory.observeUsage({ prompt_tokens: 8192 });
  const before = memory.messages();
  await memory.compact(options(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Known project facts.' } }] })));
  assert.deepEqual(memory.messages().slice(1), before.slice(-8));
  assert.equal(memory.lastPromptTokens, 0);
});
test('failed compaction backs off until four new messages arrive', async () => {
  const memory = compactingMemory(); fill(memory); let calls = 0;
  const config = options(async () => { calls++; return new Response('Unavailable', { status: 503 }); });
  await memory.compact(config); await memory.compact(config);
  for (let i = 0; i < 3; i++) { memory.append('user', 'Follow-up'); await memory.compact(config); }
  assert.equal(calls, 1);
  memory.append('assistant', 'Reply'); await memory.compact(config); assert.equal(calls, 2);
});
test('assistant output remains verbatim up to the demo output limit for prefix matching', () => {
  const memory = new ConversationMemory(); const answer = 'x'.repeat(1500);
  memory.append('assistant', answer); assert.equal(memory.messages()[0].content, answer);
});
test('short conversations append without rewriting the reusable prefix or calling a summarizer', async () => {
  const memory = new ConversationMemory(); memory.append('user', 'My name is Ada.');
  const prefix = memory.messages(); memory.append('assistant', 'Hello Ada.');
  assert.deepEqual(memory.messages().slice(0, prefix.length), prefix);
  await memory.compact(options(() => { throw new Error('Unexpected summary call'); }));
  assert.equal(memory.messages().length, 2);
});
test('compaction preserves a bounded summary and six recent messages, reducing future input size', async () => {
  const memory = compactingMemory(); fill(memory);
  const before = memory.messages(), recent = before.slice(-6);
  const usage = { prompt_tokens: 1600, completion_tokens: 25 };
  const result = await memory.compact(options(async (url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.stream, false); assert.equal(body.max_tokens, 300);
    assert.equal(JSON.parse(body.messages[1].content).older_messages.length, 12);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Ada prefers concise answers.' } }], usage });
  }));
  assert.deepEqual(result, usage);
  assert.deepEqual(memory.messages().slice(1), recent);
  assert.ok(JSON.stringify(memory.messages()).length < JSON.stringify(before).length / 2);
  const prefix = memory.messages(); memory.append('user', 'Next question');
  assert.deepEqual(memory.messages().slice(0, prefix.length), prefix);
});
test('a later summary incorporates the previous summary without leaking into another session', async () => {
  const memory = compactingMemory(); fill(memory);
  await memory.compact(options(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Ada prefers concise answers.' } }] })));
  fill(memory, 12);
  await memory.compact(options(async (url, request) => {
    assert.equal(JSON.parse(JSON.parse(request.body).messages[1].content).previous_summary, 'Ada prefers concise answers.');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Ada prefers concise answers and JavaScript.' } }] });
  }));
  assert.deepEqual(new ConversationMemory().messages(), []);
});
for (const outcome of ['http', 'empty', 'truncated', 'oversized', 'network']) {
  test(`summary failure preserves history (${outcome})`, async () => {
    const memory = compactingMemory(); fill(memory); const before = memory.messages();
    await memory.compact(options(async () => {
      if (outcome === 'network') throw new Error('Offline');
      if (outcome === 'http') return new Response('Error', { status: 503 });
      return Response.json({ choices: [{ finish_reason: outcome === 'truncated' ? 'length' : 'stop',
        message: { content: outcome === 'empty' ? '' : outcome === 'oversized' ? 'x'.repeat(1300) : 'Partial summary' } }] });
    }));
    assert.deepEqual(memory.messages(), before);
  });
}
test('interrupted compaction cannot replace session memory', async () => {
  const memory = compactingMemory(); fill(memory); const before = memory.messages();
  const controller = new AbortController();
  await assert.rejects(memory.compact({ ...options(async () => {
    controller.abort();
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Summary' } }] });
  }), signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(memory.messages(), before);
});
