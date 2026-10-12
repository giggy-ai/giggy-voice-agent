'use strict';
const WebSocket = require('ws');
const crypto = require('node:crypto');
const productionOrigin = 'https://giggy.ai';
const sttOrigin = productionOrigin;
const STANDARD_GREETINGS = [
  'Hey, I am here and ready to listen. What is on your mind today?',
  'Hey, I am ready to help you think things through. Where would you like to begin?',
  'Hi, take your time. What would feel most useful for us to explore right now?',
  'Hello, I am here with you. Tell me what has been taking up your thoughts lately.',
  'Hello, we have time to think this through. What feels most important to talk about first?',
  'Hi, I am ready when you are. What should we start with today?',
];
function speechBoundary(text, firstPhrase) {
  // A period must be followed by whitespace (or be a completed sentence at
  // stream end) so token boundaries do not split decimal numbers or words.
  const sentence = /[!?](?:["']?)(?:\s|$)|\.(?:["']?)\s/.exec(text);
  if (sentence) return sentence.index + sentence[0].length;
  if (!firstPhrase) return 0;
  const clause = /[,;:]\s/.exec(text);
  if (clause && text.slice(0, clause.index).trim().split(/\s+/).length >= 6)
    return clause.index + clause[0].length;
  // Bound the wait for punctuation without splitting a word. Only the opening
  // phrase uses this fallback, limiting extra speech requests to one per turn.
  if (text.length >= 140) {
    const space = text.indexOf(' ', 100);
    if (space !== -1) return space + 1;
  }
  return 0;
}
async function waitForCommit(commitment, signal) {
  if (signal.aborted) throw signal.reason;
  let onAbort;
  try {
    await Promise.race([commitment, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
    if (signal.aborted) throw signal.reason;
  } finally { signal.removeEventListener('abort', onAbort); }
}
function createCloudHandler({ providerFetch = fetch } = {}) {
  const send = async (ws, payload, session = null) => {
    if (!session) {
      if (ws?.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 8 * 1024 * 1024) return ws.close(1013, 'Voice output is busy');
        ws.send(JSON.stringify(payload));
      }
      return;
    }
    let controller = null;
    let ownedTurn = null;
    try {
      const type = String(payload.type || '');
      if (type === 'voice_agent_session_start') {
        session.voice = payload.voice;
        session.audioSequence = 0;
        session.instructions = String(payload.agent_instructions || '').slice(0, 6000);
        await send(ws, { type: 'voice_agent_session_ready', session_id: session.sessionId, worker_available: true, runtime: 'cloud' });
        if (session.introStarted) return;
        session.introStarted = true;
        controller = new AbortController();
        session.controllers.add(controller);
        const introId = `greeting-${crypto.randomUUID()}`;
        ownedTurn = { id: introId, controller }; session.turn = ownedTurn;
        const text = STANDARD_GREETINGS[crypto.randomInt(STANDARD_GREETINGS.length)];
        await send(ws, { type: 'voice_agent_intro', turn_id: introId, text });
        await send(ws, { type: 'voice_agent_synthesize_text', text, voice: session.voice, turn_id: introId,
          _stream: true, _controller: controller, _startedAt: performance.now(), _sentenceIndex: 0 }, session);
        if (!controller.signal.aborted && session.turn === ownedTurn)
          await send(ws, { type: 'voice_agent_turn_done', turn_id: introId, text });
        return;
      }
      if (type === 'voice_agent_interrupt' || type === 'voice_agent_session_end') {
        for (const pending of session.controllers) pending.abort();
        session.capture?.notify?.();
        if (!session.capture || session.capture.id === String(payload.turn_id || '') || type === 'voice_agent_session_end') session.capture = null;
        session.turn = null;
        return send(ws, { type: 'voice_agent_turn_interrupted', turn_id: payload.turn_id });
      }
      if (type === 'voice_agent_audio_start') {
        session.capture = { id: String(payload.turn_id || ''), chunks: [], bytes: 0, queuedBytes: 0, options: payload, sequence: 0, speechBytes: 0, promoted: true, lastSpeechAt: Date.now() };
        return;
      }
      if (type === 'voice_agent_turn_probe' || type === 'voice_agent_audio_chunk') {
        if (type === 'voice_agent_audio_chunk' && payload.chunk_base64 !== undefined) {
          if (!session.capture || session.capture.ended && session.capture.id !== String(payload.turn_id || '')) session.capture = { id: String(payload.turn_id || ''), chunks: [], bytes: 0, options: payload, sequence: 0, speechBytes: 0, promoted: false, lastSpeechAt: Date.now() };
          const target = session.capture;
          if (target.id !== String(payload.turn_id || '')) return;
          if (target.ended) return;
          if (payload.sequence !== target.sequence || payload.sample_rate !== 16000) throw new Error('Invalid cloud microphone frame order or sample rate.');
          const encoded = String(payload.chunk_base64 || '');
          const pcm = Buffer.from(encoded, 'base64');
          if (pcm.toString('base64') !== encoded || !pcm.length || pcm.length % 2 || pcm.length > 64000 || target.bytes + pcm.length > 960000) throw new Error('Cloud microphone input must be PCM16 mono at 16 kHz, up to 30 seconds.');
          target.sequence++; target.chunks.push(pcm); target.bytes += pcm.length;
          target.queuedBytes = (target.queuedBytes || 0) + pcm.length;
          let squares = 0;
          for (let offset = 0; offset < pcm.length; offset += 2) squares += (pcm.readInt16LE(offset) / 32768) ** 2;
          const speech = Math.sqrt(squares / (pcm.length / 2)) >= 0.007;
          if (speech) { target.speechBytes += pcm.length; target.lastSpeechAt = Date.now(); }
          else if (!target.promoted) target.speechBytes = 0;
          if (!target.promoted && target.speechBytes >= 3200) {
            target.promoted = true;
            await send(ws, { type: 'voice_agent_audio_start', turn_id: target.id, transport: 'current' });
          }
          if (!target.promoted && target.bytes > 9600) {
            const retained = Buffer.concat(target.chunks).subarray(-9600);
            target.chunks = [retained]; target.bytes = retained.length; target.queuedBytes = retained.length;
          }
          if (target.promoted && !target.pipeline) {
            target.pipeline = send(ws, { ...target.options, type: 'voice_agent_audio_end', turn_id: target.id, _capture: target }, session);
          }
          target.notify?.();
        }
        const capture = session.capture;
        if (capture?.promoted && capture.id === String(payload.turn_id || '') && (payload.turn_probe || type === 'voice_agent_turn_probe')) {
          const silence = Date.now() - capture.lastSpeechAt;
          await send(ws, { type: 'voice_agent_turn_probe_result', turn_id: payload.turn_id, complete: silence >= 650,
            vad_speech_detected: silence < 650, trailing_silence_ms: silence, smart_turn_probability: 0 });
        }
        return;
      }
      if (type === 'voice_agent_audio_end' && !payload._capture) {
        const capture = session.capture;
        if (!capture || capture.id !== String(payload.turn_id || '') || !capture.pipeline) throw new Error('No streaming microphone turn is active.');
        capture.ended = true; capture.endedAt = performance.now();
        capture.options.thread_history = payload.thread_history || capture.options.thread_history;
        capture.notify?.();
        return;
      }
      if (!['voice_agent_synthesize_text', 'voice_agent_user_text', 'voice_agent_audio_end'].includes(type)) return;
      const synthesisOnly = type === 'voice_agent_synthesize_text';
      const voice = payload.voice || session.voice;
      const voiceId = String(voice?.voice_library_uuid || '');
      if (!session.credentials.voiceIds.has(voiceId)) throw new Error('Choose a voice available to your Giggy account.');
      if (voice?.voice_source !== 'voice_library' || !/^[0-9a-f-]{36}$/i.test(voiceId)) throw new Error('Choose a library voice.');
      controller = payload._controller || new AbortController();
      if (payload._capture) payload._capture.controller = controller;
      const timeout = AbortSignal.timeout(90000);
      const signal = AbortSignal.any([controller.signal, timeout]);
      session.controllers.add(controller);
      const startedAt = performance.now();
      const metrics = payload._metrics || { stt_ms: 0, llm_first_token_ms: null, first_audio_ms: null,
        stt_ready_ms: null, stt_first_upload_ms: null, stt_final_text_ms: null,
        tts_started_ms: null, tts_first_byte_ms: null };
      const turnId = String(payload.turn_id || '');
      if (!synthesisOnly) {
        for (const pending of session.controllers) if (pending !== controller) pending.abort();
        ownedTurn = { id: turnId, controller }; session.turn = ownedTurn;
      }
      let text = String(payload.text || '').trim().slice(0, 1200);
      const stages = [];
      if (type === 'voice_agent_audio_end') {
        const capture = payload._capture;
        if (!capture || capture.id !== turnId || capture.bytes < 640) throw new Error('No microphone audio was captured.');
        if (!payload.thread_history) payload.thread_history = capture.options.thread_history;
        stages.push({ kind: 'stt', url: `${sttOrigin}/v1/audio/transcriptions`, body: { mode: 'streaming', microphone: true, client_request_id: crypto.randomUUID() }, capture });
      }
      stages.push({ kind: synthesisOnly ? 'tts' : 'llm' });
      const llmRequest = {
        model: 'deepseek-flash', thinking: { type: 'disabled' }, stream: true, max_tokens: 160,
        messages: [{ role: 'system', content: `You are Giggy, a friendly voice assistant. Answer in one or two short, natural sentences. Start with a brief useful sentence. No markdown or stage directions. ${session.instructions || ''}` },
          ...(Array.isArray(payload.thread_history) ? payload.thread_history : []).slice(-32).filter(m => ['user', 'assistant'].includes(m.role)).map(m => ({ role: m.role, content: String(m.content || '').slice(0, 1200) })), { role: 'user', content: text }],
      };
      let llmResponse = null, llmStartedAt = null, llmTask = null;
      let commitTranscript;
      let transcriptCommitted = type !== 'voice_agent_audio_end';
      const transcriptCommitment = transcriptCommitted ? Promise.resolve() : new Promise(resolve => { commitTranscript = resolve; });
      const waitingText = [];
      let answer = '', sentenceBuffer = '', sentenceIndex = 0;
      const audio = []; let audioBytes = 0, audioCarry = Buffer.alloc(0);
      let speechChain = Promise.resolve(), speechError = null;
      async function processStage(stage) {
        if (signal.aborted) throw signal.reason;
        if (stage.kind !== 'stt' && !text) throw new Error('The turn did not contain speech.');
        const stageStartedAt = stage.kind === 'llm' && llmStartedAt !== null ? llmStartedAt : performance.now();
        if (stage.kind === 'llm') llmRequest.messages.at(-1).content = text;
        if (stage.kind === 'tts' && metrics.tts_started_ms === null) metrics.tts_started_ms = performance.now() - (payload._startedAt ?? startedAt);
        const response = await (stage.kind === 'llm' && llmResponse ? llmResponse : providerFetch(stage.url || (stage.kind === 'tts' ? `${productionOrigin}/v1/text-to-speech` : 'https://api.deepseek.com/chat/completions'), {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', ...(stage.kind === 'llm' ? { Authorization: `Bearer ${session.credentials.deepseekKey}` } : { 'xi-api-key': stage.kind === 'stt' ? session.credentials.giggyKey : session.credentials.giggyKey }) },
          body: JSON.stringify(stage.body || (stage.kind === 'tts' ? { text, voice_id: voiceId, mode: 'streaming', output_format: 'pcm_24000', voice_settings: { speed: 1 } } : llmRequest)),
        }));
        if (!response.ok) { await response.body.cancel(); throw new Error(`${stage.kind.toUpperCase()} provider returned HTTP ${response.status}.`); }
        if (stage.kind === 'tts') {
          if (!/audio\/pcm|application\/octet-stream/i.test(response.headers.get('content-type') || '')) { await response.body.cancel(); throw new Error('Production TTS did not return streaming PCM.'); }
          // Prepare the normal speech request during STT confirmation, but do
          // not consume or release any audio until the input is committed.
          if (payload._stream && payload._commit) await waitForCommit(payload._commit, signal);
          for await (const raw of response.body) {
            const bytes = Buffer.concat([audioCarry, Buffer.from(raw)]);
            audioCarry = bytes.subarray(bytes.length - bytes.length % 2);
            const pcm = bytes.subarray(0, bytes.length - bytes.length % 2);
            if (!pcm.length) continue;
            audioBytes += pcm.length;
            if (audioBytes > 8 * 1024 * 1024) { controller.abort(); throw new Error('Cloud speech output exceeds the demo limit.'); }
            if (payload._stream) {
              if (metrics.first_audio_ms === null) {
                metrics.first_audio_ms = performance.now() - payload._startedAt;
                metrics.tts_first_byte_ms = metrics.first_audio_ms - metrics.tts_started_ms;
              }
              await send(ws, { type: 'voice_agent_audio_chunk', turn_id: turnId, sentence_index: payload._sentenceIndex,
                sequence: session.audioSequence++, sentence_text: text, voice_library_uuid: voiceId,
                progressive_candidate: true, progressive_label: 'stream', audio_format: 'audio/pcm;rate=24000;channels=1;bits=16', chunk_base64: pcm.toString('base64') });
            } else audio.push(pcm);
          }
          if (!audioBytes || audioCarry.length) throw new Error('Production TTS returned incomplete PCM.');
          if (!payload._stream) await send(ws, { type: 'voice_agent_synthesized_audio', request_id: payload.request_id, voice_library_uuid: voiceId,
            audio_base64: Buffer.concat(audio).toString('base64'), audio_format: 'audio/pcm;rate=24000;channels=1;bits=16', text });
          return;
        }
        if (!(response.headers.get('content-type') || '').includes('text/event-stream')) { await response.body.cancel(); throw new Error('Expected streaming provider events.'); }
        const decoder = new TextDecoder(); let buffer = '', complete = false;
        providerEvents: for await (const raw of response.body) {
          if (signal.aborted) throw signal.reason;
          buffer += decoder.decode(raw, { stream: true });
          if (buffer.length > 1024 * 1024) throw new Error('Cloud provider event exceeds the demo limit.');
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (data === '[DONE]') { complete = stage.kind === 'llm'; break providerEvents; }
            const event = JSON.parse(data);
            if (event.error || event.status === 'failed' || event.generation?.status === 'failed') throw new Error(`${stage.kind.toUpperCase()} generation failed.`);
            if (stage.kind === 'stt') {
              if (event.input_token) {
                const capture = stage.capture;
                if (capture.sender || !/^[a-f0-9]{64}$/.test(event.input_token)
                    || event.generation_uuid !== stage.body.client_request_id || !Number.isInteger(event.attempt))
                  throw new Error('Invalid streaming STT readiness.');
                metrics.stt_ready_ms = performance.now() - startedAt;
                capture.sender = (async () => {
                  let sequence = 0;
                  while (!signal.aborted) {
                    // Send the first 200 ms promptly, then keep half-second
                    // steady-state uploads rather than one HTTP call per frame.
                    const minimumBytes = sequence === 0 ? 6400 : 16000;
                    while (capture.queuedBytes < minimumBytes && !capture.ended && !signal.aborted) {
                      await new Promise(resolve => {
                        capture.notify = resolve;
                        signal.addEventListener('abort', resolve, { once: true });
                      });
                      signal.removeEventListener('abort', capture.notify); capture.notify = null;
                    }
                    if (signal.aborted) throw signal.reason;
                    const pending = Buffer.concat(capture.chunks); capture.chunks = []; capture.queuedBytes = 0;
                    let offset = 0;
                    do {
                      const pcm = pending.subarray(offset, offset + 32000); offset += pcm.length;
                      const complete = capture.ended === true && offset === pending.length && !capture.chunks.length;
                      if (!pcm.length && !complete) break;
                      if (metrics.stt_first_upload_ms === null) metrics.stt_first_upload_ms = performance.now() - startedAt;
                      const input = await providerFetch(`${sttOrigin}/api/generations/${event.generation_uuid}/stt-input`, {
                        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ input_token: event.input_token, sequence: sequence++, pcm_base64: pcm.toString('base64'), complete }),
                      });
                      await input.arrayBuffer();
                      if (!input.ok) throw new Error(`STT input returned HTTP ${input.status}.`);
                      if (complete) return;
                    } while (offset < pending.length);
                  }
                })();
                capture.sender.catch(error => controller.abort(error));
              }
              if (typeof event.text === 'string') text = event.text.trim();
              if (typeof event.text === 'string' && event.complete !== true)
                await send(ws, { type: 'voice_agent_transcript_partial', turn_id: turnId, text });
              if (event.complete === true && text && !llmResponse) {
                // Only the final transcript can start LLM work. Speech still
                // waits for successful durable STT completion below.
                llmRequest.messages.at(-1).content = text;
                metrics.stt_final_text_ms = performance.now() - startedAt;
                llmStartedAt = performance.now();
                llmResponse = providerFetch('https://api.deepseek.com/chat/completions', { method: 'POST', signal,
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.credentials.deepseekKey}` }, body: JSON.stringify(llmRequest) });
                llmResponse.catch(() => {});
                llmTask = processStage({ kind: 'llm' });
                llmTask.catch(error => controller.abort(error));
              }
              if (event.status === 'completed' || event.generation?.status === 'completed') {
                complete = true;
                break providerEvents;
              }
            } else {
              const delta = String(event.choices?.[0]?.delta?.content || '');
              if (!delta) continue;
              if (metrics.llm_first_token_ms === null) metrics.llm_first_token_ms = performance.now() - stageStartedAt;
              answer += delta; sentenceBuffer += delta;
              if (answer.length > 1600) { controller.abort(); throw new Error('Cloud answer exceeds the demo limit.'); }
              if (transcriptCommitted) await send(ws, { type: 'voice_agent_assistant_text_delta', turn_id: turnId, delta });
              else waitingText.push(delta);
              // Start at a natural first clause for a long opening sentence;
              // later phrases keep full sentences to preserve speech prosody.
              let boundary;
              while ((boundary = speechBoundary(sentenceBuffer, sentenceIndex === 0))) {
                const sentence = sentenceBuffer.slice(0, boundary).trim(); sentenceBuffer = sentenceBuffer.slice(boundary);
                const index = sentenceIndex++;
                speechChain = speechChain.then(() => {
                  if (controller.signal.aborted) throw controller.signal.reason;
                  return send(ws, { type: 'voice_agent_synthesize_text', text: sentence, voice, turn_id: turnId,
                    _stream: true, _controller: controller, _metrics: metrics, _startedAt: startedAt, _sentenceIndex: index, _commit: transcriptCommitment }, session);
                }).catch(error => { speechError = error; controller.abort(error); });
              }
            }
          }
        }
        if (!complete) throw new Error(`${stage.kind.toUpperCase()} stream ended before completion.`);
        if (stage.kind === 'llm' && sentenceBuffer.trim()) {
          const tail = sentenceBuffer.trim(); const index = sentenceIndex++;
          sentenceBuffer = '';
          speechChain = speechChain.then(() => send(ws, { type: 'voice_agent_synthesize_text', text: tail, voice, turn_id: turnId,
            _stream: true, _controller: controller, _metrics: metrics, _startedAt: startedAt, _sentenceIndex: index, _commit: transcriptCommitment }, session))
            .catch(error => { speechError = error; controller.abort(error); });
        }
        if (stage.kind === 'stt') {
          if (!stage.capture.sender || !stage.capture.ended) throw new Error('STT completed before the microphone input ended.');
          await stage.capture.sender;
          metrics.stt_ms = performance.now() - stageStartedAt;
          if (session.capture === stage.capture) session.capture = null;
          await send(ws, { type: 'voice_agent_transcript_final', turn_id: turnId, text });
          for (const delta of waitingText) await send(ws, { type: 'voice_agent_assistant_text_delta', turn_id: turnId, delta });
          waitingText.length = 0;
          transcriptCommitted = true;
          commitTranscript();
        }
      }
      for (const stage of stages) {
        if (stage.kind === 'llm' && llmTask) await llmTask;
        else await processStage(stage);
      }
      if (!synthesisOnly) {
        if (!answer.trim()) throw new Error('DeepSeek returned an empty answer.');
        await speechChain;
        if (speechError) throw speechError;
        if (session.turn !== ownedTurn || signal.aborted) return;
        const audioEnd = payload._capture?.endedAt;
        await send(ws, { type: 'voice_agent_metrics', turn_id: turnId, metrics: { ...metrics,
          ...(audioEnd ? { first_audio_after_end_ms: metrics.first_audio_ms - (audioEnd - startedAt) } : {}), total_ms: performance.now() - startedAt } });
        await send(ws, { type: 'voice_agent_turn_done', turn_id: turnId, text: answer });
      }
    } catch (error) {
      if (payload._stream) throw error;
      if (error.name === 'AbortError' && controller?.signal.reason?.name !== 'AbortError' && controller?.signal.reason instanceof Error)
        error = controller.signal.reason;
      if (error.name !== 'AbortError') await send(ws, { type: payload.type === 'voice_agent_synthesize_text' ? 'voice_agent_synthesized_audio_error' : 'voice_agent_error',
        turn_id: payload.turn_id, request_id: payload.request_id, intro: payload.type === 'voice_agent_session_start', message: /^(STT|TTS|LLM) provider returned HTTP [0-9]+\.$/.test(error.message) ? error.message : 'Cloud voice request failed. Check your account credits and try again.' });
      controller?.abort(error);
      payload._capture?.notify?.();
      if (session.capture === payload._capture) session.capture = null;
    } finally {
      if (controller && !payload._controller) session.controllers.delete(controller);
      if (ownedTurn && session.turn === ownedTurn) session.turn = null;
    }
  };


  return send;
}
module.exports = { createCloudHandler };



