const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const VIDSTREAM_HOST = 'https://as-cdn21.top';

// ─── /vidstream?hash=<hash> ───────────────────────────────────────────────────
// POST getVideo from CF IP → get signed m3u8 URL → redirect to /m3u8
async function handleVidstream(request) {
  const { searchParams, origin } = new URL(request.url);
  const hash = searchParams.get('hash');
  if (!hash) return errResp('?hash= required', 400);

  const referer = `${VIDSTREAM_HOST}/video/${hash}`;
  let m3u8Url;
  try {
    const r = await fetch(`${VIDSTREAM_HOST}/player/index.php?data=${hash}&do=getVideo`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Referer': referer, 'User-Agent': UA },
    });
    const d = await r.json();
    m3u8Url = d?.videoSource || d?.securedLink;
  } catch (e) { return errResp('getVideo failed: ' + e.message, 502); }

  if (!m3u8Url) return errResp('no m3u8 in getVideo response', 404);

  // Redirect to /m3u8 which handles recursive rewriting
  const proxied = `${origin}/m3u8?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer)}`;
  return Response.redirect(proxied, 302);
}

// ─── /m3u8?url=<playlist>&referer=<ref> ──────────────────────────────────────
// Fetch any m3u8 from CF IP and rewrite ALL URIs (segments + child playlists)
// through this same endpoint or /proxy — so every request stays on same CF IP
async function handleM3u8(request) {
  const { searchParams, origin } = new URL(request.url);
  const raw     = searchParams.get('url');
  const referer = searchParams.get('referer') || '';
  if (!raw) return errResp('?url= required', 400);

  let url;
  try { url = decodeURIComponent(raw); } catch { url = raw; }

  let text;
  try {
    const r = await fetch(url, { headers: { 'Referer': referer, 'User-Agent': UA, 'Accept': '*/*' } });
    if (!r.ok) return errResp(`upstream ${r.status}`, r.status);
    text = await r.text();
  } catch (e) { return errResp('fetch failed: ' + e.message, 502); }

  const rewritten = text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;

    // EXT-X-MAP — init segment → proxy
    if (t.startsWith('#EXT-X-MAP:')) {
      return t.replace(/URI="([^"]+)"/, (_, uri) =>
        `URI="${proxyUrl(origin, absUrl(url, uri), referer)}"`
      );
    }

    // EXT-X-MEDIA with URI — audio/subtitle track → rewrite through /m3u8
    if (t.startsWith('#EXT-X-MEDIA:') && t.includes('URI="')) {
      return t.replace(/URI="([^"]+)"/, (_, uri) =>
        `URI="${m3u8Url(origin, absUrl(url, uri), referer)}"`
      );
    }

    // Non-comment URI lines — could be segment (.ts/.m4s) or child playlist (.m3u8)
    if (!t.startsWith('#')) {
      const abs = absUrl(url, t);
      // child playlist → rewrite through /m3u8 so its contents also get rewritten
      if (abs.includes('.m3u8')) return m3u8Url(origin, abs, referer);
      // segment → proxy directly
      return proxyUrl(origin, abs, referer);
    }

    return line;
  }).join('\n');

  return new Response(rewritten, {
    headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl' },
  });
}

// ─── /proxy?url=<any>&referer=<ref> ──────────────────────────────────────────
async function handleProxy(request) {
  const { searchParams } = new URL(request.url);
  const target  = searchParams.get('url');
  const referer = searchParams.get('referer') || '';
  if (!target) return errResp('?url= required', 400);

  let decoded;
  try { decoded = decodeURIComponent(target); } catch { decoded = target; }

  let originHeader = {};
  try { originHeader = referer ? { Origin: new URL(referer).origin } : {}; } catch {}

  const upstreamHeaders = { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer, ...originHeader } : {}) };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await sleep(500 * attempt);
      const upstream = await fetch(decoded, { headers: upstreamHeaders });
      if (upstream.status === 429 || upstream.status >= 500) { lastErr = new Error('upstream HTTP ' + upstream.status); continue; }
      const headers = new Headers(CORS);
      headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
      const cl = upstream.headers.get('Content-Length');
      if (cl) headers.set('Content-Length', cl);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) { lastErr = e; }
  }
  return errResp((lastErr && lastErr.message) || 'proxy failed', 502);
}

// ─── /download?url=<m3u8>&referer=<ref> ──────────────────────────────────────
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

// ─── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function absUrl(base, href) { try { return new URL(href.trim(), base).toString(); } catch { return href.trim(); } }
function proxyUrl(origin, url, referer) { return `${origin}/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`; }
function m3u8Url(origin, url, referer) { return `${origin}/m3u8?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`; }
function makeProxyUrl(origin, rawUrl, referer) { return `${origin}/proxy?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(referer)}`; }

function parseAttrs(str) {
  const out = {}, re = /([A-Z-]+)=(?:"([^"]*)"|([^\s,]+))/g; let m;
  while ((m = re.exec(str)) !== null) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
}
async function fetchText(url, referer) {
  const headers = { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) };
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
  const lines = text.split('\n'), streams = [], audioGroups = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA:')) { const a = parseAttrs(line.slice(13)); if (a.TYPE === 'AUDIO' && a.URI) { const gid = a['GROUP-ID']; if (!audioGroups[gid]) audioGroups[gid] = []; audioGroups[gid].push({ name: a.NAME || gid, language: a.LANGUAGE || 'und', isDefault: a.DEFAULT === 'YES', uri: absUrl(base, a.URI) }); } }
    if (line.startsWith('#EXT-X-STREAM-INF:')) { const a = parseAttrs(line.slice(18)); const uri = (lines[i+1]||'').trim(); if (uri && !uri.startsWith('#')) { streams.push({ bandwidth: Number(a.BANDWIDTH||0), resolution: a.RESOLUTION||null, audioGroup: a.AUDIO||null, uri: absUrl(base, uri) }); i++; } }
  }
  streams.sort((a, b) => b.bandwidth - a.bandwidth);
  return { streams, audioGroups };
}
function parseMedia(text, base) {
  const lines = text.split('\n'), segments = []; let initSegment = null, totalDuration = 0, dur = 0;
  for (const line of lines) { const t = line.trim(); if (!t) continue; if (t.startsWith('#EXT-X-MAP:')) { const m = t.match(/URI="([^"]+)"/); if (m) initSegment = absUrl(base, m[1]); } if (t.startsWith('#EXTINF:')) { dur = parseFloat(t.split(':')[1])||0; } if (!t.startsWith('#')) { segments.push(absUrl(base, t)); totalDuration += dur; dur = 0; } }
  return { segments, initSegment, totalDuration: Math.round(totalDuration) };
}
function jsonResp(data, status) { return new Response(JSON.stringify(data), { status: status||200, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } }); }
function errResp(msg, status) { return jsonResp({ error: msg }, status||400); }

addEventListener('fetch', e => e.respondWith(handleRequest(e.request)));
async function handleRequest(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const path = new URL(request.url).pathname;
  if (path === '/vidstream') return handleVidstream(request);
  if (path === '/m3u8')      return handleM3u8(request);
  if (path === '/download')  return handleDownload(request);
  if (path === '/proxy')     return handleProxy(request);
  return errResp('Endpoints: /vidstream?hash=  |  /m3u8?url=&referer=  |  /download?url=&referer=  |  /proxy?url=&referer=', 404);
}
