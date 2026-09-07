import { exec } from "child_process";
import { config } from "../config.js";
import { buildResponse, formatFileSize } from "../utils/media.js";
import { cookieArgString } from "../utils/cookies.js";
import { mergeToMp4, publicDownloadUrl, MergeError } from "../utils/mergeDownload.js";
import { parseQuality, availableQualities, ALLOWED_QUALITIES } from "../utils/quality.js";
import { allEntriesAreDrm, DRM_MESSAGE, DRM_CODE } from "../utils/drm.js";

const ytdlp = config.ytdlpPath;

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const cookieArg = cookieArgString();

    const command = `"${ytdlp}" -j --no-warnings ${cookieArg}${JSON.stringify(url)}`;

    exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) return reject(stderr || error.message);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject("Failed to parse yt-dlp output");
      }
    });
  });
}

const isRawRequested = (req) =>
  ["1", "true", "yes"].includes(String(req.query.raw || "").toLowerCase());

/**
 * Handles Dailymotion and Pinterest. Two-phase by design:
 *
 *   GET /api/dailymotion?url=...                -> metadata + available_qualities, NO media
 *   GET /api/dailymotion?url=...&quality=480    -> metadata + media[one mp4], NO available_qualities
 *
 * The first phase is a metadata probe only: no download, no disk written,
 * answers in a couple of seconds. The second does the real work.
 *
 * There is deliberately no default quality. Converting at 1080p just because
 * the caller did not say otherwise spent minutes and hundreds of MB of VPS
 * disk on a choice the user had not made yet — and the client then had no way
 * to offer a picker without a second request. Making `quality` the trigger
 * means nothing is downloaded until someone has actually chosen.
 */
export const DalyMotionAndPainternst = async (req, res) => {
  let url = req.body?.url || req.query?.url;
  if (typeof url === "string") url = decodeURIComponent(url);
  if (!url) return res.status(400).json({ error: "Missing URL" });

  // Validate before the (slow) extraction, so a typo fails in milliseconds.
  // Unlike before, an unusable value is rejected rather than silently swapped
  // for the default: the caller asked for a specific quality and getting a
  // different one back without being told is worse than an error.
  const rawQuality = req.query.quality;
  const wantsQuality = rawQuality !== undefined && String(rawQuality) !== "";
  const quality = wantsQuality ? parseQuality(rawQuality, null) : null;
  if (wantsQuality && !quality) {
    return res.status(400).json({
      success: false,
      error: `Invalid quality. Allowed: ${[...ALLOWED_QUALITIES].join(", ")}`,
      error_code: "invalid_quality",
    });
  }

  try {
    const result = await runYtDlp(url);
    const probe = buildResponse(result);

    const meta = {
      url: probe.url,
      source: probe.source,
      author: probe.author,
      title: probe.title,
      thumbnail: probe.thumbnail,
      duration: probe.duration,
    };

    const drm = allEntriesAreDrm(probe.media);
    if (drm) {
      return res.status(422).json({
        ...meta,
        drm_protected: true,
        error: DRM_MESSAGE,
        error_code: DRM_CODE,
      });
    }

    // Escape hatch, unchanged: the raw per-quality m3u8 list for a client that
    // wants to run its own conversion via /api/downloads/mp4.
    if (isRawRequested(req)) {
      return res.json({ ...probe, drm_protected: false, raw: true });
    }

    // Phase 1 — no quality chosen yet. Metadata and the menu, nothing else.
    if (!quality) {
      return res.json({
        ...meta,
        requires_quality: true,
        drm_protected: false,
        available_qualities: availableQualities(probe.media),
      });
    }

    // Phase 2 — convert at exactly what was asked for.
    const { cacheKey, sizeBytes } = await mergeToMp4(url, quality);
    return res.json({
      ...meta,
      requires_quality: false,
      needs_merge: false,
      auto_converted: true,
      drm_protected: false,
      quality,
      media: [
        {
          url: publicDownloadUrl(req, cacheKey),
          format_id: null,
          quality,
          extension: "mp4",
          type: "video",
          has_video: true,
          has_audio: true,
          protocol: "https",
          needs_conversion: false,
          size_bytes: sizeBytes,
          size: formatFileSize(sizeBytes),
          size_is_estimate: false,
        },
      ],
    });
  } catch (err) {
    // A conversion failure is now a real failure. The old fallback handed back
    // the raw m3u8 list with a 200, which only made sense while media[] was
    // returned by default; here the caller asked for one converted file and
    // there is nothing usable to degrade to.
    if (err instanceof MergeError) {
      return res.status(err.status).json({
        success: false,
        error: err.message,
        error_code: err.code,
        details: err.details,
      });
    }
    console.error("yt-dlp error:", err);
    return res.status(500).json({
      error: "yt-dlp execution failed",
      details: err?.toString?.() || String(err),
    });
  }
};
