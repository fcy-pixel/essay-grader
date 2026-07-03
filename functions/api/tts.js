/**
 * Cloudflare Pages Function – Qwen TTS Proxy
 * Route: POST /api/tts
 * Body:  { "text": "...", "voice": "Cherry" (optional) }
 * Returns: audio bytes (wav/mp3) ready to play
 *
 * Uses the same QWEN_API_KEY secret as /api/qwen.
 */

const TTS_ENDPOINT =
  'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

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

  // qwen3-tts-flash is the only TTS model on the DashScope international endpoint
  const attempts = [
    { model: 'qwen3-tts-flash', input: { text, voice, language_type: 'Auto' } },
  ];

  const errors = [];
  let lastError = 'TTS request failed.';
  for (const payload of attempts) {
    try {
      const upstream = await fetch(TTS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await upstream.json();
      const audioUrl = data?.output?.audio?.url;

      if (upstream.ok && audioUrl) {
        // Fetch the audio server-side so the browser gets bytes directly
        // (avoids the 24h-expiry URL and any mixed-content issues)
        const audioResp = await fetch(audioUrl.replace(/^http:\/\//, 'https://'));
        if (!audioResp.ok) {
          lastError = `Audio download failed (${audioResp.status})`;
          continue;
        }
        return new Response(audioResp.body, {
          headers: {
            'Content-Type': audioResp.headers.get('Content-Type') || 'audio/wav',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      lastError =
        data?.message || data?.error?.message || `Upstream error (${upstream.status})`;
      errors.push(`${payload.model}: ${lastError} [code=${data?.code || ''}]`);
    } catch (err) {
      lastError = err.message;
      errors.push(`${payload.model}: ${lastError}`);
    }
  }

  return jsonResponse({ error: { message: lastError, details: errors } }, 502);
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
