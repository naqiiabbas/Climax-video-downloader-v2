import { exec } from "child_process";
import { config } from "../config.js";
import { buildResponse, formatFileSize } from "../utils/media.js";
import { cookieArgString } from "../utils/cookies.js";
import { mergeToMp4, publicDownloadUrl, MergeError } from "../utils/mergeDownload.js";
import { parseQuality } from "../utils/quality.js";
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

/** True when this entry is a plain file the client can download as-is. */
const isReadyToDownload = (m) => m.has_video && m.has_audio && m.protocol === "https";

/** Handles Dailymotion and Pinterest. */
export const DalyMotionAndPainternst = async (req, res) => {
  let url = req.body?.url || req.query?.url;
  if (typeof url === "string") url = decodeURIComponent(url);
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const result = await runYtDlp(url);
    const response = buildResponse(result);
    response.auto_converted = false;

    // Dailymotion serves everything as HLS, so `media` here is never directly
    // downloadable — every entry needs_conversion. By default this converts
    // the video server-side (the same yt-dlp+ffmpeg merge /api/downloads/prepare
    // uses) and returns one ready .mp4 link instead. A naive client GETting the
    // raw m3u8 URL gets a ~30KB text playlist, not a video — this is that bug,
    // fixed at the source rather than pushed onto every client.
    //
    // ?raw=1 skips this and returns the old metadata-only, m3u8-flagged list —
    // useful for a quality-picker UI that converts on demand via
    // /api/downloads/mp4 instead of committing to one quality up front.
    const ready = response.media.find(isReadyToDownload);

    // Skip a download that cannot possibly succeed — see utils/drm.js.
    const drm = allEntriesAreDrm(response.media);

    if (!isRawRequested(req) && !ready && drm) {
      response.auto_convert_error = DRM_MESSAGE;
      response.error_code = DRM_CODE;
    } else if (!isRawRequested(req) && !ready && config.autoConvert) {
      const quality = parseQuality(req.query.quality, config.defaultQuality) || config.defaultQuality;
      try {
        const { cacheKey, sizeBytes } = await mergeToMp4(url, quality);
        response.media = [
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
        ];
        response.needs_merge = false;
        response.auto_converted = true;
      } catch (err) {
        // Degrade rather than fail the whole request: hand back the raw HLS
        // list (still usable via /api/downloads/mp4) instead of a hard 500.
        //
        // Keep err.details — dropping it left "Download failed" as the only
        // thing the caller ever saw, which is not enough to tell a DRM wall
        // from a transient extractor fault.
        console.error("Dailymotion auto-convert failed:", err);
        if (err instanceof MergeError) {
          response.auto_convert_error = err.message;
          response.error_code = err.code;
          if (err.details) response.auto_convert_error_details = err.details;
        } else {
          response.auto_convert_error = "Conversion failed";
          response.error_code = "conversion_failed";
        }
      }
    }

    response.drm_protected = drm;

    // Only a genuinely unusable result gets an error status: the request was
    // valid, the content just cannot be delivered.
    if (drm && !response.auto_converted && !isRawRequested(req)) {
      return res.status(422).json(response);
    }

    res.json(response);
  } catch (error) {
    console.error("yt-dlp error:", error);
    res.status(500).json({
      error: "yt-dlp execution failed",
      details: error.toString(),
    });
  }
};
