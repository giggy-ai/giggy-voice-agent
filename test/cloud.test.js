'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCloudHandler } = require('../cloud');
const VOICE = '85e13e59-c1e6-55d5-bee0-7e9f9deb0802';
function session() { return { sessionId: 'test-session', credentials: {
  giggyKey: 'test-giggy-credential', deepseekKey: 'test-deepseek-credential', voiceIds: new Set([VOICE]),
}, audioSequence: 0, controllers: new Set(), turn: null, capture: null }; }
function connection(events) { return { readyState: 1, bufferedAmount: 0, send: raw => events.push(JSON.parse(raw)) }; }
const voice = { voice_source: 'voice_library', voice_library_uuid: VOICE };
test('server retains prior turns with a stable request prefix and reports cached tokens', async () => {
  const calls = [], events = [], account = session();
  const send = createCloudHandler({ providerFetch: async (url, options) => {
    if (url.includes('deepseek')) {
      const body = JSON.parse(options.body); calls.push(body);
      assert.deepEqual(body.stream_options, { include_usage: true });
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello Ada.' } }] }) +
        '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 5,
          prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 } }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(new Uint8Array(4), { headers: { 'Content-Type': 'audio/pcm' } });
  } });
  await send(connection(events), { type: 'voice_agent_user_text', text: 'My name is Ada.', turn_id: 'one', voice }, account);
  await send(connection(events), { type: 'voice_agent_user_text', text: 'What is my name?', turn_id: 'two', voice }, account);
  assert.deepEqual(calls[1].messages.slice(0, calls[0].messages.length), calls[0].messages);
  assert.deepEqual(calls[1].messages.slice(-2), [{ role: 'assistant', content: 'Hello Ada.' }, { role: 'user', content: 'What is my name?' }]);
  assert.equal(events.filter(e => e.type === 'voice_agent_metrics').at(-1).metrics.llm_usage.prompt_cache_hit_tokens, 100);
  const reconnected = { ...session(), credentials: account.credentials };
  await send(connection(events), { type: 'voice_agent_user_text', text: 'Do you still remember?', turn_id: 'three', voice }, reconnected);
  assert.deepEqual(calls[2].messages.slice(0, calls[1].messages.length), calls[1].messages);
});
test('long conversation uses the compacted context and records summary usage separately', async () => {
  const calls = [], events = [], account = session();
  const { ConversationMemory } = require('../memory');
  const history = Array.from({ length: 18 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Older message ${i}` }));
  account.memory = new ConversationMemory(history, { maxMessages: 16, keepMessages: 6 });
  const send = createCloudHandler({ providerFetch: async (url, options) => {
    if (url.includes('deepseek')) {
      const body = JSON.parse(options.body); calls.push(body);
      if (!body.stream) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'The user is Ada.' } }],
        usage: { prompt_tokens: 100, completion_tokens: 8 } });
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello Ada.' } }] }) + '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(new Uint8Array(4), { headers: { 'Content-Type': 'audio/pcm' } });
  } });
  await send(connection(events), { type: 'voice_agent_user_text', text: 'Remember me?', thread_history: history, turn_id: 'compact', voice }, account);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /The user is Ada/);
  assert.deepEqual(calls[1].messages.slice(2, -1), history.slice(-6));
  assert.equal(calls[1].messages.at(-1).content, 'Remember me?');
  assert.equal(events.find(e => e.type === 'voice_agent_metrics').metrics.llm_summary_usage.completion_tokens, 8);
});
test('session startup automatically speaks one main-demo greeting with the selected voice', async () => {
  const events = [], calls = [], account = session(), ws = connection(events);
  const send = createCloudHandler({ providerFetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(new Uint8Array(8), { headers: { 'Content-Type': 'audio/pcm' } });
  } });
  await send(ws, { type: 'voice_agent_session_start', voice }, account);
  assert.equal(events[0].type, 'voice_agent_session_ready');
  const intro = events.find(e => e.type === 'voice_agent_intro');
  assert.match(intro.turn_id, /^greeting-/);
  assert.ok(intro.text.length > 20);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://giggy.ai/v1/text-to-speech');
  assert.equal(calls[0].body.voice_id, VOICE); assert.equal(calls[0].body.text, intro.text);
  assert.ok(events.some(e => e.type === 'voice_agent_audio_chunk' && e.turn_id === intro.turn_id));
  assert.equal(events.at(-1).type, 'voice_agent_turn_done');
  await send(ws, { type: 'voice_agent_session_start', voice }, account);
  assert.equal(calls.length, 1);
  assert.equal(account.controllers.size, 0);
});
test('stopping the introduction aborts speech and never reports a completed greeting', { timeout: 3000 }, async () => {
  const events = [], account = session(), ws = connection(events); let prepared;
  const requested = new Promise(resolve => { prepared = resolve; });
  const send = createCloudHandler({ providerFetch: (url, options) => new Promise((resolve, reject) => {
    prepared(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  const pending = send(ws, { type: 'voice_agent_session_start', voice }, account);
  await requested;
  await send(ws, { type: 'voice_agent_session_end' }, account);
  await pending;
  assert.ok(!events.some(e => e.type === 'voice_agent_audio_chunk' || e.type === 'voice_agent_turn_done'));
  assert.equal(account.controllers.size, 0);
});
test('an unavailable introduction returns a safe error and clears its controller', async () => {
  const events = [], account = session();
  const send = createCloudHandler({ providerFetch: async () => new Response('Private upstream failure', { status: 503 }) });
  await send(connection(events), { type: 'voice_agent_session_start', voice }, account);
  assert.equal(events.at(-1).type, 'voice_agent_error'); assert.equal(events.at(-1).intro, true);
  assert.doesNotMatch(JSON.stringify(events), /Private upstream failure/);
  assert.equal(account.controllers.size, 0);
});
test('STT starts uploading after 200 ms and retains batched uploads thereafter', { timeout: 3000 }, async () => {
  const account = session(), ws = connection([]), uploads = [], encoder = new TextEncoder();
  let sttController, generation, firstUpload;
  const firstUploaded = new Promise(resolve => { firstUpload = resolve; });
  const frame = event => encoder.encode('data: ' + JSON.stringify(event) + '\n\n');
  const send = createCloudHandler({ providerFetch: async (url, options) => {
    if (url.endsWith('/audio/transcriptions')) {
      assert.deepEqual(JSON.parse(options.body), { mode: 'streaming', microphone: true });
      generation = '12345678-1234-4234-8234-123456789abc';
      return new Response(new ReadableStream({ start(controller) {
        sttController = controller;
        controller.enqueue(encoder.encode('event: generation_created\ndata: ' + JSON.stringify({ generation_uuid: generation }) + '\n\n'));
        controller.enqueue(frame({ input_token: 'a'.repeat(64), generation_uuid: generation, attempt: 1 }));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith('/stt-input')) {
      const body = JSON.parse(options.body); uploads.push(body); firstUpload();
      if (body.complete) {
        sttController.enqueue(frame({ text: 'Hello', complete: true }));
        sttController.enqueue(frame({ status: 'completed' })); sttController.close();
      }
      return Response.json({ ok: true });
    }
    if (url.includes('deepseek')) return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hi.' } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return new Response(new Uint8Array(4), { headers: { 'Content-Type': 'audio/pcm' } });
  } });
  await send(ws, { type: 'voice_agent_audio_start', turn_id: 'first-upload', voice }, account);
  await send(ws, { type: 'voice_agent_audio_chunk', turn_id: 'first-upload', sequence: 0, sample_rate: 16000, chunk_base64: Buffer.alloc(6400).toString('base64') }, account);
  const pipeline = account.capture.pipeline;
  await firstUploaded;
  assert.equal(uploads.length, 1); assert.equal(uploads[0].complete, false);
  assert.equal(Buffer.from(uploads[0].pcm_base64, 'base64').length, 6400);
  await send(ws, { type: 'voice_agent_audio_chunk', turn_id: 'first-upload', sequence: 1, sample_rate: 16000, chunk_base64: Buffer.alloc(6400).toString('base64') }, account);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploads.length, 1);
  await send(ws, { type: 'voice_agent_audio_end', turn_id: 'first-upload' }, account);
  await pipeline;
  assert.equal(uploads.at(-1).complete, true);
});
for (const outcome of ['completed', 'failed', 'interrupted']) {
  test(`speech preparation overlaps STT, but output waits for confirmation (${outcome})`, { timeout: 3000 }, async () => {
    const events = [], account = session(), ws = connection(events), encoder = new TextEncoder();
    let sttController, generation, startedTts;
    const prepared = new Promise(resolve => { startedTts = resolve; });
    const frame = event => encoder.encode('data: ' + JSON.stringify(event) + '\n\n');
    const send = createCloudHandler({ providerFetch: async (url, options) => {
      if (url.endsWith('/audio/transcriptions')) {
        assert.deepEqual(JSON.parse(options.body), { mode: 'streaming', microphone: true });
      generation = '12345678-1234-4234-8234-123456789abc';
        return new Response(new ReadableStream({ start(controller) {
          sttController = controller;
          controller.enqueue(encoder.encode('event: generation_created\ndata: ' + JSON.stringify({ generation_uuid: generation }) + '\n\n'));
        controller.enqueue(frame({ input_token: 'a'.repeat(64), generation_uuid: generation, attempt: 1 }));
          options.signal.addEventListener('abort', () => { try { controller.error(options.signal.reason); } catch {} }, { once: true });
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.endsWith('/stt-input')) {
        if (JSON.parse(options.body).complete) sttController.enqueue(frame({ text: 'Hello', complete: true }));
        return Response.json({ ok: true });
      }
      if (url.includes('deepseek')) return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello back.' } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      startedTts();
      return new Response(new Uint8Array(4), { headers: { 'Content-Type': 'audio/pcm' } });
    } });
    await send(ws, { type: 'voice_agent_audio_start', turn_id: 'overlap', voice }, account);
    await send(ws, { type: 'voice_agent_audio_chunk', turn_id: 'overlap', sequence: 0, sample_rate: 16000,
      chunk_base64: Buffer.alloc(6400).toString('base64'), voice }, account);
    const pipeline = account.capture.pipeline;
    await send(ws, { type: 'voice_agent_audio_end', turn_id: 'overlap', voice }, account);
    await prepared;
    assert.ok(!events.some(e => e.type === 'voice_agent_audio_chunk' || e.type === 'voice_agent_assistant_text_delta'));
    if (outcome === 'interrupted') await send(ws, { type: 'voice_agent_interrupt', turn_id: 'overlap' }, account);
    else { sttController.enqueue(frame({ status: outcome })); sttController.close(); }
    await pipeline;
    // Let the aborted TTS task settle before checking cleanup.
    await new Promise(resolve => setImmediate(resolve));
    if (outcome === 'completed') assert.ok(events.some(e => e.type === 'voice_agent_audio_chunk'));
    else assert.ok(!events.some(e => e.type === 'voice_agent_audio_chunk' || e.type === 'voice_agent_turn_done'));
    assert.equal(account.controllers.size, 0);
  });
}
test('a long first clause reaches TTS before the LLM finishes, preserving word order', async () => {
  const events = [], spoken = [], encoder = new TextEncoder(); let controller, markStarted;
  const ttsStarted = new Promise(resolve => { markStarted = resolve; });
  const send = createCloudHandler({ providerFetch: async (url, options) => {
    if (url.includes('deepseek')) return new Response(new ReadableStream({ start(c) {
      controller = c;
      c.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Let us start with a simple useful step, ' } }] }) + '\n\n'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    spoken.push(JSON.parse(options.body).text); markStarted();
    return new Response(new Uint8Array(4), { headers: { 'Content-Type': 'audio/pcm' } });
  } });
  const pending = send(connection(events), { type: 'voice_agent_user_text', text: 'Help me', turn_id: 'clause-turn', voice }, session());
  await ttsStarted;
  assert.equal(spoken[0], 'Let us start with a simple useful step,');
  assert.ok(!events.some(event => event.type === 'voice_agent_turn_done'));
  controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'and work through the rest together.' } }] }) + '\n\ndata: [DONE]\n\n'));
  controller.close(); await pending;
  assert.equal(spoken.join(' '), 'Let us start with a simple useful step, and work through the rest together.');
  assert.equal(events.at(-1).type, 'voice_agent_turn_done');
});
test('typed turn streams DeepSeek text and production Giggy PCM with the user credentials', async () => {
  const calls = [], events = [], account = session();
  const send = createCloudHandler({ providerFetch: async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://api.deepseek.com/chat/completions')
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello there.' } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    if (url === 'https://giggy.ai/v1/text-to-speech')
      return new Response(new Uint8Array([0, 0, 10, 0]), { headers: { 'Content-Type': 'audio/pcm' } });
    throw new Error('Unexpected endpoint');
  } });
  await send(connection(events), { type: 'voice_agent_user_text', text: 'Hi', turn_id: 'turn-1', voice }, account);
  assert.deepEqual(calls.map(c => c.url), ['https://api.deepseek.com/chat/completions', 'https://giggy.ai/v1/text-to-speech']);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-deepseek-credential');
  assert.equal(calls[1].options.headers['xi-api-key'], 'test-giggy-credential');
  assert.equal(JSON.parse(calls[1].options.body).voice_id, VOICE);
  assert.equal(events.find(e => e.type === 'voice_agent_audio_chunk').audio_format, 'audio/pcm;rate=24000;channels=1;bits=16');
  assert.equal(events.at(-1).type, 'voice_agent_turn_done');
  assert.doesNotMatch(JSON.stringify(events), /test-giggy-credential|test-deepseek-credential/);
});
test('voices outside the authenticated account never cause provider calls', async () => {
  const events = []; let calls = 0;
  const send = createCloudHandler({ providerFetch: () => { calls++; throw new Error('Should not call'); } });
  await send(connection(events), { type: 'voice_agent_user_text', text: 'Hi', voice: { ...voice, voice_library_uuid: 'e743eabc-8c1f-4720-874c-4aa888044b6e' } }, session());
  assert.equal(calls, 0); assert.equal(events[0].type, 'voice_agent_error');
});
test('provider error bodies and messages containing secrets are never echoed to clients', async () => {
  const events = [];
  const send = createCloudHandler({ providerFetch: () => { throw new Error('test-giggy-credential'); } });
  await send(connection(events), { type: 'voice_agent_user_text', text: 'Hi', voice }, session());
  assert.equal(events[0].type, 'voice_agent_error');
  assert.doesNotMatch(JSON.stringify(events), /test-giggy-credential/);
});
test('microphone PCM uploads to production STT and final transcript drives streamed speech', async () => {
  const events = [], calls = [], account = session(), ws = connection(events);
  let sttController, generation;
  const encoder = new TextEncoder();
  const frame = event => encoder.encode('data: ' + JSON.stringify(event) + '\n\n');
  const send = createCloudHandler({ providerFetch: async (url, options) => {
    calls.push(url);
    if (url === 'https://giggy.ai/v1/audio/transcriptions') {
      assert.equal(options.headers['xi-api-key'], 'test-giggy-credential');
      assert.deepEqual(JSON.parse(options.body), { mode: 'streaming', microphone: true });
      generation = '12345678-1234-4234-8234-123456789abc';
      return new Response(new ReadableStream({ start(controller) {
        sttController = controller;
        controller.enqueue(encoder.encode('event: generation_created\ndata: ' + JSON.stringify({ generation_uuid: generation }) + '\n\n'));
        controller.enqueue(frame({ input_token: 'a'.repeat(64), generation_uuid: generation, attempt: 1 }));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url === `https://giggy.ai/api/generations/${generation}/stt-input`) {
      const body = JSON.parse(options.body);
      assert.equal(body.input_token, 'a'.repeat(64));
      if (body.complete) {
        sttController.enqueue(frame({ text: 'Hello from the microphone.', complete: true }));
        sttController.enqueue(frame({ status: 'completed' })); sttController.close();
      }
      return new Response('{}');
    }
    if (url === 'https://api.deepseek.com/chat/completions') {
      assert.equal(JSON.parse(options.body).messages.at(-1).content, 'Hello from the microphone.');
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello back.' } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url === 'https://giggy.ai/v1/text-to-speech') return new Response(new Uint8Array(4), { headers: { 'Content-Type': 'audio/pcm' } });
    throw new Error('Unexpected endpoint');
  } });
  await send(ws, { type: 'voice_agent_audio_start', turn_id: 'mic-turn', voice }, account);
  await send(ws, { type: 'voice_agent_audio_chunk', turn_id: 'mic-turn', sequence: 0, sample_rate: 16000,
    chunk_base64: Buffer.alloc(16000).toString('base64'), voice }, account);
  const pipeline = account.capture.pipeline;
  await send(ws, { type: 'voice_agent_audio_end', turn_id: 'mic-turn', voice }, account);
  await pipeline;
  assert.equal(events.find(e => e.type === 'voice_agent_transcript_final').text, 'Hello from the microphone.');
  assert.equal(events.at(-1).type, 'voice_agent_turn_done');
  assert.ok(calls.includes('https://giggy.ai/v1/text-to-speech'));
  assert.equal(account.capture, null);
});

