/**
 * Cloudflare Pages Function – Qwen API Proxy
 * Route: POST /api/qwen
 *
 * Required secret (set via dashboard or `wrangler pages secret put QWEN_API_KEY`):
 *   QWEN_API_KEY  – Your Alibaba Cloud International DashScope API key
 */

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
