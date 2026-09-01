# Deploying alongside an existing site

This VPS already runs another live project. The single rule that matters: **this
service must never claim ports 80 or 443.** The web server already on the host
keeps them, keeps its certificates, and keeps serving the existing site.

`docker-compose.yml` (the default) starts its own nginx bound to 80/443. **Do not
use it here.** Use `docker-compose.vps.yml`, which starts only the API on a
localhost port.

---

## Step 1 — Find out what is already running

Run these first and keep the output. Do not skip this.

```bash
# What owns 80/443, and which ports are taken?
sudo ss -tlnp | grep -E ':(80|443|8000|8090|9000)\b'

# Existing containers and their port bindings
docker ps --format 'table {{.Names}}\t{{.Ports}}'

# Which web server is on the host?
systemctl is-active nginx apache2 httpd caddy 2>/dev/null
```

Two things to confirm:

1. **Which web server owns 80/443** — nginx, Apache, Caddy, or a container.
2. **A free localhost port** for the API. `8090` is the default; pick another if
   it is taken.

Also check no container is already named `video_downloader_api`.

## Step 2 — Configure

```bash
git clone <your-repo> /opt/video-downloader-api
cd /opt/video-downloader-api

cp .env.example .env
nano .env
```

Set at minimum:

| Variable | Value |
|---|---|
| `API_KEY` | `openssl rand -hex 48` |
| `PUBLIC_BASE_URL` | `https://downloader.example.com` — your subdomain |
| `HOST_PORT` | A free localhost port (default `8090`) |
| `NODE_ENV` | `production` |

`PUBLIC_BASE_URL` matters: without it, `file_url` in conversion responses is
built from the proxied request host and can come back as an internal address the
phone cannot reach.

```bash
touch cookies.txt      # bind-mount target must exist before first start
```

## Step 3 — Start the API

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

Verify it is up and **only** on localhost:

```bash
curl http://127.0.0.1:8090/api/health
sudo ss -tlnp | grep 8090      # expect 127.0.0.1:8090, never 0.0.0.0:8090
```

At this point the existing site is untouched — nothing has bound a public port.

## Step 4 — Point a subdomain at it

Create a DNS A record for `downloader.example.com` → the VPS IP.

Then add the vhost for whichever server you have:

- nginx → [`nginx-vhost.conf`](nginx-vhost.conf)
- Apache → [`apache-vhost.conf`](apache-vhost.conf)

**Always test the config before reloading.** A syntax error takes the existing
site down with it:

```bash
sudo nginx -t && sudo systemctl reload nginx
# or
sudo apachectl configtest && sudo systemctl reload apache2
```

## Step 5 — TLS

Use the certbot already on the box, so renewal keeps working the way it does for
the existing site:

```bash
sudo certbot --nginx -d downloader.example.com
# or
sudo certbot --apache -d downloader.example.com
```

## Step 6 — Verify from outside

```bash
curl https://downloader.example.com/api/health
curl -H "x-api-key: $API_KEY" \
  "https://downloader.example.com/api/download?url=https://www.dailymotion.com/video/xa1c774"
```

Then confirm the **existing site still works**. That is the check that matters.

---

## If the existing proxy is a container

Do not bind a host port at all. Attach the API to the proxy's Docker network and
route to it by container name:

```bash
docker network ls          # find the existing proxy's network
```

Add to `docker-compose.vps.yml`:

```yaml
    networks: [proxy_net]
networks:
  proxy_net:
    external: true
    name: <the existing network>
```

Drop the `ports:` block entirely and point the proxy at
`http://video_downloader_api:8000`.

---

## Re-test the platforms after deploying

**Do not assume the platform results measured in development carry over.** Those
were taken from a residential IP. The VPS has a datacenter IP, and YouTube,
Instagram and TikTok all treat those far more harshly — YouTube in particular
often answers with "Sign in to confirm you're not a bot".

Re-run the checks on the VPS and update `api-docs/README.md` with what you
actually see:

```bash
curl -H "x-api-key: $KEY" "https://downloader.example.com/api/download?url=<youtube-url>"
curl -H "x-api-key: $KEY" "https://downloader.example.com/api/tiktok?url=<tiktok-url>"
```

If YouTube is blocked, the usual mitigations are supplying cookies from a
logged-in account or routing yt-dlp through a residential proxy. Neither is
configured today.

## Operations

**Disk.** Converted and merged files land in `./downloads` and are deleted after
`CACHE_TTL_SECONDS` (default 1h). A merge at `best` quality can be ~230MB. Watch
free space for the first week, and lower `DEFAULT_QUALITY` if it grows:

```bash
du -sh /opt/video-downloader-api/downloads
```

**Logs.** Capped at 3 × 10MB by the compose file.

```bash
docker compose -f docker-compose.vps.yml logs -f api
```

**Updating yt-dlp.** Extractors break as sites change; rebuild periodically:

```bash
docker compose -f docker-compose.vps.yml build --no-cache api
docker compose -f docker-compose.vps.yml up -d
```

**Rollback.** `docker compose -f docker-compose.vps.yml down` removes only this
service. The existing site is unaffected because it was never touched.
