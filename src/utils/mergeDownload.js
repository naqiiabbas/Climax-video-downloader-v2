import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { config } from "../config.js";
import { VideoCache } from "./cache.js";
import { cookieArgList } from "./cookies.js";
import { isDrmError, DRM_MESSAGE, DRM_CODE } from "./drm.js";
import { qualityCap, MAX_HEIGHT } from "./quality.js";

if (!fs.existsSync(config.downloadsDir)) {
  fs.mkdirSync(config.downloadsDir, { recursive: true });
}

export class MergeError extends Error {
  /**
   * `code` is a stable, machine-readable reason the client can branch on:
   * "drm_protected", "download_timeout", "download_failed", "no_output",
   * "cache_failed". The human `message` is free to be reworded; `code` is not.
   */
  constructor(message, status = 500, details, code = "download_failed") {
    super(message);
    this.name = "MergeError";
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

const VIMEO_ID_RE = /vimeo\.com\/(?:video\/)?(?:channels\/[^/]+\/)?(?:ondemand\/[^/]+\/)?(\d+)/i;

/**
 * yt-dlp's download path for a plain vimeo.com/<id> URL demands a login
 * ("The web client only works when logged-in"), even though -j metadata
 * extraction against that same URL works fine — confirmed by hand. The
 * player.vimeo.com/video/<id> URL with a Referer header downloads without
 * one; this is the same workaround Vimeo.controller.js already applies for
 * metadata. Applied centrally here so every caller of mergeToMp4 — including
 * a client hitting /api/downloads/prepare with a raw vimeo.com URL — gets it
 * automatically, not just /api/vimeo's own auto-conversion.
 */
function vimeoWorkaround(pageUrl) {
  if (!/vimeo\.com/i.test(pageUrl) || /player\.vimeo\.com/i.test(pageUrl)) return null;
  const m = pageUrl.match(VIMEO_ID_RE);
  if (!m) return null;
  const id = m[1];
  return {
    url: `https://player.vimeo.com/video/${id}`,
    extraArgs: ["--add-header", `Referer: https://vimeo.com/${id}`],
  };
}

/**
 * Downloads `pageUrl` and returns one finished mp4 with both video and audio,
 * regardless of source. yt-dlp does the actual work — selecting a video+audio
 * pair (or a single muxed stream), downloading it, remuxing/merging with
 * ffmpeg — so this wraps that in a promise and registers the result in
 * VideoCache. It does not care whether the source is adaptive (YouTube),
 * HLS-only (Vimeo, Dailymotion) or anything else yt-dlp supports.
 *
 * Takes the ORIGINAL PAGE URL, not a resolved CDN URL: those expire within
 * minutes and several sources need the original request headers and cookies.
 *
 * Shared by GET /api/downloads/prepare (an explicit client call) and the
 * automatic conversion that /api/vimeo and /api/dailymotion run internally —
 * one code path, so a fix here fixes both callers. `extraArgs` is an escape
 * hatch for a caller-supplied yt-dlp flag beyond what vimeoWorkaround covers.
 */
export function mergeToMp4(pageUrl, quality = config.defaultQuality, { extraArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const workaround = vimeoWorkaround(pageUrl);
    const targetUrl = workaround ? workaround.url : pageUrl;
    const allExtraArgs = workaround ? [...workaround.extraArgs, ...extraArgs] : extraArgs;

    const stamp = Date.now();
    const outputTemplate = path.join(config.downloadsDir, `video_${stamp}.%(ext)s`);

    // h264 + aac keeps the result playable on every mobile client without a
    // re-encode. `cap` turns "best" into 1080 so no request can reach 4K.
    const cap = qualityCap(quality);
    const sortSpec = `res:${cap},vcodec:h264,acodec:aac`;

    // -S res: only *sorts*, so on a source whose renditions all sit above the
    // cap it would still pick one. The height filters below exclude them
    // outright; the trailing unfiltered selector is the fallback for a source
    // that publishes nothing at or below the cap, where refusing entirely
    // would be worse than returning its closest rendition.
    const formatSelector =
      `bv*[height<=${cap}]+ba/b[height<=${cap}]/bv*[height<=${MAX_HEIGHT}]+ba/bv*+ba/b`;

    const args = [
      "--no-warnings",
      "-f",
      formatSelector,
      "-S",
      sortSpec,
      "--merge-output-format",
      "mp4",
      "--ffmpeg-location",
      path.dirname(config.ffmpegPath),
      "-o",
      outputTemplate,
      "--no-playlist",
      // Print the final path after any merge/remux so we do not have to guess it.
      "--print",
      "after_move:filepath",
      "--no-simulate",
      ...allExtraArgs,
      ...cookieArgList(),
      targetUrl,
    ];

    execFile(
      config.ytdlpPath,
      args,
      { maxBuffer: 1024 * 1024 * 50, timeout: config.mergeTimeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          console.error("Merge download failed:", stderr || error.message);
          const killed = Boolean(error.killed || error.signal);
          const details = String(stderr || error.message).slice(0, 500);

          // DRM is not a transient failure — retrying, lowering the quality or
          // updating yt-dlp will never help, because the segments need a
          // licence server. Say so explicitly instead of returning the generic
          // "Download failed" that sent us hunting for a server-side fault.
          if (!killed && isDrmError(details)) {
            return reject(new MergeError(DRM_MESSAGE, 422, details, DRM_CODE));
          }

          return reject(
            new MergeError(
              killed ? "Download timed out" : "Download failed",
              killed ? 504 : 500,
              details,
              killed ? "download_timeout" : "download_failed"
            )
          );
        }

        const produced = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
        if (!produced || !fs.existsSync(produced)) {
          console.error("yt-dlp reported no output file:", stdout, stderr);
          return reject(
            new MergeError(
              "Download produced no file",
              500,
              String(stdout || stderr).slice(0, 500),
              "no_output"
            )
          );
        }

        const cacheKey = path.basename(produced);
        if (!VideoCache.setVideo(cacheKey, produced)) {
          return reject(new MergeError("Failed to cache video", 500, undefined, "cache_failed"));
        }

        let sizeBytes = null;
        try {
          sizeBytes = fs.statSync(produced).size;
        } catch {
          // Size is informational only.
        }

        resolve({ cacheKey, filePath: produced, sizeBytes, quality });
      }
    );
  });
}

/** Must match the static mount in app.js ("/downloads"). */
export function publicDownloadUrl(req, cacheKey) {
  const base = config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
  return `${base}/downloads/${cacheKey}`;
}
