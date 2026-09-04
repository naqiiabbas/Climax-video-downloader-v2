# Mobile App — API Endpoint Status

Every endpoint that exists in the service today, with its live status.

**Last verified:** 2026-09-03 · yt-dlp `2026.08.19` · all endpoints called against real URLs, not mocked.

Full request/response reference: [../docs/API.md](../docs/API.md)
Postman collection: [../docs/postman_collection.json](../docs/postman_collection.json)

---

## Base URL

| Environment | URL |
|---|---|
| **Production** | **`https://82.29.152.245.nip.io`** |
| Local | `http://localhost:8000` |

Live since 2026-09-01. There is no domain yet, so the host is a `nip.io`
hostname that resolves to the VPS IP — it carries a real Let's Encrypt
certificate, so normal HTTPS applies and no cleartext exemption is needed on
Android or iOS.

When a domain is bought, this changes in two places (the Caddy site block and
`PUBLIC_BASE_URL`) and the old URL stops working — so read it from config in
the app rather than hardcoding it.

## Authentication

Send the API key on every endpoint except `GET /` and `GET /api/health`. Either header works:

```
x-api-key: <API_KEY>
Authorization: Bearer <API_KEY>
```

Verified: no key → `401`, wrong key → `403`, bearer accepted → passes through.

---

## Status summary

**11 of 12 working.** Instagram is the only one down.

