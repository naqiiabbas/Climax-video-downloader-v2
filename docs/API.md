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
| GET | `/api/vimeo` | Vimeo (custom extractor) |
| GET | `/api/dailymotion` | Dailymotion **and** Pinterest |

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

Some sources offer no direct option at all — Dailymotion and Vimeo are HLS-only,
so conversion is the **only** path there.

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
| GET | `/api/health` | **Open.** `{status, uptime, cookies, cachedVideos, timestamp}` |
| POST | `/api/update-cookies` | Multipart, field `file`. Max 5 MB, `.txt` + `text/plain`, must be Netscape format |
| GET | `/api/delete-video?url=<file_url>` | Deletes a converted file before its TTL |
| GET | `/downloads/<filename>` | Static serving of converted files |
| GET | `/` | `{"service":"video-downloader-api","status":"running"}` |

## Client notes

- **Extracted URLs are short-lived.** TikTok and Instagram links expire within
  minutes. Resolve immediately before downloading; do not cache them.
- **Extraction is slow.** yt-dlp can take 5–30s. Use a 60s client timeout;
  Nginx allows 300s. TikTok is the slowest because the server retries
  internally against rate limiting (measured 5–20s).
- **TikTok fails intermittently by design of their anti-bot.** A single
  anonymous attempt succeeds ~40% of the time, so the server retries up to
  `TIKTOK_RETRIES` (default 8) times, which measured 6/6 successes. Uploading a
  cookies.txt improves this further. A 500 here is worth one client-side retry.
- **Pick a format client-side** from the `media` array rather than assuming
  index 0 — availability varies per source.
