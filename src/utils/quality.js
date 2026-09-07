/**
 * Shared between /api/downloads/prepare and the conversion /api/vimeo and
 * /api/dailymotion run, so both accept exactly the same `quality` values and
 * validation cannot drift between them.
 */

/**
 * Nothing above 1080p is served. 1440p and 2160p were removed rather than
 * merely discouraged: a 4K merge is ~230MB of disk and bandwidth per request
 * on a box that also hosts Postgres and MinIO, and no mobile client benefits
 * from it. Enforced in three places that must agree — this set (what is
 * accepted), the ladder below (what is offered), and mergeToMp4's format
 * selector (what is actually downloaded).
 */
export const MAX_QUALITY = "1080";
export const MAX_HEIGHT = 1080;

export const ALLOWED_QUALITIES = new Set([
  "best",
  "1080",
  "720",
  "480",
  "360",
  "240",
]);

/**
 * The height cap to hand yt-dlp. "best" is still accepted so existing clients
 * keep working, but it now means "the best at or below 1080p" — it can no
 * longer reach 4K.
 */
export function qualityCap(quality) {
  return quality === "best" ? MAX_QUALITY : String(quality);
}

/** Returns the validated quality string, or null if it is not one of the allowed values. */
export function parseQuality(raw, fallback) {
  const q = String(raw ?? fallback);
  return ALLOWED_QUALITIES.has(q) ? q : null;
}

/** Descending, so the nearest-match search below prefers the taller rendition on a tie. */
const QUALITY_LADDER = ["1080", "720", "480", "360", "240"];

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
    // Never offer what the server will not serve. A source that publishes
    // nothing at or below 1080p yields an empty list, which is the honest
    // answer rather than a 1440p option the cap would refuse.
    if (height > MAX_HEIGHT) continue;

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
