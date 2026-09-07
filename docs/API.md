# Video Downloader API

Base URL: `https://<your-domain>` (local: `http://localhost:8000`)

All extraction endpoints accept the target link as `?url=` or as `{"url": "..."}`
in a JSON body. The value is URL-decoded server-side.

## Authentication

Every endpoint except `GET /` and `GET /api/health` requires a header. Either
form works:

```
x-api-key: <API_KEY from .env>
Authorization: Bearer <API_KEY from .env>
```

| Response | Meaning |
|---|---|
| `401 {"success":false,"message":"Missing API key"}` | Header absent |
| `403 {"success":false,"message":"Invalid API key"}` | Wrong key |
| `500 {"message":"Server misconfigured: API_KEY is not set"}` | `API_KEY` empty on the server |

A key embedded in a mobile binary is extractable. This throttles casual abuse of
the yt-dlp workers; it is not user authentication.

## Extraction endpoints

| Method | Path | Source |
|---|---|---|
| GET | `/api/download` | Universal — any yt-dlp-supported site |
| GET | `/api/tiktok` | TikTok (adds `--geo-bypass`) |
| GET | `/api/instagram` | Instagram (uses cookies.txt) |
| GET | `/api/vimeo` | Vimeo (custom extractor). **Auto-converts to mp4 by default** — see below |
| GET | `/api/dailymotion` | Dailymotion **and** Pinterest. **Auto-converts to mp4 by default** — see below |

### Request

```
GET /api/tiktok?url=https%3A%2F%2Fwww.tiktok.com%2F%40user%2Fvideo%2F123
x-api-key: <key>
```

### Response `200`

```json
{
  "url": "https://www.tiktok.com/@user/video/123",
  "source": "TikTok",
  "author": "user",
  "title": "Clip title",
  "thumbnail": "https://...jpg",
  "duration": 45,
  "media": [
    {
      "url": "https://v16-webapp-prime.us.tiktok.com/video/...",
      "format_id": "download_addr-0",
      "quality": "720p",
      "extension": "mp4",
      "type": "video",
      "has_video": true,
      "has_audio": true,
      "protocol": "https",
      "needs_conversion": false,
      "size_bytes": 2411724,
      "size": "2.30 MB",
      "size_is_estimate": false
    }
  ]
}
```

### Picking an entry — read this before implementing the client

`media[]` is sorted best-first, but **do not blindly take index 0**. Three
fields decide whether an entry is usable:

| Field | Meaning |
|---|---|
| `has_audio` | `false` means a silent, video-only adaptive track. Facebook and Vimeo both return these. Saving one gives the user a video with no sound. |
| `has_video` | `false` means an audio-only track. |
| `needs_conversion` | `true` means `url` is an **HLS playlist, not a file**. A plain GET downloads a few KB of text. Send it to `/api/downloads/mp4` first. |
| `protocol` | `"https"` (direct file) or `"m3u8"` (playlist). Mirrors `needs_conversion`. |

The straightforward client rule:

```js
const direct = media.find(m => m.has_video && m.has_audio && !m.needs_conversion);
const viaConversion = media.find(m => m.has_video && m.has_audio && m.needs_conversion);
// prefer `direct`; otherwise POST viaConversion.url to /api/downloads/mp4
```

Dailymotion and Vimeo publish HLS (m3u8) only — never a direct file — so by
default `/api/dailymotion` and `/api/vimeo` **convert server-side and return one
ready mp4** instead of the raw playlist list. See the dedicated section below;
you do not need the rule above for these two sources unless you pass `?raw=1`.

Other notes:

- `type` (`"video"`/`"audio"`) is retained for backwards compatibility;
  `has_video`/`has_audio` are more precise since an adaptive video track is
  still `type: "video"`.
- One entry per quality bucket, keyed by resolution. Progressive streams
  (audio+video muxed) outrank video-only ones, mp4 outranks webm, higher
  bitrate breaks ties.
- `size_is_estimate: true` means the size was computed from bitrate × duration
  because the source did not report one. Treat it as approximate.
- **TikTok only** also returns `media[].headers` and `media[].cookies`. The
  client **must** replay those headers on the download request or the CDN
  returns 403.

