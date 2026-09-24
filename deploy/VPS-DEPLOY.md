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

**Always pass `-f docker-compose.vps.yml` explicitly.** There is no plain
`docker-compose.yml` in this repo anymore — it was renamed to
`docker-compose.local-only.yml` specifically so a bare `docker compose up`
(without `-f`) fails outright instead of silently doing the wrong thing. That
exact mistake happened on 2026-09-11: a stray invocation without `-f` picked
up the old default file, which starts its own nginx on 80/443 and attaches
the API to Compose's own default network — invisible to Caddy, and colliding
with ports Caddy already owns. `docker-compose.vps.yml` binds **no host ports
at all** and joins Caddy's Docker network instead — nothing it does can
collide, provided it's the file actually being run.

---

## Step 1 — Known values

Already discovered on this host (2026-09-01), no need to look them up again:

| Thing | Value |
|---|---|
| Caddy's Docker network | `uzy_default` |
| Caddyfile on the host | `/opt/Uzy/caddy/Caddyfile` |
| Caddyfile inside the container | `/etc/caddy/Caddyfile` (bind-mounted) |
| **Site-block drop-in dir** | **`/opt/Uzy/caddy/conf.d/`** → `/etc/caddy/conf.d/` |
| Caddy container | `uzy-caddy-1` |

Both paths are bind-mounted, so editing on the host is immediately visible to
the container — no rebuild, no copy step.

Line 20 of the Caddyfile is `import /etc/caddy/conf.d/*.caddy`. **This
service's site block belongs in `conf.d`, never in the Caddyfile itself** —
see the warning in Step 4. The filename must end in `.caddy` or the import
glob will not pick it up.

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

**No domain yet?** Use a `nip.io` hostname. `<ip>.nip.io` resolves to that IP
with no DNS setup, and because it is a real hostname Caddy can obtain a genuine
Let's Encrypt certificate — unlike a bare IP, which Let's Encrypt will not issue
for. That keeps the mobile app working (Android and iOS both reject cleartext
HTTP by default) and stops the `x-api-key` header travelling in plaintext.

Everything below is scripted so there is nothing to hand-edit:

```bash
IP=$(curl -4 -s ifconfig.me)
HOST="$IP.nip.io"
echo "API will be at: https://$HOST"

# Point the API at its own public URL, then recreate to pick up .env
cd /opt/video-downloader-api
sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$HOST|" .env
grep '^PUBLIC_BASE_URL=' .env

# Drop the site block into conf.d. The main Caddyfile is NOT touched, so
# nothing here can affect the live uzy site, and a later Caddyfile restore
# cannot silently delete this service's block (see the warning below).
sudo tee /opt/Uzy/caddy/conf.d/video-downloader.caddy > /dev/null <<EOF
$HOST {
	reverse_proxy video_downloader_api:8000 {
		transport http {
			dial_timeout 30s
			response_header_timeout 900s
			read_timeout 900s
			write_timeout 900s
		}
	}
	request_body {
		max_size 10MB
	}
}
EOF

docker exec uzy-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec uzy-caddy-1 caddy reload  --config /etc/caddy/Caddyfile
docker compose -f docker-compose.vps.yml up -d --force-recreate
```

Certificate issuance takes a few seconds on the first request. If it fails with
a rate-limit error, `sslip.io` works the same way — swap the suffix and reload.

> ### ⚠️ Never append this block to the main Caddyfile
>
> Earlier versions of this guide told you to `tee -a` it onto
> `/opt/Uzy/caddy/Caddyfile` after taking a `.bak` copy. That combination
> took the API offline for 13 days:
>
> | When | What happened |
> |---|---|
> | 2026-09-11 05:24 | Caddy renews the certificate normally |
> | 2026-09-11 ~06:08 | A redeploy restores `Caddyfile.bak` — a copy taken **before** the block was appended, so the block vanishes while every `vidpex.com` block survives |
> | 2026-09-11 → 09-24 | API healthy and running, but Caddy has no site block for the hostname, so it has no certificate for that SNI |
>
> The symptom is a **TLS handshake failure**, not an HTTP error — Postman
> reports `TLSV1_ALERT_INTERNAL_ERROR ... SSL alert number 80` and
> `openssl s_client` reports `no peer certificate available`. It looks like an
> expired or broken certificate. It is not: alert 80 here means Caddy has **no
> site block for that hostname**, so there is nothing to serve.
>
> One command distinguishes it from every certificate problem:
>
> ```bash
> grep -rn "<your-hostname>" /opt/Uzy/caddy/Caddyfile /opt/Uzy/caddy/conf.d/
> ```
>
> No match means the block is gone. Recreate the `conf.d` file and reload — the
> certificate is still on disk under
> `/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/` and loads
> instantly, with no ACME round trip.
>
> Keeping the block in `conf.d` makes this unreachable: the main Caddyfile is
> never edited, so restoring it cannot remove this service.

