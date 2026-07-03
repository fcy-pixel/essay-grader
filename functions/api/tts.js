/**
 * Cloudflare Pages Function – Qwen TTS Proxy (streaming)
 * Route: POST /api/tts
 * Body:  { "text": "...", "voice": "Cherry"?, "language_type": "Chinese"|"English"|"Auto"? }
 * Returns: raw 16-bit mono PCM stream @ 24kHz (application/octet-stream),
 *          streamed to the client as the model generates it.
 *
 * Primary:  qwen3-tts-instruct-flash-realtime (WebSocket realtime API)
 * Fallback: qwen3-tts-flash (HTTP, non-streaming; PCM extracted from its WAV)
 * Uses the same QWEN_API_KEY secret as /api/qwen.
 */

const REALTIME_MODEL = 'qwen3-tts-instruct-flash-realtime-2026-01-22';
const REALTIME_URL = `https://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=${REALTIME_MODEL}`;
const HTTP_TTS_ENDPOINT =
  'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const SAMPLE_RATE = 24000;
const LANGUAGE_TYPES = new Set([
  'Auto', 'Chinese', 'English', 'German', 'Italian', 'Portuguese',
  'Spanish', 'Japanese', 'Korean', 'French', 'Russian',
]);

export async function onRequestPost({ request, env }) {
  const apiKey = env.QWEN_API_KEY;

  if (!apiKey) {
    return jsonResponse(
      { error: { message: 'QWEN_API_KEY secret is not configured on the server.' } },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: { message: 'Invalid JSON request body.' } }, 400);
  }

  const text = (body.text || '').toString().trim().slice(0, 2000);
  if (!text) {
    return jsonResponse({ error: { message: 'Missing "text" in request body.' } }, 400);
  }
  const voice = (body.voice || 'Cherry').toString();
  const languageType = LANGUAGE_TYPES.has(body.language_type) ? body.language_type : 'Auto';

  const errors = [];

  // 1) Realtime WebSocket model — streams PCM as it is generated
  try {
    const readable = await realtimeTtsStream(apiKey, text, voice, languageType);
    return pcmResponse(readable);
  } catch (err) {
    errors.push(`${REALTIME_MODEL}: ${err.message}`);
  }

  // 2) Fallback: qwen3-tts-flash over HTTP (whole file, then PCM extracted)
  try {
    const upstream = await fetch(HTTP_TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'qwen3-tts-flash',
        input: { text, voice, language_type: languageType },
      }),
    });
    const data = await upstream.json();
    const audioUrl = data?.output?.audio?.url;
    if (upstream.ok && audioUrl) {
      const audioResp = await fetch(audioUrl.replace(/^http:\/\//, 'https://'));
      if (audioResp.ok) {
        return pcmResponse(extractPcmFromWav(await audioResp.arrayBuffer()));
      }
      errors.push(`qwen3-tts-flash: audio download failed (${audioResp.status})`);
    } else {
      errors.push(
        `qwen3-tts-flash: ${data?.message || data?.error?.message || `Upstream error (${upstream.status})`}`
      );
    }
  } catch (err) {
    errors.push(`qwen3-tts-flash: ${err.message}`);
  }

  return jsonResponse({ error: { message: errors[0] || 'TTS failed.', details: errors } }, 502);
}

/**
 * Open the DashScope realtime WebSocket, send the full text, and resolve with
 * a ReadableStream of raw PCM bytes as soon as the first audio delta arrives.
 * Rejects if no audio could be obtained (so the caller can fall back).
 */
async function realtimeTtsStream(apiKey, text, voice, languageType) {
  const resp = await fetch(REALTIME_URL, {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const ws = resp.webSocket;
  if (!ws) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`WebSocket upgrade failed (${resp.status}): ${errText.slice(0, 200)}`);
  }
  ws.accept();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  return new Promise((resolve, reject) => {
    let gotAudio = false;
    let closed = false;

    const cleanup = () => {
      clearTimeout(startTimer);
      clearTimeout(hardTimer);
      try { ws.close(); } catch {}
    };
    // Before first audio: reject so the caller can fall back.
    // After first audio: just end the stream early.
    const fail = (err) => {
      if (closed) return;
      closed = true;
      cleanup();
      if (gotAudio) writer.close().catch(() => {});
      else reject(err);
    };
    const end = () => {
      if (closed) return;
      closed = true;
      cleanup();
      writer.close().catch(() => {});
      if (!gotAudio) reject(new Error('No audio received from realtime API.'));
    };

    const startTimer = setTimeout(() => fail(new Error('No audio within 20s.')), 20000);
    const hardTimer = setTimeout(end, 90000);

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const type = msg.type || '';

      if (type === 'session.created') {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            voice,
            language_type: languageType,
            response_format: 'pcm',
            sample_rate: SAMPLE_RATE,
            mode: 'commit',
          },
        }));
        ws.send(JSON.stringify({ type: 'input_text_buffer.append', text }));
        ws.send(JSON.stringify({ type: 'input_text_buffer.commit' }));
        ws.send(JSON.stringify({ type: 'session.finish' }));
      } else if (type.endsWith('audio.delta') && msg.delta) {
        const bytes = base64ToBytes(msg.delta);
        if (!gotAudio) {
          gotAudio = true;
          clearTimeout(startTimer);
          resolve(readable);
        }
        writer.write(bytes).catch(() => fail(new Error('Client disconnected.')));
      } else if (type === 'session.finished' || type === 'session.done') {
        end();
      } else if (type === 'error' || msg.error) {
        const e = msg.error || msg;
        fail(new Error(e.message || JSON.stringify(e).slice(0, 200)));
      }
    });

    ws.addEventListener('close', end);
    ws.addEventListener('error', () => fail(new Error('WebSocket connection error.')));
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Pull the raw PCM samples out of a WAV container. */
function extractPcmFromWav(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 12; // skip RIFF header
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') return bytes.slice(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1);
  }
  return bytes; // not a RIFF file — pass through untouched
}

function pcmResponse(bodyInit) {
  return new Response(bodyInit, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Sample-Rate': String(SAMPLE_RATE),
      'X-Audio-Format': 'pcm16le-mono',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
