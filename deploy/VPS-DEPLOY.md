# Deploying to the VPS (srv1853514)

This host already runs the **uzy** stack behind **Caddy**, and Caddy owns ports
80/443 for everything on the box. The single rule that matters: **this service
must never claim 80 or 443, and must never restart Caddy.**

What is already there:

| Container | Ports |
|---|---|
| `uzy-caddy-1` | `0.0.0.0:80`, `0.0.0.0:443` — the reverse proxy for the whole host |
| `uzy-user-admin-1` | `127.0.0.1:3000` |
| `uzy-ai-admin-frontend-1` | `127.0.0.1:3001` |
| `uzy-ai-admin-backend-1` | `127.0.0.1:3002` |
| `uzy-postgres-1` | `127.0.0.1:5432` |
| `uzy-minio-1` | `127.0.0.1:9000-9001` |
| `uzy-prisma-studio-1` | `127.0.0.1:5555` |
| `uzy-user-admin-studio-1` | `127.0.0.1:5556` |

> **Note:** port **9000 is taken by MinIO**. The old monorepo ran this service on
> 9000 — never reuse that here.

`docker-compose.yml` (the default) starts its own nginx on 80/443. **Do not use
it on this host.** Use `docker-compose.vps.yml`, which binds **no host ports at
all** and instead joins Caddy's Docker network. Nothing it does can collide.

---

## Step 1 — Known values

Already discovered on this host (2026-09-01), no need to look them up again:

| Thing | Value |
|---|---|
| Caddy's Docker network | `uzy_default` |
| Caddyfile on the host | `/opt/Uzy/caddy/Caddyfile` |
| Caddyfile inside the container | `/etc/caddy/Caddyfile` (bind-mounted) |
| Caddy container | `uzy-caddy-1` |

The Caddyfile is bind-mounted, so editing it on the host is immediately visible
to the container — no rebuild, no copy step.

Confirm the container name is still free before starting:

```bash
docker ps -a --filter name=video_downloader_api
```

## Step 2 — Configure

```bash
git clone <your-repo> /opt/video-downloader-api
cd /opt/video-downloader-api

cp .env.example .env

# Generate and set the API key in one step. Editing by hand is easy to get
# wrong: an unset API_KEY leaves the service running but returning 500 on
# every protected route.
API_KEY=$(openssl rand -hex 48)
sed -i "s|^API_KEY=.*|API_KEY=$API_KEY|" .env
echo "Save this for the mobile app: $API_KEY"

# Your subdomain, used to build download URLs.
sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://downloader.example.com|" .env

grep -E '^(API_KEY|PUBLIC_BASE_URL)=' .env    # confirm both are non-empty
```

Do not wrap values in quotes — `API_KEY="abc"` passes the quotes through as
part of the value.

Set at minimum:

| Variable | Value |
|---|---|
| `API_KEY` | `openssl rand -hex 48` |
| `PUBLIC_BASE_URL` | `https://downloader.example.com` — your subdomain |
| `CADDY_NETWORK` | `uzy_default` (already the default) |
| `NODE_ENV` | `production` |

`PUBLIC_BASE_URL` matters more than it looks: without it, `file_url` in
conversion responses is built from the proxied request host and can come back as
an internal Docker address the phone cannot reach.

`HOST_PORT` is unused on this host — no host port is bound.

```bash
mkdir -p downloads
touch cookies.txt      # bind-mount targets must exist before first start

# The container runs as the unprivileged `node` user (uid 1000), but these are
# created by root on the host. Bind mounts overlay the image's own permissions,
# so without this the API cannot write converted files or update cookies.txt.
sudo chown -R 1000:1000 downloads cookies.txt
```

This leaves an **empty** cookies.txt, which is expected and fine. `/api/health`
will report `"cookies": false, "cookies_detail": "empty"` until you upload a real
jar — that is the correct reading, not a fault. Only Instagram and other
login-gated sources need one.

## Step 3 — Start the API

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

`.env` is read at container **creation**, not on restart. After any change to
it, recreate rather than restart, then confirm the value actually landed:

