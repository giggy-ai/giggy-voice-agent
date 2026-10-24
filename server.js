'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { createCloudHandler } = require('./cloud');
const { DEMO_VOICES } = require('./voices');
const TTL = 30 * 60 * 1000;
const TYPES = new Set(['voice_agent_session_start', 'voice_agent_session_end', 'voice_agent_interrupt',
  'voice_agent_audio_start', 'voice_agent_audio_chunk', 'voice_agent_audio_end', 'voice_agent_turn_probe',
  'voice_agent_user_text', 'voice_agent_synthesize_text']);

function createApp({ origin = process.env.APP_ORIGIN || 'http://localhost:3001', providerFetch = fetch } = {}) {
  const originUrl = new URL(origin);
  if (originUrl.origin !== origin) throw new Error('APP_ORIGIN must be an exact origin without a path.');
  if (originUrl.protocol !== 'https:' && !(originUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname)))
    throw new Error('Hosted deployments require an HTTPS APP_ORIGIN.');
  const secure = originUrl.protocol === 'https:';
  const accounts = new Map();
  const attempts = new Map();
  const wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const send = createCloudHandler({ providerFetch });
  function reply(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  }
  function cookie(req) { return /(?:^|;\s*)giggy_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; }
  function revoke(id) {
    const account = accounts.get(id);
    account?.socket?.close(1000, 'Credentials cleared');
    if (account) { account.giggyKey = ''; account.deepseekKey = ''; }
    accounts.delete(id);
  }
  function accountFor(req) {
    const id = cookie(req), account = accounts.get(id);
    if (account && account.expires > Date.now()) return account;
    if (account) revoke(id);
    return null;
  }
  async function readJson(req) {
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) throw new Error('Too large'); }
    return JSON.parse(body);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const pathname = new URL(req.url, origin).pathname;
    if (req.method !== 'GET' && req.headers.origin !== origin) return reply(res, 403, { error: 'Origin not allowed.' });
    try {
      if (pathname === '/api/session' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        if (attempts.size >= 1000 && !attempts.has(ip)) return reply(res, 429, { error: 'Try again shortly.' });
        const limit = attempts.get(ip) || { count: 0, until: Date.now() + 60000 };
        if (limit.until < Date.now()) { limit.count = 0; limit.until = Date.now() + 60000; }
        attempts.set(ip, limit);
        if (++limit.count > 10) return reply(res, 429, { error: 'Too many setup attempts. Try again in a minute.' });
        if (accounts.size >= 100) return reply(res, 503, { error: 'This demo is at capacity.' });
        const body = await readJson(req);
        const giggyKey = String(body.giggyKey || '').trim(), deepseekKey = String(body.deepseekKey || '').trim();
        if (![giggyKey, deepseekKey].every(key => key.length >= 10 && key.length <= 512 && !/\s/.test(key)))
          return reply(res, 400, { error: 'Enter your own Giggy and DeepSeek API keys.' });
        const checks = await Promise.all([
          providerFetch('https://api.giggy.ai/v1/voices', { headers: { 'xi-api-key': giggyKey }, signal: AbortSignal.timeout(10000) }),
          providerFetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${deepseekKey}` }, signal: AbortSignal.timeout(10000) }),
        ]);
        if (!checks.every(response => response.ok)) {
          await Promise.all(checks.map(response => response.body?.cancel()));
          return reply(res, 401, { error: 'Keys could not be validated. Sign up for Giggy and enter valid keys for both providers.' });
        }
        const data = await checks[0].json(); await checks[1].body?.cancel();
        if (!Array.isArray(data.voices) || !data.voices.length) return reply(res, 403, { error: 'Your Giggy account has no available voices.' });
        // Authentication still belongs to the caller's key. This demo uses a
        // fixed public voice allowlist, rather than the API's first catalog page.
        // Giggy independently enforces account access and billing on generation.
        const voices = DEMO_VOICES.map(voice => ({ ...voice }));
        revoke(cookie(req));
        const id = crypto.randomBytes(32).toString('hex');
        accounts.set(id, { giggyKey, deepseekKey, voices, voiceIds: new Set(voices.map(v => v.id)), expires: Date.now() + TTL });
        res.setHeader('Set-Cookie', `giggy_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${secure ? '; Secure' : ''}`);
        return reply(res, 200, { voices, expiresIn: 1800 });
      }
      if (pathname === '/api/session' && req.method === 'DELETE') {
        revoke(cookie(req));
        res.setHeader('Set-Cookie', `giggy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
        return reply(res, 200, { ok: true });
      }
      if (pathname === '/api/session' && req.method === 'GET') {
        const account = accountFor(req);
        return reply(res, account ? 200 : 401, account ? { voices: account.voices } : { error: 'Connect your own API keys first.' });
      }
      if (pathname.startsWith('/api/')) return reply(res, 404, { error: 'Not found.' });
      if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed.' });
      const files = { '/': ['index.html', 'text/html'], '/app/voice-agents/demo': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'text/javascript'], '/microphone-worklet.js': ['microphone-worklet.js', 'text/javascript'],
        '/style.css': ['style.css', 'text/css'], '/giggy-avatar.webp': ['giggy-avatar.webp', 'image/webp'],
        '/giggy-logo.svg': ['giggy-logo.svg', 'image/svg+xml'] };
      const file = files[pathname];
      if (!file) return reply(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
      fs.createReadStream(path.join(__dirname, 'public', file[0])).pipe(res);
    } catch { reply(res, 400, { error: 'Request could not be completed. Check your keys and try again.' }); }
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin), account = accountFor(req);
    if (url.pathname !== '/api/voice-agent/realtime' || url.search || req.headers.origin !== origin || !account || account.socket)
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      account.socket = ws;
      const session = { ws, sessionId: crypto.randomUUID(), credentials: account, capture: null, controllers: new Set(), turn: null };
      let messages = 0, bytes = 0, windowStart = Date.now();
      const deadline = setTimeout(() => ws.close(1000, 'Session ended'), Math.min(15 * 60 * 1000, account.expires - Date.now()));
      ws.on('message', raw => {
        if (Date.now() - windowStart >= 60000) { messages = 0; bytes = 0; windowStart = Date.now(); }
        if (++messages > 1800 || (bytes += raw.length) > 16 * 1024 * 1024) return ws.close(1008, 'Rate limit reached');
        let message;
        try { message = JSON.parse(String(raw)); } catch { return ws.close(1008, 'Invalid message'); }
        if (!message || typeof message !== 'object' || Array.isArray(message) || !TYPES.has(message.type)
          || Object.keys(message).some(key => key.startsWith('_'))) return ws.close(1008, 'Invalid message');
        void send(ws, message, session);
      });
      ws.on('close', () => {
        clearTimeout(deadline); account.socket = null;
        for (const controller of session.controllers) controller.abort();
        session.capture?.notify?.(); session.capture = null;
      });
      ws.on('error', () => {});
    });
  });
  const cleanup = setInterval(() => {
    for (const [id, account] of accounts) if (account.expires <= Date.now()) revoke(id);
    for (const [ip, limit] of attempts) if (limit.until < Date.now()) attempts.delete(ip);
  }, 30000).unref();
  server.on('close', () => { clearInterval(cleanup); for (const id of accounts.keys()) revoke(id); wss.close(); });
  return server;
}
if (require.main === module) {
  const port = Number(process.env.PORT || 3001);
  createApp().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Giggy voice agent listening on port ${port}`));
}
module.exports = { createApp };

