/**
 * Shared between /api/downloads/prepare and the auto-conversion Vimeo and
 * Dailymotion run internally, so both accept exactly the same `quality`
 * values and validation cannot drift between them.
 */
export const ALLOWED_QUALITIES = new Set([
  "best",
  "2160",
  "1440",
  "1080",
  "720",
  "480",
  "360",
  "240",
]);

/** Returns the validated quality string, or null if it is not one of the allowed values. */
export function parseQuality(raw, fallback) {
  const q = String(raw ?? fallback);
  return ALLOWED_QUALITIES.has(q) ? q : null;
}

/** Descending, so the nearest-match search below prefers the taller rendition on a tie. */
const QUALITY_LADDER = ["2160", "1440", "1080", "720", "480", "360", "240"];

/** Height from a media entry's quality label ("1080p" -> 1080). */
function heightOf(entry) {
  const m = /^(\d+)\s*p?$/.exec(String(entry?.quality ?? "").trim());
  const h = m ? Number(m[1]) : NaN;
  return Number.isFinite(h) && h > 0 ? h : null;
}

/** The ladder value `-S res:<n>` would resolve to this height — nearest wins. */
function nearestLadderValue(height) {
  let best = QUALITY_LADDER[0];
  let bestDist = Infinity;
  for (const q of QUALITY_LADDER) {
    const d = Math.abs(Number(q) - height);
    if (d < bestDist) {
      bestDist = d;
      best = q;
    }
  }
  return best;
}

/**
 * The `?quality=` values actually worth offering for one video, so the client
 * can build a quality picker from a single request.
 *
 * Auto-conversion replaces media[] with the one converted mp4, which threw away
 * the only evidence of what else the source published — the app could not show
 * a picker without calling again with ?raw=1 and getting back m3u8 URLs it
 * cannot use. This is derived BEFORE that replacement.
 *
 * Built from the real renditions rather than the whole ladder: listing "720p"
 * for a source that only publishes 1080p and 240p would promise a size and a
 * resolution the server cannot deliver. `quality` is the value to send;
 * `label` is the true height, which can differ (a 380p rendition is reached
 * with quality=360, because yt-dlp's res: sort picks the closest match).
 *
 * Sizes come from the source's video-only renditions and the merged mp4 adds an
 * audio track, so they are always approximate — hence size_is_estimate: true.
 */
export function availableQualities(media) {
  if (!Array.isArray(media)) return [];

  const byLadder = new Map();
  for (const entry of media) {
    if (!entry?.has_video) continue;
    const height = heightOf(entry);
    if (!height) continue;

    const quality = nearestLadderValue(height);
    const existing = byLadder.get(quality);
    // Two renditions can map to one ladder value; keep the taller.
    if (existing && (heightOf(existing) ?? 0) >= height) continue;
    byLadder.set(quality, entry);
  }

  return [...byLadder.entries()]
    .map(([quality, entry]) => ({
      quality,
      label: `${heightOf(entry)}p`,
      height: heightOf(entry),
      size_bytes: entry.size_bytes ?? null,
      size: entry.size ?? null,
      size_is_estimate: true,
    }))
    .sort((a, b) => b.height - a.height);
}