### Vimeo and Dailymotion are two-phase

Both sources publish HLS only, so nothing they return is downloadable as-is: a
plain `GET` on an m3u8 URL saves a ~30 KB text playlist, not a video. These two
endpoints therefore convert server-side — but **only when you ask for a
specific quality**.

| Request | Response |
|---|---|
| `?url=...` | metadata + `available_qualities`, **no `media`** |
| `?url=...&quality=480` | metadata + `media` (one ready mp4), **no `available_qualities`** |
| `?url=...&raw=1` | the raw per-quality m3u8 list (escape hatch) |

**Phase 1 — ask what is available.** A metadata probe only: no download, no
disk written, a few seconds.

```json
{
  "url": "https://www.dailymotion.com/video/xa1c774",
  "source": "Dailymotion",
  "title": "...", "author": "...", "thumbnail": "...", "duration": 51,
  "requires_quality": true,
  "drm_protected": false,
  "available_qualities": [
    { "quality": "1080", "label": "1080p", "height": 1080, "size_bytes": 39662700, "size": "37.83 MB", "size_is_estimate": true },
    { "quality": "720",  "label": "720p",  "height": 720,  "size_bytes": 13701660, "size": "13.07 MB", "size_is_estimate": true },
    { "quality": "480",  "label": "480p",  "height": 480,  "size_bytes": 5331285,  "size": "5.08 MB",  "size_is_estimate": true },
    { "quality": "240",  "label": "288p",  "height": 288,  "size_bytes": 2936070,  "size": "2.80 MB",  "size_is_estimate": true }
  ]
}
```

**Phase 2 — convert the one the user picked.**

```json
{
  "url": "https://www.dailymotion.com/video/xa1c774",
  "source": "Dailymotion", "title": "...", "duration": 51,
  "requires_quality": false,
  "needs_merge": false,
  "auto_converted": true,
  "drm_protected": false,
  "quality": "480",
  "media": [
    {
      "url": "https://your-domain/downloads/video_1788772518022.mp4",
      "quality": "480", "extension": "mp4", "type": "video",
      "has_video": true, "has_audio": true,
      "protocol": "https", "needs_conversion": false,
      "size_bytes": 3912226, "size": "3.73 MB", "size_is_estimate": false
    }
  ]
}
```

**There is no default quality.** A request without `quality` never downloads
anything. Converting at 1080p because the caller stayed silent spent minutes
and hundreds of MB of VPS disk on a choice the user had not made, and left the
client unable to offer a picker without a second request.

Branch on **`requires_quality`**: `true` means show the picker, `false` means
`media[0].url` is a finished file.

Other behaviour worth knowing:

- An unrecognised `quality` is now a **400** with `error_code:
  "invalid_quality"`, rejected in milliseconds before any extraction runs. It
  used to be silently swapped for the default, so you got a different quality
  than you asked for with no indication.
- A conversion failure is a real error status (422 for DRM, 504 for timeout,
  500 otherwise) with an `error_code`. It no longer degrades to a 200 carrying
  the raw m3u8 list — with `media` gone from the default response there is
  nothing usable to degrade to.
- `raw=1` is unchanged and still returns the per-quality m3u8 list, marked
  `raw: true`, for a client that wants to convert on demand via
  `/api/downloads/mp4`.
- Conversion time tracks quality far more than length. The 51-second
  Dailymotion clip above took ~14s at 480p; a 13-minute Vimeo video took 159s
  at 240p because Vimeo's HLS fetch is slow. Give phase 2 a generous timeout;
  phase 1 answers in seconds.

### Choosing a quality

`quality` is what triggers conversion on `/api/vimeo` and `/api/dailymotion` —
without it they return the menu instead of a file:

```
GET /api/dailymotion?url=<encoded>&quality=480
```

Every response — converted or raw — carries **`available_qualities`**, the
values worth offering for that particular video, so a picker needs one request
rather than a second `?raw=1` call:

```json
"available_qualities": [
  { "quality": "1080", "label": "1080p", "height": 1080,
    "size_bytes": 12497303, "size": "11.92 MB", "size_is_estimate": true },
  { "quality": "720",  "label": "720p",  "height": 720,  "size_bytes": 6200000,  "...": "..." },
  { "quality": "480",  "label": "480p",  "height": 480,  "size_bytes": 3100000,  "...": "..." }
]
```

- Send **`quality`**; display **`label`**. They differ when the source publishes
  an off-ladder height — a 380p rendition is reached with `quality=360`,
  because yt-dlp resolves `res:` to the nearest available height.
- Only values the endpoint accepts are listed, so every entry is safe to send.
- The list reflects renditions the source actually published, so it never
  offers a resolution the server cannot produce.
- `size_bytes` estimates the **converted** file from the source's video-only
  rendition, so the real mp4 is slightly larger once audio is merged —
  `size_is_estimate` is always `true`. Good enough to warn "this is 12 MB"
  before committing a phone to the download.
- `best` is always accepted but is never listed: it has no predictable size.
  It now means "the best at or below 1080p" — it can no longer reach 4K.
- **Nothing above 1080p is served.** `2160` and `1440` are rejected with a
  400, are never listed in `available_qualities`, and are excluded by the
  format selector itself, so even `best` on a 4K source returns 1080p. A 4K
  merge is ~230 MB per request on a box that also hosts Postgres and MinIO,
  and no mobile client benefits from it.

Quality drives conversion time far more than length does. A 13-minute Vimeo
video took ~4s at `quality=480` (64 MB) versus 172s at `quality=1080`
(369 MB), measured on the production VPS.

### DRM-protected videos

Vimeo has begun serving **FairPlay/Widevine-encrypted (CBCS) streams** for some
videos, with no progressive mp4 alongside — every delivery route is encrypted.
yt-dlp reads the manifest fine, which is why extraction still returns a full
`media[]` with real resolutions and sizes, but it cannot decrypt the segments.
Nothing can: the keys come from a licence server that requires a signed device
certificate.

When every entry is encrypted the response carries `drm_protected: true` and
the status is **422**:

```json
{
  "title": "...",
  "needs_merge": true,
  "media": [ ... entries that look normal but are encrypted ... ],
  "auto_converted": false,
  "drm_protected": true,
  "auto_convert_error": "This video is DRM protected and cannot be downloaded.",
  "error_code": "drm_protected"
}
```

**Branch on `error_code` / `drm_protected`, not on the status code.** Retrying,
lowering `quality`, passing `raw=1`, supplying cookies or updating yt-dlp will
all fail identically. Show the user "this video is protected and cannot be
downloaded" — it is a permanent property of the video, not a transient fault.

`/api/downloads/mp4` and `/api/downloads/prepare` return the same
`error_code: "drm_protected"` with a 422. `/api/downloads/mp4` checks the
playlist **before** downloading anything: without that check it would fetch the
encrypted segments, remux them, and hand back `success: true` and a file_url
pointing at an unplayable file.

Plain `#EXT-X-KEY:METHOD=AES-128` HLS encryption is **not** DRM — the key is an
ordinary HTTP fetch and those downloads still work.

### Error codes

Every failure that reaches the client now carries a stable `error_code`:

| `error_code` | Status | Meaning | Retry? |
|---|---|---|---|
| `drm_protected` | 422 | Encrypted content; no download is possible | Never |
| `download_timeout` | 504 | Exceeded `MERGE_TIMEOUT_MS` | Yes, at a lower `quality` |
| `download_failed` | 500 | yt-dlp failed; see `details` | Once |
| `no_output` | 500 | yt-dlp reported success but produced no file | Once |
| `cache_failed` | 500 | Server could not store the result | Once |
| `conversion_failed` | 500 | Unexpected non-yt-dlp error | Once |

The extraction endpoints also return `auto_convert_error_details` — the first
500 characters of yt-dlp's actual stderr. Previously this was discarded and
only the generic message survived, which made a DRM wall indistinguishable
from a server fault.

### Errors

| Code | Body |
|---|---|
| 400 | `{"error":"Missing URL"}` |
| 500 | `{"error":"yt-dlp execution failed","details":"..."}` |

## Download and merge (adaptive sources)

