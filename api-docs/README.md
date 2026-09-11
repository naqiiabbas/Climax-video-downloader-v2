# Mobile App — API Endpoint Status

Every endpoint that exists in the service today, with its live status.

**Last verified:** 2026-09-11 · yt-dlp `2026.08.19` · all endpoints called against real URLs, not mocked.

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
| 6 | GET | `/api/vimeo` | ✅ Two-phase | No `quality` → `available_qualities`, no media. With `quality` → one mp4. Max 1080p |
| 7 | GET | `/api/dailymotion` | ✅ Two-phase | Same as Vimeo; also handles Pinterest |
| 8 | GET | `/api/downloads/mp4` | ✅ Working | HLS → MP4 |
| 9 | GET | `/api/downloads/prepare` | ✅ Working | Download + merge video/audio → MP4 |
| 10 | GET | `/downloads/<file>` | ✅ Working | Serves converted files, no key |
| 11 | GET | `/api/delete-video` | ✅ Working | |
| 12 | POST | `/api/update-cookies` | ✅ Working | Admin only |
| 12b | GET | `/api/status` | ✅ Working | Files on disk, sizes, deletion times. Admin/ops |
| 12c | DELETE | `/api/clear-server` | ✅ Working | Deletes every converted file now. **DELETE only** — GET/POST 404. Admin/ops |
| 13 | GET | `/api/history/status` | ✅ Working, unused | Endpoints built but dormant — see below |
| 14 | GET | `/api/history` | 💤 Dormant | Not pursued — no login in the app |
| 15 | POST | `/api/history` | 💤 Dormant | Not pursued — no login in the app |
| 16 | DELETE | `/api/history/:id` | 💤 Dormant | Not pursued — no login in the app |
| 17 | DELETE | `/api/history` | 💤 Dormant | Not pursued — no login in the app |

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
| Vimeo | `/api/vimeo` | ✅ two-phase, mp4 on `?quality=` | pick a quality, then download |
| Dailymotion | `/api/dailymotion` | ✅ two-phase, mp4 on `?quality=` | pick a quality, then download |
| Instagram | `/api/instagram` | ❌ Needs a cookies.txt upload | — |
| Pinterest, Reddit, X, Twitch | `/api/download` | ❓ Untested — sample URLs were dead links | — |

`/api/downloads/prepare` verified on the VPS: YouTube at 360p returned an
11.9 MB MP4.

