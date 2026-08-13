// ─── HLS Download Worker ──────────────────────────────────────────────────────
// Endpoints:
//   /vidstream?hash=<hash>               resolve VidStream hash → rewritten m3u8
//   /download?url=<m3u8>&referer=<ref>   parse manifest → return proxied segment list
//   /proxy?url=<any>&referer=<ref>       pipe any CDN URL through with CORS headers

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const VIDSTREAM_HOST = 'https://as-cdn21.top';

// ─── /vidstream ───────────────────────────────────────────────────────────────
// 1. POST getVideo from CF IP → get signed m3u8
// 2. Fetch master.m3u8 from CF IP → rewrite all child URLs through /proxy
// 3. Return rewritten m3u8 text — HLS.js loads it directly, segments proxied from same IP
async function handleVidstream(request) {
  const { searchParams, origin } = new URL(request.url);
  const hash = searchParams.get('hash');
  if (!hash) return errResp('?hash= required', 400);

  const referer = `${VIDSTREAM_HOST}/video/${hash}`;

  // Step 1 — resolve signed m3u8 URL
  let m3u8Url;
  try {
    const r = await fetch(`${VIDSTREAM_HOST}/player/index.php?data=${hash}&do=getVideo`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': referer,
        'User-Agent': UA,
      },
    });
    const d = await r.json();
    m3u8Url = d?.videoSource || d?.securedLink;
  } catch (e) {
    return errResp('getVideo failed: ' + e.message, 502);
  }

  if (!m3u8Url) return errResp('no m3u8 in getVideo response', 404);

  // Step 2 — fetch master manifest from same CF IP
  let masterText;
  try {
    const r = await fetch(m3u8Url, {
      headers: { 'Referer': referer, 'User-Agent': UA },
    });
    if (!r.ok) return errResp(`master.m3u8 fetch failed: ${r.status}`, r.status);
    masterText = await r.text();
  } catch (e) {
    return errResp('m3u8 fetch failed: ' + e.message, 502);
  }

  // Step 3 — rewrite all URIs in manifest through /proxy on this same worker
  const rewritten = rewriteM3u8(masterText, m3u8Url, origin, referer);

  return new Response(rewritten, {
    headers: {
      ...CORS,
      'Content-Type': 'application/vnd.apple.mpegurl',
      'X-Raw-M3u8': m3u8Url, // ponytail: expose raw URL in header for debugging
    },
  });
}

// Rewrite every URI line and EXT-X-MAP URI in an m3u8 through /proxy
function rewriteM3u8(text, base, workerOrigin, referer) {
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) {
      // rewrite EXT-X-MAP URI="..."
      if (t.startsWith('#EXT-X-MAP:')) {
        return t.replace(/URI="([^"]+)"/, (_, uri) =>
          `URI="${makeProxyUrl(workerOrigin, absUrl(base, uri), referer)}"`
        );
      }
      return line;
    }
    // segment or child playlist line
    return makeProxyUrl(workerOrigin, absUrl(base, t), referer);
  }).join('\n');
}

// ─── /proxy ───────────────────────────────────────────────────────────────────
async function handleProxy(request) {
  const { searchParams } = new URL(request.url);
  const target  = searchParams.get('url');
  const referer = searchParams.get('referer') || '';

  if (!target) return errResp('?url= required', 400);

  let decoded;
  try { decoded = decodeURIComponent(target); } catch { decoded = target; }

  let originHeader = {};
  try { originHeader = referer ? { Origin: new URL(referer).origin } : {}; } catch {}

  const upstreamHeaders = {
    'User-Agent': UA,
    Accept: '*/*',
    ...(referer ? { Referer: referer, ...originHeader } : {}),
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await sleep(500 * attempt);
      const upstream = await fetch(decoded, { headers: upstreamHeaders });
      if (upstream.status === 429 || upstream.status >= 500) {
        lastErr = new Error('upstream HTTP ' + upstream.status);
        continue;
      }
      const headers = new Headers(CORS);
      headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
      const cl = upstream.headers.get('Content-Length');
      if (cl) headers.set('Content-Length', cl);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      lastErr = e;
    }
  }
  return errResp((lastErr && lastErr.message) || 'proxy failed', 502);
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeProxyUrl(origin, rawUrl, referer) {
  return `${origin}/proxy?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(referer)}`;
}

function absUrl(base, href) {
  try { return new URL(href.trim(), base).toString(); } catch { return href.trim(); }
}

function parseAttrs(str) {
  const out = {};
  const re = /([A-Z-]+)=(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(str)) !== null) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

