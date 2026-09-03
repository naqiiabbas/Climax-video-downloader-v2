import m3u8stream from "m3u8stream";
import fs from "fs";
import { exec } from "child_process";
import path from "path";
import { config } from "../config.js";
import { VideoCache } from "../utils/cache.js";
import { mergeToMp4, publicDownloadUrl, MergeError } from "../utils/mergeDownload.js";
import { ALLOWED_QUALITIES, parseQuality } from "../utils/quality.js";

const downloadDir = config.downloadsDir;
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

/**
 * Remuxes a single HLS playlist URL to mp4. Kept for clients that already
 * resolved a media entry with needs_conversion=true (or passed ?raw=1 to
 * /api/vimeo or /api/dailymotion and want to convert one themselves).
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

      // Drop the intermediate transport stream.
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
        file_url: publicDownloadUrl(req, cacheKey),
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

/**
 * Downloads a page URL and returns one finished mp4.
 *
 * YouTube (and increasingly Facebook) publish adaptive streams only: video and
 * audio arrive as separate tracks, so every entry in media[] is silent or
 * picture-less on its own. This endpoint hands the whole job to yt-dlp, which
 * selects the pair, downloads both and merges them with ffmpeg.
 *
 * Vimeo and Dailymotion now run the same logic automatically inside
 * /api/vimeo and /api/dailymotion (see mergeToMp4 in utils/mergeDownload.js);
 * this route stays for any client that wants to trigger it explicitly, e.g.
 * after calling an extractor with ?raw=1.
 */
export const PrepareDownload = async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl) {
    return res.status(400).json({ success: false, error: "Missing URL" });
  }

  const quality = parseQuality(req.query.quality, config.defaultQuality);
  if (!quality) {
    return res.status(400).json({
      success: false,
      error: `Invalid quality. Allowed: ${[...ALLOWED_QUALITIES].join(", ")}`,
    });
  }

  try {
    const { cacheKey, sizeBytes } = await mergeToMp4(pageUrl, quality);
    res.json({
      success: true,
      file_url: publicDownloadUrl(req, cacheKey),
      key: cacheKey,
      size_bytes: sizeBytes,
      quality,
      expires_in: config.cacheTtlSeconds,
    });
  } catch (err) {
    if (err instanceof MergeError) {
      return res
        .status(err.status)
        .json({ success: false, error: err.message, details: err.details });
    }
    console.error("PrepareDownload error:", err);
    res.status(500).json({ success: false, error: "Download failed" });
  }
};