Moving to a real domain later is a one-line change to that block plus a reload;
Caddy issues the new certificate itself.

---

**If you do have a domain:** point a DNS A record for `downloader.example.com`
at the VPS **first**, or Caddy's certificate request will fail.

Put the block from [`Caddyfile.snippet`](Caddyfile.snippet) in its own
`conf.d` file — again, **not** in the main Caddyfile — with your real subdomain
substituted:

```bash
sudo nano /opt/Uzy/caddy/conf.d/video-downloader.caddy
```

Then validate, and reload **only if validation passes**:

```bash
docker exec uzy-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec uzy-caddy-1 caddy reload  --config /etc/caddy/Caddyfile
```

If validation fails, fix or delete the file you just created and validate again
— do not reload a config that failed validation. Because the change is confined
to one drop-in file, there is no backup to restore and the live uzy site was
never at risk:

```bash
sudo rm /opt/Uzy/caddy/conf.d/video-downloader.caddy
```

**Use `reload`, never `restart`.** A reload is graceful and does not interrupt
the existing site; a restart drops connections. If `validate` fails, fix it
before reloading — do not reload a config that failed validation.

Caddy issues and renews TLS automatically. There is no certbot step.

## Step 5 — Verify from outside

```bash
IP=$(curl -4 -s ifconfig.me); BASE="https://$IP.nip.io"
API_KEY=$(grep '^API_KEY=' /opt/video-downloader-api/.env | cut -d= -f2)

curl "$BASE/api/health"

curl -H "x-api-key: $API_KEY" \
  "$BASE/api/download?url=https://www.dailymotion.com/video/xa1c774"
```

`/api/health` returning `"status":"ok"` over **https** means the certificate was
issued and the proxy is wired up.

Then open the existing uzy site and confirm it still works. **That is the check
that matters most.**

## Rollback

```bash
docker compose -f docker-compose.vps.yml down
```

Removes only this service. Then drop its site block and reload:

```bash
sudo rm -f /opt/Uzy/caddy/conf.d/video-downloader.caddy
docker exec uzy-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec uzy-caddy-1 caddy reload  --config /etc/caddy/Caddyfile
```

**Do not restore `Caddyfile.bak`.** That is what broke this service on
2026-09-11: the backup predates the site block, so restoring it removes this
API while looking like a clean rollback. Deleting the one `conf.d` file is the
complete and correct undo — the main Caddyfile was never edited, so there is
nothing in it to roll back.

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

**"Could not send request" / TLS errors from the client.** If Postman reports
`TLSV1_ALERT_INTERNAL_ERROR ... SSL alert number 80`, or `curl` fails with
`SSL connect error` while port 443 is open, the cause is almost never the
certificate. Work down this list:

```bash
# 1. Is the site block still configured? (the usual answer)
grep -rn "nip.io" /opt/Uzy/caddy/Caddyfile /opt/Uzy/caddy/conf.d/

# 2. Is Caddy serving the other sites? If yes, Caddy and TLS are healthy
#    and the problem is specific to this hostname.
curl -sI https://vidpex.com | head -1

# 3. Is the certificate still on disk? It survives even when the block does not.
docker exec uzy-caddy-1 ls /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/

# 4. Is the API container up and on Caddy's network?
docker ps --filter name=video_downloader_api
docker inspect video_downloader_api --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

No match on step 1 means the block was deleted — recreate
`/opt/Uzy/caddy/conf.d/video-downloader.caddy` from Step 4 and reload. The
certificate loads from disk instantly; there is no ACME wait and no rate-limit
risk.

Two red herrings worth naming, because both cost time during the 2026-09-11
incident:

- **A 308 redirect on port 80 does not prove the block exists.** Caddy
  redirects HTTP→HTTPS for *any* Host header, including hostnames it has never
  heard of. Test with a bogus host to confirm: `curl -I -H "Host: nope.example"
  http://<ip>/` returns the same 308.
- **Check `df -h` but do not assume a full disk.** Converted files are capped
  by `CACHE_TTL_SECONDS` and in practice sit in the tens of MB, not GB.

**Logs.** Capped at 3 × 10MB by the compose file.

```bash
docker compose -f docker-compose.vps.yml logs -f api
```

**Updating yt-dlp.** The image installs the `yt-dlp_linux` standalone asset,
which bundles `curl_cffi` for the browser impersonation some extractors now
require (Dailymotion among them). Do not switch this to the plain `yt-dlp`
release — it lacks curl_cffi and those extractors fail at request time. The
build runs `--list-impersonate-targets` so a wrong asset fails loudly.

Extractors break as sites change; rebuild periodically:

```bash
docker compose -f docker-compose.vps.yml build --no-cache api
docker compose -f docker-compose.vps.yml up -d
```

This rebuilds only this service and never touches Caddy or the uzy containers.
