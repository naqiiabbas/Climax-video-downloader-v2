import m3u8stream from "m3u8stream";
import fs from "fs";
import { exec } from "child_process";
import path from "path";
import { config } from "../config.js";
import { VideoCache } from "../utils/cache.js";

const downloadDir = config.downloadsDir;
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

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

      // Must match the static mount in index.js ("/downloads").
      const base = config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
      res.json({
        success: true,
        file_url: `${base}/downloads/${cacheKey}`,
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
