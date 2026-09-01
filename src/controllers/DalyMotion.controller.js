import { exec } from "child_process";

import { config } from "../config.js";

const ytdlp = config.ytdlpPath;

// Helper to format bytes into readable size
function formatFileSize(bytes) {
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(2)} ${units[i]}`;
}

// Main yt-dlp runner with Pinterest-safe fallback
function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const command = `"${ytdlp}" -j ${JSON.stringify(url)}`;
    exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) return reject(stderr || error.message);
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch {
        reject("Failed to parse yt-dlp output");
      }
    });
  });
}

export const DalyMotionAndPainternst = async (req, res) => {
  let url = req.body?.url || req.query?.url;
  if (typeof url === "string") url = decodeURIComponent(url);
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    let result;
    try {
      result = await runYtDlp(url);
    } catch (err) {
      // 🧠 If Pinterest fails with format error, retry fallback
      if (String(err).includes("Requested format is not available")) {
        console.log("⚠️ Retrying with fallback format for Pinterest...");
        result = await runYtDlp(url);
      } else throw err;
    }

    const mediaMap = new Map();

    for (const format of result.formats || []) {
      if (!format.url) continue;

      const vcodec = format.vcodec || "";
      const type = vcodec.includes("none") ? "audio" : "video";
      const qualityKey = format.format_note || `${format.height || "unknown"}p`;

      let priority = 0;
      if (format.ext === "mp4") priority = 100;
      else if (format.ext === "webm") priority = 80;
      else if (format.vcodec && format.vcodec !== "none") priority = 60;
      else priority = 10;

      const fileSize = format.filesize || format.filesize_approx || null;

      if (
        !mediaMap.has(qualityKey) ||
        priority > (mediaMap.get(qualityKey).priority || 0)
      ) {
        mediaMap.set(qualityKey, {
          url: format.url,
          format_id: format.format_id || null,
          quality: qualityKey,
          extension: format.ext || null,
          type,
          size_bytes: fileSize,
          size: formatFileSize(fileSize),
          priority,
        });
      }
    }

    // Fallback if no formats
    if (mediaMap.size === 0 && result.url) {
      mediaMap.set("direct", {
        url: result.url,
        format_id: null,
        quality: "direct",
        extension: result.ext || null,
        type: "video",
        size_bytes: null,
        size: null,
        priority: 50,
      });
    }

    const response = {
      url: result.webpage_url || null,
      source: result.extractor_key || null,
      author: result.uploader || null,
      title: result.title || null,
      thumbnail: result.thumbnail || null,
      duration: result.duration || null,
      media: Array.from(mediaMap.values()).map(({ priority, ...rest }) => rest),
    };

    res.json(response);
  } catch (error) {
    console.error("yt-dlp error:", error);
    res.status(500).json({
      error: "yt-dlp execution failed",
      details: error.toString(),
    });
  }
};