```bash
docker compose -f docker-compose.vps.yml up -d --force-recreate
docker exec video_downloader_api sh -c 'echo "API_KEY len=${#API_KEY}"'   # expect 96
```

`/api/health` returns **503 `"degraded"`** while `API_KEY` is empty, and the
container shows as unhealthy — that is the signal that this step was missed.

Verify it is running and that **no new host port appeared**:

```bash
docker exec video_downloader_api \
  node -e "fetch('http://127.0.0.1:8000/api/health').then(r=>r.text()).then(console.log)"

sudo ss -tlnp | grep -E ':(80|443|8000|8090)\b'   # should be unchanged from before
```

At this point the existing site is completely untouched — nothing public has
changed.

## Step 4 — Add the subdomain to Caddy

Point a DNS A record for `downloader.example.com` at the VPS **first**, or
Caddy's certificate request will fail.

Back up the Caddyfile first — it also serves the live uzy site:

```bash
sudo cp /opt/Uzy/caddy/Caddyfile /opt/Uzy/caddy/Caddyfile.bak
```

Append the block from [`Caddyfile.snippet`](Caddyfile.snippet), with your real
subdomain substituted:

```bash
sudo nano /opt/Uzy/caddy/Caddyfile
```

Then validate, and reload **only if validation passes**:

```bash
docker exec uzy-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec uzy-caddy-1 caddy reload  --config /etc/caddy/Caddyfile
```

If validation fails, restore the backup and try again — do not reload a config
that failed validation:

```bash
sudo cp /opt/Uzy/caddy/Caddyfile.bak /opt/Uzy/caddy/Caddyfile
```

**Use `reload`, never `restart`.** A reload is graceful and does not interrupt
the existing site; a restart drops connections. If `validate` fails, fix it
before reloading — do not reload a config that failed validation.

Caddy issues and renews TLS automatically. There is no certbot step.

## Step 5 — Verify from outside

```bash
curl https://downloader.example.com/api/health

curl -H "x-api-key: $API_KEY" \
  "https://downloader.example.com/api/download?url=https://www.dailymotion.com/video/xa1c774"
```

Then open the existing uzy site and confirm it still works. **That is the check
that matters most.**

## Rollback

```bash
docker compose -f docker-compose.vps.yml down
```

Removes only this service. Then restore the Caddyfile backup and reload:

```bash
sudo cp /opt/Uzy/caddy/Caddyfile.bak /opt/Uzy/caddy/Caddyfile
docker exec uzy-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

The existing stack is unaffected because it was never modified.

---

## Re-test the platforms here

**Do not trust the platform results measured in development.** Those came from a
residential IP. This VPS has a datacenter IP, and YouTube, Instagram and TikTok
treat those far more harshly — YouTube commonly answers with "Sign in to confirm
you're not a bot".

Re-run the checks against the deployed service and update
`api-docs/README.md` with what you actually observe:

```bash
KEY=<your api key>
BASE=https://downloader.example.com

curl -H "x-api-key: $KEY" "$BASE/api/download?url=<youtube-url>"
curl -H "x-api-key: $KEY" "$BASE/api/tiktok?url=<tiktok-url>"
curl -H "x-api-key: $KEY" "$BASE/api/download?url=<facebook-url>"
```

If YouTube is blocked from this IP, the options are supplying cookies from a
logged-in account or routing yt-dlp through a residential proxy. Neither is
configured today.

## Operations

**Disk.** Converted and merged files land in `./downloads`, deleted after
`CACHE_TTL_SECONDS` (default 1h). A `best`-quality merge can be ~230MB. This box
also hosts Postgres and MinIO, so keep an eye on free space for the first week:

```bash
df -h /
du -sh /opt/video-downloader-api/downloads
```

Lower `DEFAULT_QUALITY` if it grows faster than you like.

**Logs.** Capped at 3 × 10MB by the compose file.

```bash
docker compose -f docker-compose.vps.yml logs -f api
```

**Updating yt-dlp.** Extractors break as sites change; rebuild periodically:

```bash
docker compose -f docker-compose.vps.yml build --no-cache api
docker compose -f docker-compose.vps.yml up -d
```

This rebuilds only this service and never touches Caddy or the uzy containers.
