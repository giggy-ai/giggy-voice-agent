'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createApp } = require('../server');
const VOICE = '85e13e59-c1e6-55d5-bee0-7e9f9deb0802';
async function fixture(t, valid = true) {
  const calls = [];
  const server = createApp({ origin: 'http://localhost:3001', providerFetch: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('/voices') ? { voices: [{ voice_id: VOICE, name: 'Katherine' }] } : {}), { status: valid ? 200 : 401 });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}
async function connect(url) {
  return fetch(`${url}/api/session`, { method: 'POST', headers: { Origin: 'http://localhost:3001', 'Content-Type': 'application/json' },
    body: JSON.stringify({ giggyKey: 'test-giggy-credential', deepseekKey: 'test-deepseek-credential' }) });
}
test('keys are mandatory; arbitrary origins and private files are rejected', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(`${url}/api/session`)).status, 401);
  assert.equal((await fetch(`${url}/.env`)).status, 404);
  assert.equal((await fetch(`${url}/server.js`)).status, 404);
  assert.equal((await fetch(`${url}/api/session`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
});
test('invalid Giggy account or provider key never grants a session', async t => {
  const { url } = await fixture(t, false);
  const response = await connect(url);
  assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
  assert.doesNotMatch(await response.text(), /test-giggy-credential|test-deepseek-credential/);
});
test('valid account gets a cookie; credentials never appear in responses and logout revokes it', async t => {
  const { url, calls } = await fixture(t);
  const response = await connect(url), cookie = response.headers.get('set-cookie');
  assert.equal(response.status, 200); assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(await response.text(), /test-giggy-credential|test-deepseek-credential/);
  assert.equal(calls[0].url, 'https://api.giggy.ai/v1/voices');
  assert.equal(calls[0].options.headers['xi-api-key'], 'test-giggy-credential');
  const headers = { Cookie: cookie.split(';')[0], Origin: 'http://localhost:3001' };
  assert.equal((await fetch(`${url}/api/session`, { headers })).status, 200);
  assert.equal((await fetch(`${url}/api/session`, { method: 'DELETE', headers })).status, 200);
  assert.equal((await fetch(`${url}/api/session`, { headers })).status, 401);
});
test('websocket requires a validated account and cannot select a runtime or bypass with demo=1', async t => {
  const { url } = await fixture(t);
  const response = await connect(url), cookie = response.headers.get('set-cookie').split(';')[0];
  async function rejected(suffix, headers) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url.replace('http:', 'ws:') + suffix, { headers });
      ws.on('open', () => { ws.close(); reject(new Error('Unauthorized socket opened')); });
      ws.on('error', resolve);
    });
  }
  await rejected('/api/voice-agent/realtime', { Origin: 'http://localhost:3001' });
  await rejected('/api/voice-agent/realtime?demo=1', { Origin: 'http://localhost:3001', Cookie: cookie });
  await rejected('/api/voice-agent/realtime?runtime=local', { Origin: 'http://localhost:3001', Cookie: cookie });
  await rejected('/api/voice-agent/realtime', { Origin: 'https://evil.example', Cookie: cookie });
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/api/voice-agent/realtime', { headers: { Origin: 'http://localhost:3001', Cookie: cookie } });
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'voice_agent_session_start', voice: { voice_source: 'voice_library', voice_library_uuid: VOICE } })));
    ws.on('message', raw => { const event = JSON.parse(raw); if (event.type === 'voice_agent_session_ready') { assert.equal(event.runtime, 'cloud'); ws.close(); } });
    ws.on('close', resolve);
  });
});
test('non-HTTPS hosted origin is refused', () => assert.throws(() => createApp({ origin: 'http://public.example' }), /HTTPS/));
