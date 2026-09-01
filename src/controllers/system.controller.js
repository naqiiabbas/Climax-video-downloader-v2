import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { VideoCache } from "../utils/cache.js";

/**
 * Replaces cookies.txt, which yt-dlp uses to reach login-gated content
 * (Instagram in particular). Uploaded from the admin frontend.
 */
export const UpdateCookies = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No file uploaded. Please attach a cookies.txt file.",
      });
    }

    const file = req.file;

    if (file.mimetype !== "text/plain") {
      return res.status(400).json({
        success: false,
        error: `Invalid file type (${file.mimetype}). Only plain text (.txt) files are allowed.`,
      });
    }

    if (path.extname(file.originalname).toLowerCase() !== ".txt") {
      return res.status(400).json({
        success: false,
        error: "Invalid file extension. Only .txt files are allowed.",
      });
    }

    if (file.size === 0) {
      return res.status(400).json({ success: false, error: "The uploaded file is empty." });
    }

    // Netscape cookie jars start with this header; reject anything else so a
    // stray text file cannot silently break every extractor.
    const text = file.buffer.toString("utf8");
    if (!/^#\s*(Netscape\s+HTTP\s+Cookie\s+File|HTTP\s+Cookie\s+File)/im.test(text)) {
      return res.status(400).json({
        success: false,
        error: "File does not look like a Netscape-format cookies.txt export.",
      });
    }

    await fs.promises.writeFile(config.cookiesPath, file.buffer, { mode: 0o600 });

    res.json({
      success: true,
      message: "cookies.txt updated successfully.",
      fileName: path.basename(config.cookiesPath),
      fileSize: `${(file.size / 1024).toFixed(2)} KB`,
      uploadedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error updating cookies:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error while updating cookies file.",
    });
  }
};

/** Deletes a converted mp4 ahead of its TTL. */
export const DeleteVideo = (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ success: false, error: "Missing video URL" });
  }

  try {
    // Take the basename only — never let a caller walk out of downloadsDir.
    const fileName = path.basename(decodeURIComponent(String(url)));
    const filePath = path.join(config.downloadsDir, fileName);

    if (path.dirname(path.resolve(filePath)) !== config.downloadsDir) {
      return res.status(400).json({ success: false, error: "Invalid file name" });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: "File not found on server" });
    }

    const deleted = VideoCache.deleteVideoFile(filePath);
    VideoCache.removeVideo(fileName);

    if (!deleted) {
      return res.status(500).json({ success: false, error: "Failed to delete video file" });
    }

    return res.json({
      success: true,
      message: "Video deleted successfully",
      file: fileName,
    });
  } catch (err) {
    console.error("Manual delete error:", err);
    return res.status(500).json({ success: false, error: "Failed to delete video" });
  }
};

/** Liveness probe for the VPS / container orchestrator. */
export const Health = (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    cookies: fs.existsSync(config.cookiesPath),
    cachedVideos: VideoCache.getAllVideos().length,
    timestamp: new Date().toISOString(),
  });
};
