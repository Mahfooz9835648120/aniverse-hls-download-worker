# Aniverse HLS Download Worker

Cloudflare Worker used by the Aniverse Android downloader to fetch HLS playlists
and media segments. The APK downloads the selected video/audio tracks through
this Worker and performs the final local MP4 remux itself.

## Deploy

```bash
npm install
npm run deploy
```

After deployment, configure the APK with the resulting `workers.dev` URL.

## Endpoint

```text
GET /proxy?url=<encoded upstream URL>
```

The endpoint forwards byte ranges and supports optional upstream context through
`X-Aniverse-Referer`, `X-Aniverse-Origin`, `X-Aniverse-Cookie`, and
`X-Aniverse-Authorization` request headers. It retries 401/403 responses with
several safe Referer/Origin combinations.

Only public HTTP(S) targets are accepted. Private-network addresses are blocked.
