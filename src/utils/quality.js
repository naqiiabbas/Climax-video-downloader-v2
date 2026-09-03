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
