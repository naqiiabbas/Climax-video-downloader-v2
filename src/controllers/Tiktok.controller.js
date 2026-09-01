import { exec } from "child_process";
import axios from "axios";
import urlParse from "url-parse";

import { config } from "../config.js";

const ytdlp = config.ytdlpPath;

const allowedHosts = [
  "tiktokcdn.com",
  "tiktokv.com",
  "ttwstatic.com",
  "tiktokcdn-us.com",
  "v16-webapp-prime.us.tiktok.com",
  "v19-webapp-prime.us.tiktok.com",
];

// Helper to format bytes into MB/GB
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

// Helper to run yt-dlp
function runYtDlp(url) {
  return new Promise((resolve, reject) => {
  const command = `"${ytdlp}" --geo-bypass -j ${JSON.stringify(url)}`;

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

// Proxy handler
async function handleProxyRequest(targetUrl, res) {
  const parsedUrl = urlParse(targetUrl);
  const host = parsedUrl.host;

  const isAllowed = allowedHosts.some((allowedHost) =>
    host.includes(allowedHost)
  );
  if (!isAllowed)
    return res.status(403).json({ error: "Proxy blocked for this domain" });

  try {
    const { data, headers } = await axios.get(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.tiktok.com",
      },
      responseType: "arraybuffer",
    });

    Object.entries(headers).forEach(([key, value]) =>
      res.setHeader(key, value)
    );
    res.send(data);
  } catch (err) {
    console.error("Proxy error:", err.message || err);
    res.status(500).json({ error: "Error fetching the proxy URL" });
  }
}

// Main fetch function
export const FetchTiktok = async (req, res) => {
  let url = req.body?.url || req.query?.url;

  if (typeof url === "string") url = decodeURIComponent(url);
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const result = await runYtDlp(url);
    const httpHeaders = result.http_headers || {};

    let cookies = "";
    if (Array.isArray(result.cookies)) {
      cookies = result.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } else if (typeof result.cookies === "string") {
      cookies = result.cookies;
    }

    const mediaMap = new Map();

    for (const format of result.formats || []) {
      if (!format.url) continue;

      // Skip M3U8 formats
      if (
        format.ext === "m3u8" ||
        format.protocol === "m3u8" ||
        format.url.includes(".m3u8")
      ) {
        continue;
      }

      const vcodec = format.vcodec || "";
      const type = vcodec.includes("none") ? "audio" : "video";

      const headers = { ...httpHeaders };
      if (cookies) headers["Cookie"] = cookies;

      const qualityKey = format.format_note || `${format.height || "unknown"}p`;

      // Priority system for TikTok
      let priority = 0;
      if (format.ext === "mp4") priority = 100;
      else if (format.vcodec && format.vcodec !== "none") priority = 80;
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
          cookies: format.cookies || cookies,
          headers,
          priority,
        });
      }
    }

    const response = {
      url: result.webpage_url || null,
      source: result.extractor_key || null,
      author: result.uploader || null,
      thumbnail: result.thumbnail || null,
      title: result.title || null,
      duration: result.duration || null,
      media: Array.from(mediaMap.values()).map((item) => {
        const { priority, ...rest } = item;
        return rest;
      }),
    };

    res.json(response);
  } catch (error) {
    console.error("yt-dlp error:", error);
    res
      .status(500)
      .json({ error: "yt-dlp execution failed", details: error.toString() });
  }
};