for (const fault of ['missing-admission', 'wrong-ready-id']) {
  test(`server-generated STT identity rejects ${fault}`, async () => {
    const events = [], account = session(); let uploads = 0;
    const admitted = '12345678-1234-4234-8234-123456789abc';
    const send = createCloudHandler({ providerFetch: async (url, options) => {
      if (url.endsWith('/audio/transcriptions')) {
        assert.deepEqual(JSON.parse(options.body), { mode: 'streaming', microphone: true });
        const admission = fault === 'missing-admission' ? '' : 'event: generation_created\ndata: ' + JSON.stringify({ generation_uuid: admitted }) + '\n\n';
        return new Response(admission + 'event: microphone_ready\ndata: ' + JSON.stringify({ input_token: 'a'.repeat(64), generation_uuid: '87654321-1234-4234-8234-123456789abc', attempt: 1 }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      }
      uploads++; throw new Error('Unexpected upload');
    } });
    await send(connection(events), { type: 'voice_agent_audio_start', turn_id: fault, voice }, account);
    await send(connection(events), { type: 'voice_agent_audio_chunk', turn_id: fault, sequence: 0, sample_rate: 16000, chunk_base64: Buffer.alloc(6400).toString('base64') }, account);
    await account.capture.pipeline;
    assert.equal(uploads, 0);
    assert.ok(events.some(e => e.type === 'voice_agent_error'));
  });
}
