const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Range,Content-Type,X-Aniverse-Referer,X-Aniverse-Origin,X-Aniverse-Cookie,X-Aniverse-Authorization',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type',
};

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
        version: '1.3.0-anivexa-only',
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
    const proxyBase = String(env?.ANIVEXA_PROXY_URL || DEFAULT_ANIVEXA_PROXY).replace(/\/$/, '');
    const proxyHost = new URL(proxyBase).hostname;
    const upstreamUrl = target.hostname === proxyHost
      ? target
      : makeAnivexaUrl(proxyBase, target, referer);
    const upstreamHeaders = new Headers();
    const range = request.headers.get('Range');
    if (range) upstreamHeaders.set('Range', range);

    let upstream;
    try {
      upstream = await fetch(upstreamUrl.toString(), {
        method: request.method,
        redirect: 'follow',
        headers: upstreamHeaders,
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch (error) {
      return json({
        error: error instanceof Error ? error.message : 'Anivexa proxy fetch failed',
        targetHost: target.hostname,
        route: 'anivexa',
      }, 502);
    }
    if (!upstream.ok && upstream.status !== 206) {
      const status = upstream.status;
      await upstream.body?.cancel();
      return json({ error: `Anivexa proxy returned HTTP ${status}`, targetHost: target.hostname, route: 'anivexa' }, 502);
    }

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

function makeAnivexaUrl(proxyBase, target, referer) {
  const url = new URL(`${proxyBase}/`);
  url.searchParams.set('url', target.toString());
  if (referer) url.searchParams.set('ref', referer);
  url.searchParams.set('download', '1');
  return url;
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