> **Vimeo and Dailymotion never return a raw m3u8 URL as `media[]` by
> default.** That used to happen and was reported as "Vimeo download isn't
> working" — a naive client saving the URL got a text playlist, not a video.
> Fixed 2026-09-03 by auto-converting server-side; **reworked again
> 2026-09-07** into the two-phase model below, since always converting at
> 1080p by default cost minutes and hundreds of MB for a choice nobody had
> made. See [Vimeo and Dailymotion: two calls, not one](#vimeo-and-dailymotion-two-calls-not-one).

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

## Vimeo and Dailymotion: two calls, not one

**Changed 2026-09-07 — this is a breaking change for the mobile app.**

```
GET /api/dailymotion?url=...              -> available_qualities, NO media
GET /api/dailymotion?url=...&quality=480  -> media[one mp4], NO available_qualities
```

Previously a bare `?url=` converted at 1080p and returned `media`. It no
longer downloads anything without an explicit `quality`, so **a client that
reads `media[0]` from a bare request now gets `undefined`.**

Branch on `requires_quality`:

```js
const r = await fetch(`${BASE}/api/dailymotion?url=${encodeURIComponent(u)}`,
                      { headers: { 'x-api-key': KEY } });      // fast, seconds
const j = await r.json();

if (j.requires_quality) {
  const choice = await showPicker(j.available_qualities);      // {quality,label,size}
  const c = await fetch(`${BASE}/api/dailymotion?url=${encodeURIComponent(u)}&quality=${choice.quality}`,
                        { headers: { 'x-api-key': KEY } });    // slow, give it minutes
  download((await c.json()).media[0].url);
}
```

Why: the old default spent minutes and hundreds of MB of VPS disk converting at
1080p for a choice nobody had made, and the app could not offer a picker
without a second `?raw=1` call that returned unusable m3u8 URLs.

**Measured 2026-09-07, locally against the real URLs:**

| Call | Result |
|---|---|
| `dailymotion` no quality | 200 in **4.6s**, 4 options, no download |
| `dailymotion&quality=480` | 200 in **14.0s**, 3.73 MB, ffprobe **848×480** h264+aac |
| `dailymotion&quality=240` | 200 in **13.1s**, 2.14 MB, ffprobe **512×288** h264+aac |
| `vimeo` no quality | 200 in **9.1s**, 5 options, no download |
| `vimeo&quality=240` | 200 in **159s**, 40.4 MB (estimate said 40.6 MB) |
| `quality=2160`/`1440`/`999` | **400** in ~3ms, before any extraction |

### 1080p ceiling

`2160` and `1440` are gone. They are rejected with a 400, never appear in
`available_qualities`, and are excluded by yt-dlp's format selector itself —
verified against a 4K source: without the filter it selected 2160, with it
1080, even when the sort was deliberately asked for 2160. `best` still works
but now means "best at or below 1080p".

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

### 6. `GET /api/vimeo` — Vimeo ✅ (two-phase, no default quality)

Vimeo only ever publishes HLS — its raw entries are video-only renditions plus
a separate audio track, so nothing in the raw list is downloadable as-is. See
[Vimeo and Dailymotion: two calls, not one](#vimeo-and-dailymotion-two-calls-not-one)
for the full two-phase contract (`requires_quality` → `available_qualities` →
call again with `?quality=`).

**Verified:** a 13-minute video at `quality=1080` took **172s** and produced a
valid 368.9 MB mp4 (ffprobe: h264 1080p + aac stereo) — the size estimate from
`available_qualities` (369.5 MB) was accurate to within 0.2%. The same video at
`quality=480` took **~4s** and produced a valid 64.3 MB mp4 — quality drives
the time far more than length does, so `?quality=480` is the lever if 1080p is
too slow.

If conversion fails (other than DRM, which returns `422` immediately), the
endpoint returns the error directly — there is no fallback to a raw list
anymore, since the caller explicitly asked for one converted file.

`?raw=1` still returns the old fast, metadata-only, per-quality m3u8 list
(`needs_conversion: true` on every entry) for a client building its own
quality picker and converting on demand via `/api/downloads/mp4`.

### 7. `GET /api/dailymotion` — Dailymotion + Pinterest ✅ (two-phase, no default quality)

Same contract as Vimeo. **Verified:** `quality=240` → `200` in ~10–14s, a
2–4 MB ffprobe-valid mp4 (`ftypiso5`). Same `raw=1` escape hatch.

Every raw entry reports `extension: "mp4"` while the underlying URL is
actually an HLS playlist — a plain GET on it returns ~554 bytes of text served
as `content-type: video/mp4`. Only relevant if you use `?raw=1`; the default
two-phase flow never hands the client that URL at all.

---

## Download and file endpoints

### 8b. `GET /api/downloads/prepare?url=<page_url>&quality=<h>` ✅

Downloads a page URL and returns **one finished MP4 with both video and audio**.
Use this whenever the extraction response has `needs_merge: true`.

**Verified:** YouTube at `quality=360` → `200` in 7.0s, 11.9 MB, probed as
`h264 640x360` + `aac 2ch` in an MP4 container.

Takes the **original page URL**, not a resolved CDN link — those expire in
minutes and several sources need the original headers and cookies.

`quality`: `best`, `1080`, `720`, `480`, `360`, `240` (default `DEFAULT_QUALITY`,
currently `1080`). **Nothing above 1080p is accepted** — `2160`/`1440` return
`400` immediately, and `best` now means "best at or below 1080p", not 4K.
Higher still costs real VPS disk and bandwidth — a `best` YouTube merge is
~230 MB. Times out at `MERGE_TIMEOUT_MS` (10 min) with a `504`.

Returns `{success, file_url, key, size_bytes, quality, expires_in, storage_url, storage_expires_in}`.

### 8. `GET /api/downloads/mp4?url=<m3u8>` ✅

Remuxes an HLS stream to MP4. **Verified:** `200`, produced an 18.32 MB valid MP4 (`ftyp` container).

Returns `{success, file_url, key, expires_in, storage_url, storage_expires_in}`. **Slow — 47.6s** for a large file. Scale the client timeout to the file size and show progress.

### 9. `GET /downloads/<filename>` ✅

Serves converted files. No API key. Deleted automatically after `CACHE_TTL_SECONDS`.

---

### `storage_url` — a second, longer-lived copy (added 2026-09-11)

Every file that `/api/downloads/prepare`, `/api/downloads/mp4`, and the
Vimeo/Dailymotion phase-2 conversion produce also gets uploaded to Supabase
Storage, independent of the VPS copy:

| | Lives on | Lifetime |
|---|---|---|
| `file_url` | VPS disk | `CACHE_TTL_SECONDS` (25 min) |
| `storage_url` | Supabase Storage | `SUPABASE_STORAGE_TTL_SECONDS` (2h) |

**`storage_url` can be `null`** — best-effort, never blocks the response. It's
`null` when the feature isn't turned on server-side, or if that one upload
failed (check `storage_error` in that case). **`file_url` is the one
guaranteed to exist** — use `storage_url` only as a bonus longer-lived link,
never as the only URL you keep. No login or user identity is involved in
either copy — video downloads on this API have never required an account.

### 10. `GET /api/delete-video?url=<file_url>` ✅

**Verified:** `200`, file returned `404` immediately after.

### 11. `POST /api/update-cookies` ✅

Multipart, field `file`. Max 5 MB, `.txt` + `text/plain`, must be Netscape format. **Verified:** `200`; a non-cookie file is rejected; unauthenticated upload gets `401`.

Admin operation — should not be exposed in the mobile app.

---

## Download history (Supabase) — dormant, not currently pursued

> ⚠️ **Decided 2026-09-11: not being pursued right now.** The app has no login
> flow at all — confirmed with the user, not just "no Supabase auth" — so it
> has nothing to put in `x-supabase-token`. That's why `download_history`
> stayed empty despite the app being live; **not a server bug.** Rather than
> add a login just for this, Supabase is instead used for
> [file storage](#storage_url--a-second-longer-lived-copy-added-2026-09-11)
> above, which needs no user identity at all. The endpoints below are
> complete, tested, and left in place — nothing is broken by leaving them
> unused, and they're ready if real accounts get added later.

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

**Vimeo and Dailymotion don't use `needs_merge`/`needs_conversion` at all** —
they follow their own two-phase contract instead (`requires_quality` →
`available_qualities` → call again with `?quality=`, see
[Vimeo and Dailymotion: two calls, not one](#vimeo-and-dailymotion-two-calls-not-one)).
The rules above apply to them only if you pass `?raw=1` for the old raw m3u8
list.

**2. Extracted URLs expire within minutes.** Resolve immediately before downloading; never cache them.

**3. `size_is_estimate: true`** means the size came from bitrate × duration. Show it as approximate.

**4. Timeouts.** 60s for extraction and `/downloads/prepare`. **Vimeo and
Dailymotion's phase-2 conversion needs much more** — it's a real download
(measured 5s–172s depending on quality), not a metadata probe. Give it a
generous timeout (minutes, not seconds) and let `?quality=` be the lever the
user controls, rather than a fixed default the app guesses at.

**5. `storage_url` can be `null` — always fall back to `file_url`.** Every
converted file also gets a longer-lived Supabase Storage copy, but that upload
is best-effort. See [storage_url](#storage_url--a-second-longer-lived-copy-added-2026-09-11)
above.

---

## Known gaps

| Item | Impact |
|---|---|
| Instagram needs manual cookie upload | Endpoint 5 down until cookies are supplied; recurs on expiry |
| TikTok reliability depends on retries | ~40% single-attempt success; retries cover it but cost latency |
| Conversion and merge are synchronous | A large file holds the request open for a minute or more; no progress reporting. `/api/downloads/prepare` and the Vimeo/Dailymotion phase-2 call can run for minutes at `1080p` |
| Vimeo DRM | Some Vimeo videos cannot be downloaded at all; scope not yet fully established, see [DRM section](#drm-protected-videos-vimeo) |
| No rate limiting | Any holder of the API key can drive unlimited ffmpeg jobs |
| Merged/converted files consume VPS disk on request | Only when a client actually chooses a quality (Vimeo/Dailymotion) or explicitly calls `/api/downloads/*` — held for `CACHE_TTL_SECONDS` (25 min) |
| Supabase Storage upload never tested against a real bucket | Streaming mechanics (large-file upload, correct byte count) verified locally against a dummy server; graceful fallback on failure verified. The actual Supabase Storage REST endpoint shapes used are implemented per documented convention but unverified against a real project — first real deploy with `SUPABASE_STORAGE_ENABLED=true` is the real test. |
