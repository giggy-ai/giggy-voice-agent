# Giggy Voice Agent

Success means the voice picker loads, Start triggers the intro, and a spoken or typed turn produces an audible reply. Stop cuts playback; Disconnect returns to setup. Automated tests validate protocols, not every physical microphone device or hosted deployment. For native Pipecat reuse [existing PR #2](https://github.com/giggy-ai/pipecat-giggy/pull/2); this app uses its own Node bridge. For API onboarding use the [Node SDK](https://github.com/giggy-ai/giggy-js) or [Python SDK](https://github.com/giggy-ai/giggy-python).

A standalone, cloud-only version of the Giggy voice agent demo. It includes the Giggy avatar, account voice picker, microphone conversation, streamed speech, interruption, and a live chat log.

**Every user must have a Giggy account and bring their own Giggy and DeepSeek API keys.** No owner keys, private backend configuration, model files, GPU workers, or local/cloud selector are included.

[Create a Giggy account](https://giggy.ai/?login=1&utm_source=github&utm_medium=referral&utm_campaign=developer_onboarding&utm_content=giggy-voice-agent_readme) · [Speech API guide](https://giggy.ai/docs/speech-api?utm_source=github&utm_medium=referral&utm_campaign=developer_onboarding&utm_content=giggy-voice-agent_docs) · [Browser voice sandbox](https://github.com/giggy-ai/giggy-voice-agent)

## Run

Requires Node.js 22 or newer.

```sh
npm ci
npm start
```

Open http://localhost:3001 (or `/app/voice-agents/demo`). This runs the web interface and credential broker on your machine; all speech and language models run in the cloud. No local inference runtime is available.

1. [Sign up for Giggy](https://giggy.ai/?login=1).
2. Create your own API key in [Giggy Speech API](https://giggy.ai/app/speech-api).
3. Create your own [DeepSeek API key](https://platform.deepseek.com/api_keys).
4. Enter both keys in the app. The server validates them against the providers and loads the same 12 public voices as Giggy's voice-agent demo, with Angela Fowler selected by default.
5. Choose a voice and start. Allow microphone access; the agent speaks one of the main demo's six opening greetings first, then you can speak naturally or type into the chat. The greeting uses the selected voice and can be interrupted.

Usage is charged to the accounts owning the keys. Available account credits and production model availability affect whether generation succeeds.

## Production connections

The cloud bridge is derived from Giggy's existing demo cloud implementation. It exclusively calls:

- `https://giggy.ai/v1/voices` — account validation and voice discovery.
- `https://giggy.ai/v1/audio/transcriptions` — streaming microphone transcription.
- `https://giggy.ai/api/generations/{id}/stt-input` — PCM microphone input upload.
- `https://giggy.ai/v1/text-to-speech` — streaming 24 kHz PCM speech.
- `https://api.deepseek.com/models` and `/chat/completions` — key validation and streamed responses.

Giggy origin is fixed in the code. There is no development API URL override, anonymous demo bypass, worker relay, local model path, or runtime selector.

## Keys and sessions

Keys travel from the setup form to this app's server, then to their respective providers. Only run this app on a server you trust. Hosted deployments require HTTPS.

- Credentials stay in process memory for up to 30 minutes and disappear on disconnect, expiry, or server restart. JavaScript memory is not guaranteed to be immediately zeroed by the runtime.
- Keys are never returned in API responses, put into WebSocket URLs, stored in browser storage, or written to application logs or files.
- The browser receives an opaque `HttpOnly`, `SameSite=Strict` cookie; HTTPS deployments also mark it `Secure`.
- Each user's credentials are isolated. The demo offers a fixed allowlist of public library voices; Giggy enforces account access and billing for generation. A validated Giggy account key is required to open a voice session; this is API-key authentication, rather than a separate Giggy website login.
- WebSocket connections require the configured origin and a validated cookie. Each account can open one conversation at a time. Sessions last at most 15 minutes.
- Setup requests and voice messages have limits. Account sessions and setup-rate records have bounded capacity. This is a demo, not a complete public abuse-prevention platform.

Keep keys out of reverse-proxy request-body logging, monitoring captures, and crash dumps. Never commit `.env`, credentials, logs, or private exports.

## Host over HTTPS

Copy `.env.example` to `.env` and set `APP_ORIGIN` to your exact HTTPS domain, `HOST=0.0.0.0`, and `PORT` to your hosting port. Run one Node process behind an HTTPS reverse proxy that supports WebSocket upgrades. Sessions live in memory, so multiple instances require sticky routing. Server restarts require users to reconnect their keys.

Microphone capture requires HTTPS or loopback access. The UI captures and resamples audio through AudioWorklet using 40 ms packets, with a ScriptProcessor compatibility fallback. A 160 ms pre-roll preserves speech beginnings, and sustained speech onset reduces accidental interruptions. Speech detection uses an energy threshold and may need tuning for noisy environments.

## Response timing

The default **Fast pauses** mode ends a microphone turn after 450 ms of silence. **Longer pauses** uses 700 ms for speakers who pause mid-sentence. Shorter pauses can split a thought; use the longer option if that happens.

The bridge uploads the first 200 ms of audio promptly, then keeps the existing half-second steady-state upload batches. Final transcription starts DeepSeek and prepares the first Giggy speech request while transcription completion is confirmed. Assistant text and audio are released only after successful transcription completion. Failed or interrupted input aborts prepared output. Preparing speech can incur a normal provider charge even if transcription subsequently fails.

Long responses can begin speaking at a natural opening clause, while later speech keeps full sentences. The bridge does not send speculative partial transcriptions to DeepSeek. Timing events include transcription readiness, first upload, final text, LLM first token, TTS startup, and first playable audio.

These optimizations are confined to this demo's client and bridge. They use the existing production API contract and require no Giggy service code, infrastructure, or deployment changes. Latency depends on network conditions and provider capacity.

## Verify before publishing

```sh
npm run check
npm test
npm run audit:secrets
npm audit --omit=dev
```

Automated tests use fake credentials and mocked provider responses; they do not spend account credits. They cover audio capture/resampling, ordered speech chunks, account isolation, and withholding output until transcription succeeds, including failure and interruption cases. Live cloud calls have also been measured with controlled generated speech as microphone input. A physical microphone conversation still needs testing with your own keys and device before announcing device-specific latency or compatibility.

Publish only this directory as a new repository. Do not copy your private `giggy2` checkout, its `.env`, Git history, logs, or archives into it. The scanner checks common credential patterns and forbidden file types; it cannot guarantee detection of every possible secret.



Streaming microphone admission omits `client_request_id`. The server returns the session UUID in `generation_created`; the bridge verifies it against `microphone_ready` before uploading ordered PCM frames. Session IDs do not resume disconnected microphone sessions.
