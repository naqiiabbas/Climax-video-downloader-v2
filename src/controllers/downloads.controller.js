import m3u8stream from "m3u8stream";
import fs from "fs";
import { exec, execFile } from "child_process";
import path from "path";
import { config } from "../config.js";
import { VideoCache } from "../utils/cache.js";

const downloadDir = config.downloadsDir;
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

const publicUrlFor = (req, key) => {
  const base = config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
  // Must match the static mount in app.js ("/downloads").
  return `${base}/downloads/${key}`;
};

/**
 * Remuxes a single HLS playlist URL to mp4. Kept for clients that already
 * resolved a media entry with needs_conversion=true.
 */
export const DownloadMediaMp4 = (req, res) => {
  const fileUrl = req.query.url;
  if (!fileUrl) {
    return res.status(400).json({ success: false, error: "Missing URL" });
  }

  const outputFile = path.join(downloadDir, `video_${Date.now()}.ts`);
  const stream = m3u8stream(fileUrl);
  const writeStream = fs.createWriteStream(outputFile);

  stream.pipe(writeStream);

  stream.on("end", () => {
    const mp4File = outputFile.replace(/\.ts$/, ".mp4");
    const command = `"${config.ffmpegPath}" -y -i "${outputFile}" -c copy "${mp4File}"`;

    exec(command, (error) => {
      if (error) {
        console.error("Conversion error:", error);
        return res.status(500).json({ success: false, error: "Conversion failed" });
      }

      try {
        fs.unlinkSync(outputFile);
      } catch (err) {
        console.error("Failed to remove .ts file:", err);
      }

      const cacheKey = path.basename(mp4File);
      if (!VideoCache.setVideo(cacheKey, mp4File)) {
        return res.status(500).json({ success: false, error: "Failed to cache video" });
      }

      res.json({
        success: true,
        file_url: publicUrlFor(req, cacheKey),
        key: cacheKey,
        expires_in: config.cacheTtlSeconds,
      });
    });
  });

  stream.on("error", (err) => {
    console.error("Stream error:", err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: "Stream download failed" });
    }
  });
};

const ALLOWED_QUALITIES = new Set(["best", "2160", "1440", "1080", "720", "480", "360", "240"]);

/**
 * Downloads a page URL and returns one finished mp4.
 *
 * YouTube (and increasingly Facebook) publish adaptive streams only: video and
 * audio arrive as separate tracks, so every entry in media[] is silent or
 * picture-less on its own. This endpoint hands the whole job to yt-dlp, which
 * selects the pair, downloads both and merges them with ffmpeg.
 *
 * It takes the original page URL rather than the resolved CDN URLs on purpose —
 * those expire within minutes and several sources require the original request
 * headers and cookies to serve them at all.
 */
export const PrepareDownload = (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl) {
    return res.status(400).json({ success: false, error: "Missing URL" });
  }

  const quality = String(req.query.quality || config.defaultQuality);
  if (!ALLOWED_QUALITIES.has(quality)) {
    return res.status(400).json({
      success: false,
      error: `Invalid quality. Allowed: ${[...ALLOWED_QUALITIES].join(", ")}`,
    });
  }

  const stamp = Date.now();
  const outputTemplate = path.join(downloadDir, `video_${stamp}.%(ext)s`);

  // h264 + aac keeps the result playable on every mobile client without a
  // re-encode; res: caps the height without failing when it is unavailable.
  const sortSpec =
    quality === "best"
      ? "vcodec:h264,acodec:aac"
      : `res:${quality},vcodec:h264,acodec:aac`;

  const args = [
    "--no-warnings",
    "-f",
    "bv*+ba/b",
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
  ];

  if (fs.existsSync(config.cookiesPath)) {
    args.push("--cookies", config.cookiesPath);
  }

  args.push(pageUrl);

  execFile(
    config.ytdlpPath,
    args,
    { maxBuffer: 1024 * 1024 * 50, timeout: config.mergeTimeoutMs },
    (error, stdout, stderr) => {
      if (error) {
        console.error("Merge download failed:", stderr || error.message);
        const killed = error.killed || error.signal;
        return res.status(killed ? 504 : 500).json({
          success: false,
          error: killed ? "Download timed out" : "Download failed",
          details: String(stderr || error.message).slice(0, 500),
        });
      }

      const produced = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
      if (!produced || !fs.existsSync(produced)) {
        console.error("yt-dlp reported no output file:", stdout, stderr);
        return res
          .status(500)
          .json({ success: false, error: "Download produced no file" });
      }

      const cacheKey = path.basename(produced);
      if (!VideoCache.setVideo(cacheKey, produced)) {
        return res.status(500).json({ success: false, error: "Failed to cache video" });
      }

      let sizeBytes = null;
      try {
        sizeBytes = fs.statSync(produced).size;
      } catch {
        // Size is informational only.
      }

      res.json({
        success: true,
        file_url: publicUrlFor(req, cacheKey),
        key: cacheKey,
        size_bytes: sizeBytes,
        quality,
        expires_in: config.cacheTtlSeconds,
      });
    }
  );
};
