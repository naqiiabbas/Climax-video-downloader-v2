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

### Auto-conversion — Vimeo and Dailymotion only

Both sources only ever publish HLS. A naive `GET` on the raw playlist URL
returns `200` with a real, valid-looking response — it is just a ~30 KB text
file, not a video. That was reported as "Vimeo download isn't working"; it is
the same failure as the m3u8-instead-of-mp4 complaint, not a separate bug.

**By default, `/api/vimeo` and `/api/dailymotion` now download and remux the
video server-side and return one ready `.mp4` link** instead of the raw
per-quality list — no client-side conversion step needed:

```json
{
  "url": "https://vimeo.com/1160592223",
  "source": "Vimeo",
  "title": "...",
  "needs_merge": false,
  "auto_converted": true,
  "media": [
    {
      "url": "https://your-domain/downloads/video_....mp4",
      "quality": "1080",
      "extension": "mp4",
      "type": "video",
      "has_video": true,
      "has_audio": true,
      "protocol": "https",
      "needs_conversion": false,
      "size_bytes": 386814026,
      "size": "368.90 MB",
      "size_is_estimate": false
    }
  ]
}
```

**This is slow — it is a real download, not a metadata probe.** A short clip
converts in 5–25s; a 13-minute Vimeo video at 1080p measured **172s**. Set the
client's HTTP timeout well above what extraction used to need (a 60s timeout
that worked before will now cut off long or high-quality videos mid-request).
`quality` (below) is the lever to trade this off.

Query parameters:

| Param | Effect |
|---|---|
| `quality` | Same values as `/api/downloads/prepare`: `best`, `2160`, `1440`, `1080` (default), `720`, `480`, `360`, `240`. Lower = faster and smaller. |
| `raw=1` | Skip conversion; return the old fast, metadata-only, per-quality m3u8 list (`needs_conversion: true` on every entry) for a client that wants to offer its own quality picker and convert on demand via `/api/downloads/mp4`. |

If the server-side conversion fails for any reason, the endpoint **does not
error out** — it falls back to the raw list with `auto_converted: false` and an
`auto_convert_error` message, so the request still returns something usable.

Server-wide, this can be turned off with `AUTO_CONVERT=false` in `.env`
(reverts both endpoints to the old always-raw behavior; `?raw=1` still works
either way).

### Choosing a quality

`/api/vimeo` and `/api/dailymotion` convert to `DEFAULT_QUALITY` (1080) unless
you say otherwise. Pass `?quality=` to pick another:

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
- `best` is always accepted but is never listed: it has no predictable size,
  and on a long video it is a large file and a slow conversion.

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

`quality` accepts `best`, `2160`, `1440`, `1080`, `720`, `480`, `360`, `240`
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
