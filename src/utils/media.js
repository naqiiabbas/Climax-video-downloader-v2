/**
 * Shared normaliser that turns a raw yt-dlp `-j` info dict into the `media[]`
 * array the mobile client consumes.
 *
 * The original per-controller logic keyed formats by `format_note`, which
 * collapsed every DASH rendition of a Facebook reel into a single "DASH video"
 * entry (silent, because DASH video tracks carry no audio) and merged the
 * usable progressive `sd`/`hd` streams into one "unknownp" entry. Keying by
 * real resolution and scoring progressive streams above video-only ones fixes
 * both, and the extra flags let the client avoid picking a stream it cannot
 * play or download directly.
 */

export function formatFileSize(bytes) {
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

const isHlsFormat = (f) =>
  f.ext === "m3u8" ||
  String(f.protocol || "").includes("m3u8") ||
  String(f.url || "").includes(".m3u8");

const isDashFormat = (f) =>
  String(f.protocol || "").includes("dash") ||
  /\bDASH\b/i.test(String(f.format_note || ""));

// yt-dlp uses the literal string "none" (not null) for a missing track, and
// leaves the field empty when it simply does not know.
const hasVideo = (f) => {
  const v = f.vcodec;
  if (v === "none") return false;
  if (f.height || f.width) return true;
  return true;
};

const hasAudio = (f) => {
  const a = f.acodec;
  if (a === "none") return false;
  if (a) return true;
  // Empty acodec on a muxed progressive stream (Facebook sd/hd): if it is not
  // a DASH/adaptive track, assume audio is present.
  return !isDashFormat(f) && !isHlsFormat(f);
};

/** Stable, human-meaningful bucket so renditions of one quality collapse together. */
function qualityKeyFor(f) {
  const audioOnly = !hasVideo(f) || f.vcodec === "none";
  if (audioOnly) return f.abr ? `audio-${Math.round(f.abr)}k` : "audio";
  if (f.height) return `${f.height}p`;

  const note = String(f.format_note || "").trim();
  // "DASH video" / "DASH audio" describe the container, not the quality, so
  // they are useless as a key — fall back to the format id, which is unique.
  if (note && !/^dash\b/i.test(note)) return note;

  return f.format_id ? String(f.format_id) : "unknown";
}

/**
 * Higher wins within a quality bucket. Playability dominates: a stream the
 * client can save and play as-is beats a marginally larger silent one.
 */
function scoreFormat(f) {
  let score = 0;
  if (hasAudio(f) && hasVideo(f)) score += 10_000; // progressive / muxed
  if (!isHlsFormat(f)) score += 2_000; // direct download beats a playlist
  if (f.ext === "mp4") score += 300;
  else if (f.ext === "m4a") score += 200;
  else if (f.ext === "webm") score += 100;
  score += Math.min(Number(f.tbr) || 0, 50_000) / 1000; // tie-break on bitrate
  return score;
}

function sizeOf(f, durationSeconds) {
  const known = f.filesize || f.filesize_approx;
  if (known) return { bytes: known, estimated: false };
  // tbr is in kbit/s; only an estimate, but the client needs something to show.
  const tbr = Number(f.tbr);
  if (tbr && durationSeconds) {
    return { bytes: Math.round((tbr * 1000 * durationSeconds) / 8), estimated: true };
  }
  return { bytes: null, estimated: false };
}

/**
 * @param {object} info      raw yt-dlp info dict
 * @param {object} [options]
 * @param {boolean} [options.includeHls=true]  keep HLS entries, flagged for conversion
 * @param {boolean} [options.includeHeaders=false]  attach http headers/cookies (TikTok)
 * @param {string}  [options.cookies=""]  cookie string to attach when includeHeaders
 */
export function buildMediaList(info, options = {}) {
  const { includeHls = true, includeHeaders = false, cookies = "" } = options;
  const duration = Number(info.duration) || null;
  const httpHeaders = info.http_headers || {};

  const best = new Map();

  for (const f of info.formats || []) {
    if (!f.url) continue;

    const hls = isHlsFormat(f);
    if (hls && !includeHls) continue;

    const key = qualityKeyFor(f);
    const score = scoreFormat(f);
    const existing = best.get(key);
    if (existing && existing.score >= score) continue;

    const video = hasVideo(f) && f.vcodec !== "none";
    const audio = hasAudio(f);
    const { bytes, estimated } = sizeOf(f, duration);

    const entry = {
      url: f.url,
      format_id: f.format_id || null,
      quality: key,
      extension: f.ext || null,
      // Kept for backwards compatibility with the existing clients.
      type: video ? "video" : "audio",
      has_video: video,
      has_audio: audio,
      // "https" is a plain file the client can GET; "m3u8" is a playlist that
      // must go through /api/downloads/mp4 first.
      protocol: hls ? "m3u8" : "https",
      needs_conversion: hls,
      size_bytes: bytes,
      size: formatFileSize(bytes),
      size_is_estimate: estimated,
    };

    if (includeHeaders) {
      const headers = { ...httpHeaders };
      if (cookies) headers.Cookie = cookies;
      entry.headers = headers;
      entry.cookies = f.cookies || cookies;
    }

    best.set(key, { score, entry });
  }

  // Nothing usable in `formats` — fall back to the top-level URL.
  if (best.size === 0 && info.url) {
    const hls = isHlsFormat(info);
    best.set("direct", {
      score: 0,
      entry: {
        url: info.url,
        format_id: null,
        quality: "direct",
        extension: info.ext || null,
        type: "video",
        has_video: true,
        has_audio: true,
        protocol: hls ? "m3u8" : "https",
        needs_conversion: hls,
        size_bytes: null,
        size: null,
        size_is_estimate: false,
      },
    });
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .map((v) => v.entry);
}

/** The envelope every extraction endpoint returns. */
export function buildResponse(info, options) {
  return {
    url: info.webpage_url || null,
    source: info.extractor_key || null,
    author: info.uploader || null,
    title: info.title || null,
    thumbnail: info.thumbnail || null,
    duration: info.duration || null,
    media: buildMediaList(info, options),
  };
}