async function fetchText(url, referer) {
  let originHeader = {};
  try { originHeader = referer ? { Origin: new URL(referer).origin } : {}; } catch {}
  const headers = { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer, ...originHeader } : {}) };
  for (let i = 0; i < 3; i++) {
    try {
      if (i > 0) await sleep(400 * i);
      const r = await fetch(url, { headers, cf: { cacheTtl: 30, cacheEverything: true } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    } catch (e) { if (i === 2) throw e; }
  }
}

function parseMaster(text, base) {
  const lines = text.split('\n');
  const streams = [], audioGroups = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE === 'AUDIO' && a.URI) {
        const gid = a['GROUP-ID'];
        if (!audioGroups[gid]) audioGroups[gid] = [];
        audioGroups[gid].push({ name: a.NAME || gid, language: a.LANGUAGE || 'und', isDefault: a.DEFAULT === 'YES', uri: absUrl(base, a.URI) });
      }
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
      const uri = (lines[i + 1] || '').trim();
      if (uri && !uri.startsWith('#')) { streams.push({ bandwidth: Number(a.BANDWIDTH || 0), resolution: a.RESOLUTION || null, audioGroup: a.AUDIO || null, uri: absUrl(base, uri) }); i++; }
    }
  }
  streams.sort((a, b) => b.bandwidth - a.bandwidth);
  return { streams, audioGroups };
}

function parseMedia(text, base) {
  const lines = text.split('\n');
  const segments = [];
  let initSegment = null, totalDuration = 0, dur = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) { const m = line.match(/URI="([^"]+)"/); if (m) initSegment = absUrl(base, m[1]); }
    if (line.startsWith('#EXTINF:')) { dur = parseFloat(line.split(':')[1]) || 0; }
    if (!line.startsWith('#')) { segments.push(absUrl(base, line)); totalDuration += dur; dur = 0; }
  }
  return { segments, initSegment, totalDuration: Math.round(totalDuration) };
}

// ─── /download ────────────────────────────────────────────────────────────────
async function handleDownload(request) {
  const reqUrl = new URL(request.url);
  const workerOrigin = reqUrl.origin;
  const rawM3u8 = reqUrl.searchParams.get('url');
  const referer = reqUrl.searchParams.get('referer') || '';
  if (!rawM3u8) return errResp('?url= required', 400);
  let m3u8;
  try { m3u8 = decodeURIComponent(rawM3u8); } catch { m3u8 = rawM3u8; }
  try {
    const masterText = await fetchText(m3u8, referer);
    const isMaster = masterText.indexOf('#EXT-X-STREAM-INF:') !== -1;
    let videoPlaylistUrl = m3u8, resolution = null, bandwidth = 0, audioTracks = [];
    if (isMaster) {
      const parsed = parseMaster(masterText, m3u8);
      if (!parsed.streams.length) return errResp('No video streams found', 422);
      const best = parsed.streams[0];
      resolution = best.resolution; bandwidth = best.bandwidth; videoPlaylistUrl = best.uri;
      const group = best.audioGroup ? (parsed.audioGroups[best.audioGroup] || []) : [];
      audioTracks = await Promise.all(group.map(async track => {
        const t = await fetchText(track.uri, referer);
        const med = parseMedia(t, track.uri);
        return { name: track.name, language: track.language, isDefault: track.isDefault, totalDuration: med.totalDuration, initSegment: med.initSegment ? makeProxyUrl(workerOrigin, med.initSegment, referer) : null, segments: med.segments.map(s => makeProxyUrl(workerOrigin, s, referer)) };
      }));
    }
    const videoText = await fetchText(videoPlaylistUrl, referer);
    const video = parseMedia(videoText, videoPlaylistUrl);
    return jsonResp({ video: { resolution, bandwidth, totalDuration: video.totalDuration, initSegment: video.initSegment ? makeProxyUrl(workerOrigin, video.initSegment, referer) : null, segments: video.segments.map(s => makeProxyUrl(workerOrigin, s, referer)) }, audio: audioTracks });
  } catch (e) { return errResp(e.message, 500); }
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}
function errResp(msg, status) { return jsonResp({ error: msg }, status || 400); }

addEventListener('fetch', function(event) { event.respondWith(handleRequest(event.request)); });

async function handleRequest(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const path = new URL(request.url).pathname;
  if (path === '/vidstream') return handleVidstream(request);
  if (path === '/download')  return handleDownload(request);
  if (path === '/proxy')     return handleProxy(request);
  return errResp('Endpoints: /vidstream?hash=<hash>  |  /download?url=<m3u8>&referer=<ref>  |  /proxy?url=<any>&referer=<ref>', 404);
}