| Method | Path |
|---|---|
| GET | `/api/downloads/prepare?url=<page_url>&quality=<h>` |

Use this whenever the extraction response carries `needs_merge: true` — it means
no single entry has both video and audio, so nothing in `media[]` is usable on
its own. YouTube is the common case.

Pass the **original page URL**, not a resolved CDN link: those expire within
minutes and several sources require the original headers and cookies.

`quality` accepts `best`, `1080`, `720`, `480`, `360`, `240`
and defaults to `DEFAULT_QUALITY`. The server picks h264 + aac where available
so the result plays on any mobile client without re-encoding.

```json
{
  "success": true,
  "file_url": "https://your-domain/downloads/video_1788268008660.mp4",
  "key": "video_1788268008660.mp4",
  "size_bytes": 11903239,
  "quality": "360",
  "expires_in": 3600
}
```

Returns `504` if the job exceeds `MERGE_TIMEOUT_MS` (default 10 min). Higher
qualities cost real disk and bandwidth — a `best` YouTube merge is ~230 MB.

## HLS conversion

| Method | Path |
|---|---|
| GET | `/api/downloads/mp4?url=<m3u8-url>` |

Downloads the playlist, remuxes `.ts` → `.mp4` with ffmpeg, and stores it for
`CACHE_TTL_SECONDS` (default 3600).

```json
{
  "success": true,
  "file_url": "https://your-domain/downloads/video_1730000000000.mp4",
  "key": "video_1730000000000.mp4",
  "expires_in": 3600
}
```

Fetch `file_url` directly — the static route needs no API key. The file is
deleted automatically when the TTL expires.

## Maintenance

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | **Open.** `{status, uptime, cookies, cookies_detail, cachedVideos, timestamp}` |
| GET | `/api/status` | **Requires `x-api-key`.** Converted files on disk, their size and deletion times |
| DELETE | `/api/clear-server` | **Requires `x-api-key`. DELETE, not GET.** Removes every converted file immediately |
| POST | `/api/update-cookies` | Multipart, field `file`. Max 5 MB, `.txt` + `text/plain`, must be Netscape format |
| GET | `/api/delete-video?url=<file_url>` | Deletes a converted file before its TTL |
| GET | `/downloads/<filename>` | Static serving of converted files |
| GET | `/` | `{"service":"video-downloader-api","status":"running"}` |

`cookies` is `true` only when the jar is actually **usable**. `cookies_detail`
says why not: `ok`, `missing`, `empty`, `no-entries`, `not-netscape-format`.
Deployment creates an empty `cookies.txt` for the docker bind mount, so `empty`
is the normal starting state and only affects login-gated sources.

## Client notes

- **Extracted URLs are short-lived.** TikTok and Instagram links expire within
  minutes. Resolve immediately before downloading; do not cache them.
- **Extraction is slow.** yt-dlp can take 5–30s. Use a 60s client timeout;
  Nginx allows 300s. TikTok is the slowest of the metadata-only endpoints
  because the server retries internally against rate limiting (measured 5–20s).
  **Vimeo and Dailymotion are a different case** — they auto-convert by
  default (see above) and that is a real download, not a probe: 5–25s
  typically, up to several minutes for a long or high-quality video. Give
  those two endpoints a much longer timeout than the others, or pass
  `?quality=480` (or lower) to bound it.
- **TikTok fails intermittently by design of their anti-bot.** A single
  anonymous attempt succeeds ~40% of the time, so the server retries up to
  `TIKTOK_RETRIES` (default 8) times, which measured 6/6 successes. Uploading a
  cookies.txt improves this further. A 500 here is worth one client-side retry.
- **Pick a format client-side** from the `media` array rather than assuming
  index 0 — availability varies per source.

## Storage status

| Method | Path |
|---|---|
| GET | `/api/status` |

Requires `x-api-key` (or `Authorization: Bearer`). What converted files are on
disk right now, how much space they take, and when each is deleted.

