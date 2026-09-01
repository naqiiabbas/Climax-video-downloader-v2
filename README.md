# Video Downloader API

Standalone yt-dlp based extraction service. Takes a video page URL from a
supported site and returns direct media URLs plus metadata, for the mobile app
to download.

Supports TikTok, Instagram, Vimeo, Dailymotion, Pinterest, and anything else
yt-dlp handles via the universal `/api/download` endpoint.

**Full endpoint reference: [docs/API.md](docs/API.md)**

## Requirements

- Node.js 20+
- `yt-dlp` and `ffmpeg` on `PATH` (Docker installs both; on Windows the
  bundled `yt-dlp.exe` and `ffmpeg/` are used automatically)

## Local development

```bash
npm install
cp .env.example .env      # then set API_KEY
npm run dev
```

Server starts on `http://localhost:8000`. Smoke test:

```bash
curl http://localhost:8000/api/health
curl -H "x-api-key: $API_KEY" \
  "http://localhost:8000/api/download?url=https://vimeo.com/76979871"
```

## Deploying to a VPS

```bash
git clone <your-repo> /opt/video-downloader-api
cd /opt/video-downloader-api

cp .env.example .env
# Set API_KEY (openssl rand -hex 48) and PUBLIC_BASE_URL
nano .env

# Point nginx at your domain
sed -i 's/api.example.com/your-domain.com/g' nginx/nginx.conf

touch cookies.txt          # bind mount target must exist
docker compose up -d --build
```

Then issue certificates:

```bash
docker compose run --rm certbot certonly --webroot \
  -w /var/www/certbot -d your-domain.com
docker compose restart nginx
```

Renewal (crontab):

```
0 3 * * * cd /opt/video-downloader-api && docker compose run --rm certbot renew && docker compose restart nginx
```

The API container binds to `127.0.0.1:8000` only — Nginx is the sole public
entrypoint.

## Keeping yt-dlp current

Sites change their players constantly and a stale yt-dlp starts failing with
"Unable to extract" errors. The image installs the latest release at build time,
so rebuild periodically:

```bash
docker compose build --no-cache api && docker compose up -d
```

For local Windows dev, refresh the bundled binary with `.\yt-dlp.exe -U`.

## Cookies

Login-gated sources (Instagram especially) need a Netscape-format `cookies.txt`.
Export one from a logged-in browser, then upload it:

```bash
curl -X POST https://your-domain.com/api/update-cookies \
  -H "x-api-key: $API_KEY" \
  -F "file=@cookies.txt"
```

`npm run refresh-cookies` can generate one from `IG_USERNAME`/`IG_PASSWORD`, but
Instagram often blocks password logins — uploading a browser export is more
reliable. `cookies.txt` is gitignored; never commit it.

## Layout

```
index.js                 server bootstrap, graceful shutdown
src/
  app.js                 express wiring, route mounting, error handling
  config.js              all env-derived config in one place
  controllers/           one per source + system.controller.js
  routes/
  middleware/apiAuth.js  x-api-key gate
  utils/cache.js         TTL cache that deletes files on expiry
scripts/refreshCookies.js
docs/API.md
nginx/nginx.conf
```

## Configuration

See [.env.example](.env.example). `API_KEY` is required — protected routes
return 500 until it is set.

## Notes

- Extracted CDN URLs expire within minutes. Resolve immediately before download.
- Converted mp4 files are deleted after `CACHE_TTL_SECONDS` (default 1h).
- Downloading from these platforms generally violates their terms of service.
  Make sure your use is authorized.
