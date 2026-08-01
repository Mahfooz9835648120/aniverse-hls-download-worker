const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Range,Content-Type,X-Aniverse-Referer,X-Aniverse-Origin,X-Aniverse-Cookie,X-Aniverse-Authorization',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type',
};

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Aniverse) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36';
const DEFAULT_ANIVEXA_PROXY = 'https://anivexa-apii-proxy.alammahfooz9276.workers.dev';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);

    const incoming = new URL(request.url);
    if (incoming.pathname !== '/proxy') {
      return json({
        ok: true,
        service: 'Aniverse HLS download proxy',
        usage: '/proxy?url=https%3A%2F%2Fexample.com%2Fmaster.m3u8',
      });
    }

    const rawUrl = incoming.searchParams.get('url');
    if (!rawUrl) return json({ error: 'Missing url parameter' }, 400);

    let target;
    try {
      target = new URL(rawUrl);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported protocol');
      if (isPrivateHost(target.hostname)) throw new Error('Private network targets are blocked');
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Invalid URL' }, 400);
    }

    const referer = request.headers.get('X-Aniverse-Referer')
      || request.headers.get('Referer')
      || incoming.searchParams.get('ref')
      || '';
    const origin = request.headers.get('X-Aniverse-Origin')
      || request.headers.get('Origin')
      || getOrigin(referer);
    const cookie = request.headers.get('X-Aniverse-Cookie') || request.headers.get('Cookie') || '';
    const authorization = request.headers.get('X-Aniverse-Authorization') || request.headers.get('Authorization') || '';

    const attempts = unique([
      { referer, origin },
      { referer: `${target.origin}/`, origin: target.origin },
      { referer, origin: '' },
      { referer: '', origin: '' },
    ]);

    let upstream;
    let lastError = 'Upstream fetch failed';
    const failures = [];
    for (const attempt of attempts) {
      try {
        const response = await fetch(target.toString(), {
          method: request.method,
          redirect: 'follow',
          headers: makeUpstreamHeaders(request, attempt, cookie, authorization),
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (response.status !== 401 && response.status !== 403) {
          upstream = response;
          break;
        }
        lastError = `Upstream returned HTTP ${response.status}`;
        failures.push(`direct:${response.status}`);
        await response.body?.cancel();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        failures.push(`direct:${lastError}`);
      }
    }

    if (!upstream) {
      const proxyBase = String(env?.ANIVEXA_PROXY_URL || DEFAULT_ANIVEXA_PROXY).replace(/\/$/, '');
      if (new URL(proxyBase).hostname !== target.hostname) {
        const fallback = new URL(`${proxyBase}/`);
        fallback.searchParams.set('url', target.toString());
        if (referer) fallback.searchParams.set('ref', referer);
        fallback.searchParams.set('download', '1');
        try {
          const response = await fetch(fallback.toString(), {
            method: request.method,
            redirect: 'follow',
            headers: request.headers.get('Range') ? { Range: request.headers.get('Range') } : {},
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (response.ok || response.status === 206) upstream = response;
          else {
            failures.push(`anivexa:${response.status}`);
            lastError = `Anivexa proxy returned HTTP ${response.status}`;
            await response.body?.cancel();
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          failures.push(`anivexa:${lastError}`);
        }
      }
    }
    if (!upstream) return json({ error: lastError, targetHost: target.hostname, attempts: failures }, 502);

    const headers = new Headers(upstream.headers);
    Object.entries(CORS).forEach(([key, value]) => headers.set(key, value));
    headers.set('Cache-Control', 'no-store');
    headers.delete('Content-Security-Policy');
    headers.delete('Content-Security-Policy-Report-Only');
    headers.delete('X-Frame-Options');
    headers.delete('Set-Cookie');

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};

function makeUpstreamHeaders(request, attempt, cookie, authorization) {
  const headers = new Headers({
    'User-Agent': USER_AGENT,
    Accept: request.headers.get('Accept') || '*/*',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': attempt.origin ? 'cross-site' : 'none',
  });
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);
  if (attempt.referer) headers.set('Referer', attempt.referer);
  if (attempt.origin) headers.set('Origin', attempt.origin);
  if (cookie) headers.set('Cookie', cookie);
  if (authorization) headers.set('Authorization', authorization);
  return headers;
}

function unique(attempts) {
  const seen = new Set();
  return attempts.filter(item => {
    const key = `${item.referer}|${item.origin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getOrigin(value) {
  try { return value ? new URL(value).origin : ''; } catch { return ''; }
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '0.0.0.0' || host === '127.0.0.1' || host === '::1'
    || host.endsWith('.local') || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