| # | Method | Endpoint | Status | Notes |
|---|---|---|---|---|
| 1 | GET | `/` | ✅ Working | Service banner |
| 2 | GET | `/api/health` | ✅ Working | Open, no key needed. Reports cookie *usability* |
| 3 | GET | `/api/download` | ✅ Working | Universal (Facebook, YouTube, X, Reddit…) |
| 4 | GET | `/api/tiktok` | ⚠️ Working, slow | 5–20s, retries internally |
| 5 | GET | `/api/instagram` | ❌ **Not working** | Needs a valid `cookies.txt` |
| 6 | GET | `/api/vimeo` | ⚠️ Working, but **DRM-blocked on some videos** | Slow (5–170s+); `?raw=1`/`?quality=` available. See [DRM](#drm-protected-videos-vimeo) |
| 7 | GET | `/api/dailymotion` | ✅ Working, auto-converts | Also handles Pinterest; same params as Vimeo |
| 8 | GET | `/api/downloads/mp4` | ✅ Working | HLS → MP4 |
| 9 | GET | `/api/downloads/prepare` | ✅ Working | Download + merge video/audio → MP4 |
| 10 | GET | `/downloads/<file>` | ✅ Working | Serves converted files, no key |
| 11 | GET | `/api/delete-video` | ✅ Working | |
| 12 | POST | `/api/update-cookies` | ✅ Working | Admin only |
| 13 | GET | `/api/history/status` | ✅ Working | Is history configured? |
| 14 | GET | `/api/history` | ⚙️ Needs setup | Caller's own history |
| 15 | POST | `/api/history` | ⚙️ Needs setup | Record a download |
| 16 | DELETE | `/api/history/:id` | ⚙️ Needs setup | Delete one entry |
| 17 | DELETE | `/api/history` | ⚙️ Needs setup | Clear all |

---

## Platform coverage

**Measured on the production VPS (datacenter IP), 2026-09-01.** The datacenter
IP turned out not to hurt — nothing was bot-blocked, and TikTok was markedly
*faster* there than in local testing.

| Platform | Endpoint | Status | Client path |
|---|---|---|---|
| YouTube | `/api/download` | ✅ 2.9s, 14 formats | `needs_merge` → **prepare** |
| Facebook | `/api/download` | ✅ 2.9s, 5 formats | 2 direct downloads |
| TikTok | `/api/tiktok` | ✅ 2.3s, 4 formats | 3 direct downloads |
| Vimeo | `/api/vimeo` | ⚠️ auto-converts when not DRM'd (5–170s+) | ready to download, **or 422 `drm_protected`** |
| Dailymotion | `/api/dailymotion` | ✅ auto-converts to mp4 (~11s) | ready to download |
| Instagram | `/api/instagram` | ❌ Needs a cookies.txt upload | — |
| Pinterest, Reddit, X, Twitch | `/api/download` | ❓ Untested — sample URLs were dead links | — |

`/api/downloads/prepare` verified on the VPS: YouTube at 360p returned an
11.9 MB MP4.

> **Vimeo and Dailymotion auto-convert as of 2026-09-03.** Both used to return
> a raw m3u8 playlist that a naive client would save as a broken "video" — that
> was reported as "Vimeo download isn't working" and is the same bug as the
> m3u8-format complaint. By default both endpoints now download and remux
> server-side and hand back one ready `.mp4` link, with `needs_merge: false`.
> **This makes those two endpoints slow** — a real download, not a metadata
> probe (measured 5s–172s depending on length/quality) — so give them a much
> longer client timeout than the others, or pass `?quality=480` to bound it.
> `?raw=1` restores the old fast, metadata-only, per-quality list. Full
> details in [docs/API.md](../docs/API.md#auto-conversion--vimeo-and-dailymotion-only).

Anything else yt-dlp supports should work through `/api/download`, but only the
rows above have actually been exercised.

## DRM-protected videos (Vimeo)

**Found 2026-09-04.** Vimeo now serves FairPlay/Widevine-encrypted CBCS streams
for at least some videos and publishes **no progressive mp4** alongside them, so
every delivery route is encrypted. Confirmed against Vimeo's own demo video
`76979871` — its player config reports `progressive: 0` and `DRM = true` on all
four CDN routes (hls + dash × two CDNs), and the playlist carries:

```
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm",KEYFORMAT="com.apple.streamingkeydelivery"
```

yt-dlp reads the manifest, so extraction still returns a full `media[]` with
real resolutions and sizes — it just cannot decrypt the segments. This is a
permanent property of the video, not a transient failure.

The server now detects it from the CDN URLs and **skips the doomed download**
rather than spending a minute discovering it:

```json
{ "drm_protected": true,
  "auto_converted": false,
  "error_code": "drm_protected",
  "auto_convert_error": "This video is DRM protected and cannot be downloaded." }
```

Status is **422**. `/api/downloads/mp4` and `/api/downloads/prepare` return the
same code, and `/api/downloads/mp4` checks the playlist before downloading —
previously it would have cached an unplayable file and reported `success: true`.

**Client:** branch on `error_code === "drm_protected"` and show "this video is
protected and cannot be downloaded". Do not retry, and do not offer a lower
quality — every route fails identically.

**Scope: per-video, not Vimeo-wide** — measured on the production VPS
2026-09-04. `1160592223` still auto-converts normally (`drm_protected: false`,
a valid 64.3 MB h264 mp4 at `quality=480`), while `76979871` is DRM'd. So
`/api/vimeo` remains a working feature; expect an occasional 422 rather than a
broken endpoint, and re-check if the rate of DRM'd videos climbs.

Note this is distinct from the **401** case (e.g. `1071084785`): that video is
publicly viewable but embed-restricted by its owner, so extraction itself fails
and `media[]` comes back empty with a 502.

---

## Extraction endpoints

All take the link as `?url=<encoded>` and return `{url, source, author, title, thumbnail, duration, media[]}`.

### 3. `GET /api/download` — Universal ✅

Any yt-dlp-supported site. **Verified:** Facebook reel → `200` in 2.6s, 5 formats, 2 directly downloadable with audio.

### 4. `GET /api/tiktok` — TikTok ⚠️

**Verified:** `200` in 16.6s, 4 formats, 3 directly downloadable with audio.

TikTok rate-limits anonymous extraction — a single attempt succeeds only ~40% of the time (measured over 16 runs). The server retries up to `TIKTOK_RETRIES` (default 8), which took a 6-run sample to 6/6. **Expect 5–20s** and use a 60s client timeout. A 500 here is worth one client-side retry.

Each entry carries `headers` and `cookies` that the client **must replay** on the download request, or the CDN returns 403.

### 5. `GET /api/instagram` — Instagram ❌

**Verified:** `500`. Instagram returns an empty media response to anonymous requests.

```
ERROR: [Instagram] Instagram sent an empty media response.
```

**To fix:** upload a Netscape-format `cookies.txt` exported from a logged-in browser (endpoint 11). Cookies expire in roughly weeks and must be re-uploaded. `npm run refresh-cookies` can regenerate them from `IG_USERNAME`/`IG_PASSWORD`, but Instagram frequently answers automated logins with a checkpoint or captcha that only a human can clear.

**Treat Instagram as best-effort in the app** — surface a clear "temporarily unavailable" message rather than a generic error.

### 6. `GET /api/vimeo` — Vimeo ✅ (auto-converts)

Vimeo only ever publishes HLS — its raw entries are video-only renditions plus
a separate audio track, so **by default** the endpoint downloads and remuxes
server-side and returns one ready `.mp4`:

```json
{ "needs_merge": false, "auto_converted": true,
  "media": [{ "url": "https://.../downloads/video_....mp4", "quality": "1080",
              "has_video": true, "has_audio": true, "protocol": "https",
              "needs_conversion": false, "size": "368.90 MB" }] }
```

**Verified:** a 13-minute video at the default `quality=1080` took **172s** and
produced a valid 368.9 MB mp4 (ffprobe: h264 1080p + aac stereo) — the size
estimate from the raw listing (369.5 MB) was accurate to within 0.2%.

Quality dominates that number far more than length does. The same 13-minute
video at `quality=480` produced a valid 64.3 MB mp4 in **~4 seconds** on the
VPS (2026-09-04). The "give Vimeo minutes" advice is really about 1080p, not
about the endpoint — passing `?quality=480` makes it comparable to the
metadata-only endpoints.

Pass `?quality=480` (or lower) to trade quality for speed, or `?raw=1` for the
old fast per-quality m3u8 list (`needs_conversion: true` on every entry) if you
want to build your own quality picker and convert on demand via
`/api/downloads/mp4`.

If server-side conversion fails, the endpoint falls back to the raw list rather
than erroring — check `auto_converted` (`false` means you got the raw list;
`auto_convert_error` says why).

### 7. `GET /api/dailymotion` — Dailymotion + Pinterest ✅ (auto-converts)

Same behavior as Vimeo — **verified:** `200` in ~11s, single ready mp4, 11.92 MB
(ffprobe-valid, `ftypiso5`). Same `quality` and `raw=1` params, same
graceful-fallback behavior on conversion failure.

Previously every entry reported `extension: "mp4"` while the URL was actually
an HLS playlist — a plain GET returned ~554 bytes of text served as
`content-type: video/mp4`. That is fixed now by not handing the client the raw
playlist URL at all in the default response.

---

## Download and file endpoints

### 8b. `GET /api/downloads/prepare?url=<page_url>&quality=<h>` ✅

Downloads a page URL and returns **one finished MP4 with both video and audio**.
Use this whenever the extraction response has `needs_merge: true`.

**Verified:** YouTube at `quality=360` → `200` in 7.0s, 11.9 MB, probed as
`h264 640x360` + `aac 2ch` in an MP4 container.

Takes the **original page URL**, not a resolved CDN link — those expire in
minutes and several sources need the original headers and cookies.

`quality`: `best`, `2160`, `1440`, `1080`, `720`, `480`, `360`, `240`
(default `DEFAULT_QUALITY`, currently `1080`). Higher costs real VPS disk and
bandwidth — a `best` YouTube merge is ~230 MB. Times out at
`MERGE_TIMEOUT_MS` (10 min) with a `504`.

Returns `{success, file_url, key, size_bytes, quality, expires_in}`.

### 8. `GET /api/downloads/mp4?url=<m3u8>` ✅

Remuxes an HLS stream to MP4. **Verified:** `200`, produced an 18.32 MB valid MP4 (`ftyp` container).

Returns `{success, file_url, key, expires_in}`. **Slow — 47.6s** for a large file. Scale the client timeout to the file size and show progress.

### 9. `GET /downloads/<filename>` ✅

Serves converted files. No API key. Deleted automatically after `CACHE_TTL_SECONDS` (default 1h).

### 10. `GET /api/delete-video?url=<file_url>` ✅

**Verified:** `200`, file returned `404` immediately after.

### 11. `POST /api/update-cookies` ✅

Multipart, field `file`. Max 5 MB, `.txt` + `text/plain`, must be Netscape format. **Verified:** `200`; a non-cookie file is rejected; unauthenticated upload gets `401`.

Admin operation — should not be exposed in the mobile app.

---

## Download history (Supabase)

Per-user history, stored in Supabase Postgres. Two headers are required:

```
x-api-key:        <API_KEY>                 as on every endpoint
x-supabase-token: <user's access token>     from the app's Supabase session
```

The second one is what makes history per-user. The server holds only the **anon**
key and forwards the caller's own token to PostgREST, so row-level security
decides what they can see. Consequences worth knowing:

- A user id **cannot be forged**. Holding this API's key is not enough to read
  someone else's history — you need that user's Supabase session.
- No `service_role` key sits on the VPS, so compromising it does not expose the
  database.
- An expired session returns **401**. Refresh the Supabase session and retry.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/history/status` | `{enabled}` — no user token needed. Use it to decide whether to show a History tab |
| GET | `/api/history?limit=50&offset=0` | Caller's entries, newest first. `limit` caps at 200 |
| POST | `/api/history` | Record one completed download |
| DELETE | `/api/history/:id` | Delete one entry |
| DELETE | `/api/history` | Clear the caller's history |

`POST` body — only `page_url` is required, the rest come straight from the
extraction response:

```json
{
  "page_url": "https://www.youtube.com/watch?v=...",
  "source": "Youtube",
  "title": "...",
  "author": "...",
  "thumbnail": "https://...",
  "duration": 213,
  "quality": "720",
  "file_size_bytes": 11903240
}
```

Unknown fields are ignored rather than written, so a client cannot inject
arbitrary columns.

### Server setup (once)

1. Run [`supabase/schema.sql`](../supabase/schema.sql) in the Supabase SQL Editor.
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env`, then recreate the
   container.

Until both are done, every history endpoint returns **503** and
`/api/history/status` reports `enabled: false`. Nothing else is affected.

## What the mobile client must handle

**1. Never blindly take `media[0]`.** Three fields decide usability:

| Field | Meaning if wrong |
|---|---|
| `has_audio: false` | Silent video-only track — user gets no sound |
| `has_video: false` | Audio-only track |
| `needs_conversion: true` | URL is a **playlist, not a file** — a plain GET saves a few KB of text |

```js
if (res.needs_merge) {
  // YouTube: no entry has both tracks. Let the server download and merge.
  return `/api/downloads/prepare?url=${encodeURIComponent(pageUrl)}&quality=720`;
}
const direct = media.find(m => m.has_video && m.has_audio && !m.needs_conversion);
const convert = media.find(m => m.has_video && m.has_audio && m.needs_conversion);
// use `direct` if present; otherwise send convert.url to /api/downloads/mp4
```

The top-level **`needs_merge: true`** means no single entry carries both video
and audio, so `/api/downloads/prepare` is the only way to get a usable file.

**Vimeo and Dailymotion no longer need any of this by default** — as of
2026-09-03 both auto-convert server-side and hand back one ready mp4 in
`media[0]` (`needs_merge: false`, `needs_conversion: false`). The rules above
only apply to them if you pass `?raw=1` to get the old raw m3u8 list back.

**2. Extracted URLs expire within minutes.** Resolve immediately before downloading; never cache them.

**3. `size_is_estimate: true`** means the size came from bitrate × duration. Show it as approximate.

**4. Timeouts.** 60s for extraction and `/downloads/prepare`. **Vimeo and
Dailymotion need much more** — their default auto-conversion is a real
download (measured 5s–172s), not a metadata probe. Give those two a generous
timeout (minutes, not seconds) or pass `?quality=480` to bound the work, or
`?raw=1` to skip conversion and get a fast response back.

---

## Known gaps

| Item | Impact |
|---|---|
| Instagram needs manual cookie upload | Endpoint 5 down until cookies are supplied; recurs on expiry |
| TikTok reliability depends on retries | ~40% single-attempt success; retries cover it but cost latency |
| Conversion and merge are synchronous | A large file holds the request open for a minute or more; no progress reporting. `/api/downloads/prepare`, and now `/api/vimeo`/`/api/dailymotion` by default, can run for minutes at `best`/`1080` |
| Vimeo DRM | Some Vimeo videos cannot be downloaded at all; scope not yet established |
| No rate limiting | Any holder of the API key can drive unlimited ffmpeg jobs |
| Merged/converted files consume VPS disk on every call | Was opt-in (only when a client explicitly requested conversion); as of 2026-09-03 every default `/api/vimeo` and `/api/dailymotion` call writes one, held for `CACHE_TTL_SECONDS`. `?raw=1` avoids this. |
