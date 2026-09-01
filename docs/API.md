# Video Downloader API

Base URL: `https://<your-domain>` (local: `http://localhost:8000`)

All extraction endpoints accept the target link as `?url=` or as `{"url": "..."}`
in a JSON body. The value is URL-decoded server-side.

## Authentication

Every endpoint except `GET /` and `GET /api/health` requires a header:

```
x-api-key: <API_KEY from .env>
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
      "size_bytes": 2411724,
      "size": "2.30 MB"
    }
  ]
}
```

`media[].type` is `"video"` or `"audio"`. One entry per quality; mp4 wins over
webm at the same quality. HLS/m3u8 formats are filtered out — use
`/api/downloads/mp4` for those.

**TikTok only** additionally returns `media[].headers` and `media[].cookies`.
The client **must** replay those headers on the download request or the CDN
returns 403.

### Errors

| Code | Body |
|---|---|
| 400 | `{"error":"Missing URL"}` |
| 500 | `{"error":"yt-dlp execution failed","details":"..."}` |

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
  Nginx allows 300s.
- **Pick a format client-side** from the `media` array rather than assuming
  index 0 — availability varies per source.
