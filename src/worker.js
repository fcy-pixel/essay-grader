/**
 * Cloudflare Worker – English Essay Auto-Grader
 *
 * Routes:
 *   GET  /          → serve static frontend (public/index.html via ASSETS)
 *   POST /api/qwen  → proxy to Qwen DashScope International API
 *
 * Required secret (set via wrangler secret put QWEN_API_KEY):
 *   QWEN_API_KEY  – Your Alibaba Cloud International DashScope API key
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS pre-flight ───────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // ── Qwen API proxy ────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/qwen') {
      return handleQwenProxy(request, env);
    }

    // ── Static assets (index.html, etc.) ─────────────────────────────────
    return env.ASSETS.fetch(request);
  },
};

async function handleQwenProxy(request, env) {
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

  // Forward to DashScope International endpoint
  const upstream = await fetch(
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }
  );

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
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