```json
{
  "success": true,
  "count": 2,
  "total_size_bytes": 79931902,
  "total_size": "76.23 MB",
  "cache_ttl_seconds": 3600,
  "orphaned_count": 1,
  "orphaned_size_bytes": 12497303,
  "orphaned_size": "11.92 MB",
  "disk": {
    "free_bytes": 227133972480, "free": "211.53 GB",
    "total_bytes": 511241613312, "total": "476.13 GB",
    "used_percent": 56
  },
  "generated_at": "2026-09-04T08:33:06.118Z",
  "videos": [
    {
      "key": "video_1788509674495.mp4",
      "file_url": "https://your-domain/downloads/video_1788509674495.mp4",
      "extension": "mp4",
      "size_bytes": 67434599,
      "size": "64.31 MB",
      "created_at": "2026-09-04T08:14:38.000Z",
      "expires_at": "2026-09-04T09:14:38.000Z",
      "expires_in_seconds": 2674,
      "auto_delete": true
    }
  ]
}
```

Files are listed **soonest deletion first**, so the top of `videos` is what
disappears next. Orphans sort last.

### `auto_delete: false` — files that will never be removed

This reads the **directory**, not just the cache, and that distinction is the
whole point.

`VideoCache` is in-memory and its TTL handler is what deletes files, but
`./downloads` is a bind mount that outlives the container. **Every restart
strands the files it was tracking**: they stay on disk with no deletion
scheduled, forever. Listing only the cache would report a tidy server while the
disk fills up.

So anything on disk the cache does not know about is reported with
`expires_at: null` and `auto_delete: false`, and counted in `orphaned_count`
/ `orphaned_size_bytes`. A non-zero `orphaned_count` right after a deploy is
expected and means exactly that. Clear them with `/api/delete-video`, or
`rm` them on the host.

A stray `.ts` file is worth noticing too: `/api/downloads/mp4` writes an
intermediate transport stream and does not remove it if the download errors,
so those leak the same way.

`disk` is best-effort — it is omitted (`null`) on platforms where `statfs`
is unavailable. It reports the volume holding `DOWNLOADS_DIR`, which on the
VPS is shared with Postgres and MinIO.

Note this endpoint is **gated** while `/api/health` is open: it lists every
cached file's name, and those names are the only unguessable part of the
open `/downloads/<file>` URLs.

## Clearing the server

| Method | Path |
|---|---|
| **DELETE** | `/api/clear-server` |

Removes **every** converted file in `DOWNLOADS_DIR` immediately, without
waiting for `CACHE_TTL_SECONDS`, and flushes the cache so no entry outlives
the file it pointed at.

```bash
curl -X DELETE -H "x-api-key: $API_KEY" https://your-domain/api/clear-server
```

```json
{
  "success": true,
  "deleted_count": 3,
  "freed_bytes": 16252928,
  "freed": "15.50 MB",
  "failed_count": 0,
  "deleted": [
    { "key": "video_1788509674495.mp4", "size_bytes": 3145728, "size": "3.00 MB" }
  ],
  "failed": [],
  "cleared_at": "2026-09-04T08:40:58.930Z"
}
```

**The method is `DELETE`.** A `GET` or `POST` returns `404`. That is
deliberate: this wipes everything, and a GET can be fired by a link prefetch, a
crawler or a stray click in an API client. `/api/delete-video` stays a GET
because a mistake there costs one named file.

Notes:

- It sweeps the **directory**, so it clears orphans — the files a restart
  stranded, which `/api/status` reports as `auto_delete: false` — as well as
  tracked ones. Stray `.ts` intermediates left by a failed
  `/api/downloads/mp4` go too.
- Never recurses into subdirectories and never follows a symlink out of
  `DOWNLOADS_DIR`; only plain files directly inside it are unlinked.
- Idempotent. Clearing an empty server returns `deleted_count: 0` and `200`.
- `success` is `false` when any file could not be removed (locked, or owned by
  another user); the status stays `200` and `failed[]` names each one with its
  error code. Check `failed_count`, not just the status.
- **It does not cancel in-flight work.** A conversion already running will write
  its output after the sweep, and a client mid-download of a cleared file gets a
  truncated transfer. Nothing is unrecoverable — every file is regenerable by
  re-requesting it.
- Pair it with `/api/status` to see what will go before you call it.
