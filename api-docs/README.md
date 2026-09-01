# Mobile App — API Endpoint Status

Every endpoint that exists in the service today, with its live status.

**Last verified:** 2026-09-01 · yt-dlp `2026.08.19` · all endpoints called against real URLs, not mocked.

Full request/response reference: [../docs/API.md](../docs/API.md)
Postman collection: [../docs/postman_collection.json](../docs/postman_collection.json)

---

## Base URL

| Environment | URL |
|---|---|
| Local | `http://localhost:8000` |
| Production | `https://<your-domain>` (set `PUBLIC_BASE_URL`) |

## Authentication

Send the API key on every endpoint except `GET /` and `GET /api/health`. Either header works:

```
x-api-key: <API_KEY>
Authorization: Bearer <API_KEY>
```

Verified: no key → `401`, wrong key → `403`, bearer accepted → passes through.

---

## Status summary

**9 of 10 working.** Instagram is the only one down.

| # | Method | Endpoint | Status | Notes |
|---|---|---|---|---|
| 1 | GET | `/` | ✅ Working | Service banner |
| 2 | GET | `/api/health` | ✅ Working | Open, no key needed |
| 3 | GET | `/api/download` | ✅ Working | Universal (Facebook, YouTube, X, Reddit…) |
| 4 | GET | `/api/tiktok` | ⚠️ Working, slow | 5–20s, retries internally |
| 5 | GET | `/api/instagram` | ❌ **Not working** | Needs a valid `cookies.txt` |
| 6 | GET | `/api/vimeo` | ⚠️ Working, conversion required | HLS only |
| 7 | GET | `/api/dailymotion` | ⚠️ Working, conversion required | HLS only. Also handles Pinterest |
| 8 | GET | `/api/downloads/mp4` | ✅ Working | HLS → MP4 |
| 9 | GET | `/downloads/<file>` | ✅ Working | Serves converted files, no key |
| 10 | GET | `/api/delete-video` | ✅ Working | |
| 11 | POST | `/api/update-cookies` | ✅ Working | Admin only |

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

### 6. `GET /api/vimeo` — Vimeo ⚠️

**Verified:** `200` in 7.4s, 8 qualities (240p–2160p). **All 8 need conversion** — zero directly downloadable.

### 7. `GET /api/dailymotion` — Dailymotion + Pinterest ⚠️

**Verified:** `200` in 4.7s, 4 qualities (288p–1080p). **All 4 need conversion.**

Entries report `extension: "mp4"` but the URL is an HLS playlist. A plain GET returns ~554 bytes of text served as `content-type: video/mp4`.

---

## Download and file endpoints

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

## What the mobile client must handle

**1. Never blindly take `media[0]`.** Three fields decide usability:

| Field | Meaning if wrong |
|---|---|
| `has_audio: false` | Silent video-only track — user gets no sound |
| `has_video: false` | Audio-only track |
| `needs_conversion: true` | URL is a **playlist, not a file** — a plain GET saves a few KB of text |

```js
const direct = media.find(m => m.has_video && m.has_audio && !m.needs_conversion);
const convert = media.find(m => m.has_video && m.has_audio && m.needs_conversion);
// use `direct` if present; otherwise send convert.url to /api/downloads/mp4
```

**Vimeo and Dailymotion have no direct option at all** — conversion is the only path.

**2. Extracted URLs expire within minutes.** Resolve immediately before downloading; never cache them.

**3. `size_is_estimate: true`** means the size came from bitrate × duration. Show it as approximate.

**4. Timeouts.** 60s for extraction; longer for `/api/downloads/mp4`.

---

## Known gaps

| Item | Impact |
|---|---|
| Instagram needs manual cookie upload | Endpoint 5 down until cookies are supplied; recurs on expiry |
| TikTok reliability depends on retries | ~40% single-attempt success; retries cover it but cost latency |
| Conversion is synchronous | A large file holds the request ~48s; no progress reporting |
| No rate limiting | Any holder of the API key can drive unlimited ffmpeg jobs |
| Docker image unverified | Built config is untested — Docker was not running on the dev machine |
