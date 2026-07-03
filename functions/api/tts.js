/**
 * Cloudflare Pages Function – Qwen TTS Proxy
 * Route: POST /api/tts
 * Body:  { "text": "...", "voice": "Cherry" (optional) }
 * Returns: audio bytes (wav/mp3) ready to play
 *
 * Primary:  qwen3-tts-instruct-flash-realtime (WebSocket realtime API)
 * Fallback: qwen3-tts-flash (HTTP multimodal-generation API)
 * Uses the same QWEN_API_KEY secret as /api/qwen.
 */

const REALTIME_MODEL = 'qwen3-tts-instruct-flash-realtime-2026-01-22';
const REALTIME_URL = `https://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=${REALTIME_MODEL}`;
const HTTP_TTS_ENDPOINT =
  'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const SAMPLE_RATE = 24000;

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

  const errors = [];

  // 1) Realtime WebSocket model
  try {
    const wav = await realtimeTts(apiKey, text, voice);
    return audioResponse(wav, 'audio/wav');
  } catch (err) {
    errors.push(`${REALTIME_MODEL}: ${err.message}`);
  }

  // 2) Fallback: qwen3-tts-flash over HTTP
  try {
    const upstream = await fetch(HTTP_TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'qwen3-tts-flash',
        input: { text, voice, language_type: 'Auto' },
      }),
    });
    const data = await upstream.json();
    const audioUrl = data?.output?.audio?.url;
    if (upstream.ok && audioUrl) {
      const audioResp = await fetch(audioUrl.replace(/^http:\/\//, 'https://'));
      if (audioResp.ok) {
        return audioResponse(
          await audioResp.arrayBuffer(),
          audioResp.headers.get('Content-Type') || 'audio/wav'
        );
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
 * Synthesize speech via the DashScope realtime WebSocket API.
 * Appends the full text, commits, finishes the session, and collects
 * base64 PCM deltas into a single WAV buffer.
 */
async function realtimeTts(apiKey, text, voice) {
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

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (!err && chunks.length === 0) err = new Error('No audio received from realtime API.');
      if (err) reject(err);
      else resolve(pcmToWav(concatChunks(chunks), SAMPLE_RATE));
    };

    const timer = setTimeout(() => finish(new Error('Realtime TTS timed out.')), 45000);

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const type = msg.type || '';

      if (type === 'session.created') {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            voice,
            response_format: 'pcm',
            sample_rate: SAMPLE_RATE,
            mode: 'commit',
          },
        }));
        ws.send(JSON.stringify({ type: 'input_text_buffer.append', text }));
        ws.send(JSON.stringify({ type: 'input_text_buffer.commit' }));
        ws.send(JSON.stringify({ type: 'session.finish' }));
      } else if (type.endsWith('audio.delta') && msg.delta) {
        chunks.push(base64ToBytes(msg.delta));
      } else if (type === 'session.finished' || type === 'session.done') {
        finish();
      } else if (type === 'error' || msg.error) {
        const e = msg.error || msg;
        finish(new Error(e.message || JSON.stringify(e).slice(0, 200)));
      }
    });

    ws.addEventListener('close', () => finish());
    ws.addEventListener('error', () => finish(new Error('WebSocket connection error.')));
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function concatChunks(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

/** Wrap raw 16-bit mono PCM in a WAV container. */
function pcmToWav(pcm, sampleRate) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);        // fmt chunk size
  view.setUint16(20, 1, true);         // PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, pcm.length, true);

  const wav = new Uint8Array(44 + pcm.length);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return wav.buffer;
}

function audioResponse(buffer, contentType) {
  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
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
