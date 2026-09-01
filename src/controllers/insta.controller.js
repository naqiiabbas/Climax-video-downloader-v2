
import { exec } from "child_process";
import fs from "fs";
import path from "path";

import { config } from "../config.js";

const ytdlp = config.ytdlpPath;

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

function RunYtDpAll(url) {
  return new Promise((resolve, reject) => {
    const { username, password } = config.instagram;

    // Prefer cookies.txt when it exists; fall back to credentials only if both
    // are configured. Instagram rate-limits password logins aggressively.
    let authArgs = "";
    if (fs.existsSync(config.cookiesPath)) {
      authArgs = `--cookies ${JSON.stringify(config.cookiesPath)} `;
    } else if (username && password) {
      authArgs = `--username ${JSON.stringify(username)} --password ${JSON.stringify(password)} `;
    }

    const command = `"${ytdlp}" -j --no-warnings ` +
      authArgs +
      `--format "best[ext=mp4]/best[ext=webm]/best" ${JSON.stringify(url)}`;

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


export const InstaDownloader = async (req, res) => {
  let url = req.body?.url || req.query?.url;
  if (typeof url === "string") url = decodeURIComponent(url);
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const result = await RunYtDpAll(url);
    const mediaMap = new Map();

    for (const format of result.formats || []) {
      if (!format.url) continue;
      if (
        format.ext === "m3u8" ||
        format.protocol?.includes("m3u8") ||
        format.url.includes(".m3u8")
      )
        continue;

      const vcodec = format.vcodec || "";
      const type = vcodec.includes("none") ? "audio" : "video";
      const qualityKey = format.format_note || `${format.height || "unknown"}p`;

      let priority = 0;
      if (format.ext === "mp4") priority = 100;
      else if (format.ext === "webm") priority = 80;
      else if (format.vcodec && format.vcodec !== "none") priority = 60;
      else priority = 10;

      const fileSize = format.filesize || format.filesize_approx || null;

      if (!mediaMap.has(qualityKey) || priority > (mediaMap.get(qualityKey).priority || 0)) {
        mediaMap.set(qualityKey, {
          url: format.url,
          quality: qualityKey,
          extension: format.ext || null,
          type,
          size_bytes: fileSize,
          size: formatFileSize(fileSize),
          priority,
        });
      }
    }

    if (mediaMap.size === 0 && result.url) {
      mediaMap.set("direct", {
        url: result.url,
        quality: "direct",
        extension: result.ext || null,
        type: "video",
        size_bytes: null,
        size: null,
        priority: 50,
      });
    }

    res.json({
      url: result.webpage_url || null,
      source: result.extractor_key || null,
      author: result.uploader || null,
      title: result.title || null,
      thumbnail: result.thumbnail || null,
      duration: result.duration || null,
      media: Array.from(mediaMap.values()).map(({ priority, ...rest }) => rest),
    });
  } catch (error) {
    console.error("yt-dlp error:", error);
    res.status(500).json({
      error: "yt-dlp execution failed",
      details: error.toString(),
    });
  }
};


