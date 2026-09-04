import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { VideoCache } from "../utils/cache.js";
import { cookieStatus } from "../utils/cookies.js";
import { formatFileSize } from "../utils/media.js";
import { publicDownloadUrl } from "../utils/mergeDownload.js";

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
  // Reports whether the jar is USABLE, not merely present. Deployment creates
  // an empty cookies.txt for the bind mount, and reporting that as `true` hides
  // the fact that no login-gated source can work.
  const cookies = cookieStatus();

  // Without an API key every protected route returns 500, so the service is
  // running but useless. Report 503 rather than "ok": the Docker HEALTHCHECK
  // then marks the container unhealthy instead of showing a reassuring
  // "healthy" next to a service that cannot answer a single real request.
  const apiKeyConfigured = Boolean(config.apiKey);

  res.status(apiKeyConfigured ? 200 : 503).json({
    status: apiKeyConfigured ? "ok" : "degraded",
    api_key_configured: apiKeyConfigured,
    uptime: Math.round(process.uptime()),
    cookies: cookies.usable,
    cookies_detail: cookies.reason,
    cachedVideos: VideoCache.getAllVideos().length,
    timestamp: new Date().toISOString(),
  });
};

/**
 * GET /api/status — what converted files are on disk, how much space they take
 * and when each one goes away.
 *
 * Reads the DIRECTORY, not just the cache, and that distinction is the point.
 * VideoCache is in-memory and its TTL handler is what deletes files, but
 * ./downloads is a bind mount that outlives the container. So every restart
 * strands the files it was tracking: they stay on disk with no deletion
 * scheduled, forever. Listing only the cache would report a tidy server while
 * the disk fills up. Anything on disk the cache does not know about is reported
 * with `auto_delete: false` and counted in `orphaned_*`.
 */
export const Status = async (req, res) => {
  try {
    let names;
    try {
      names = await fs.promises.readdir(config.downloadsDir);
    } catch (err) {
      if (err.code === "ENOENT") names = []; // nothing downloaded yet
      else throw err;
    }

    const now = Date.now();
    const videos = [];
    let totalBytes = 0;
    let orphanedBytes = 0;

    for (const name of names) {
      const filePath = path.join(config.downloadsDir, name);

      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue; // deleted between readdir and stat — a TTL expiry racing us
      }
      if (!stat.isFile()) continue;

      const expiryMs = VideoCache.getExpiry(name);
      const tracked = expiryMs !== null;

      totalBytes += stat.size;
      if (!tracked) orphanedBytes += stat.size;

      videos.push({
        key: name,
        file_url: publicDownloadUrl(req, name),
        extension: path.extname(name).replace(/^\./, "") || null,
        size_bytes: stat.size,
        size: formatFileSize(stat.size),
        created_at: stat.mtime.toISOString(),
        expires_at: tracked ? new Date(expiryMs).toISOString() : null,
        // Negative would mean the sweep has not fired yet; floor at 0 so the
        // client never renders "expires in -12s".
        expires_in_seconds: tracked ? Math.max(0, Math.round((expiryMs - now) / 1000)) : null,
        auto_delete: tracked,
      });
    }

    // Soonest deletion first, so "what disappears next" is at the top.
    // Orphans never expire, so they sort last.
    videos.sort((a, b) => {
      if (a.expires_at && b.expires_at) return a.expires_in_seconds - b.expires_in_seconds;
      if (a.expires_at) return -1;
      if (b.expires_at) return 1;
      return a.created_at.localeCompare(b.created_at);
    });

    const orphanedCount = videos.filter((v) => !v.auto_delete).length;

    // Free space on the volume holding ./downloads. This box also runs Postgres
    // and MinIO, so "how much room is left" matters as much as "how much am I
    // using". Best-effort: statfs is not available everywhere.
    let disk = null;
    try {
      const fsStat = await fs.promises.statfs(config.downloadsDir);
      const freeBytes = fsStat.bsize * fsStat.bavail;
      const totalDiskBytes = fsStat.bsize * fsStat.blocks;
      disk = {
        free_bytes: freeBytes,
        free: formatFileSize(freeBytes),
        total_bytes: totalDiskBytes,
        total: formatFileSize(totalDiskBytes),
        used_percent: totalDiskBytes
          ? Math.round(((totalDiskBytes - freeBytes) / totalDiskBytes) * 100)
          : null,
      };
    } catch {
      // Informational only; never fail the request over it.
    }

    res.json({
      success: true,
      count: videos.length,
      total_size_bytes: totalBytes,
      total_size: formatFileSize(totalBytes) || "0 B",
      cache_ttl_seconds: config.cacheTtlSeconds,
      orphaned_count: orphanedCount,
      orphaned_size_bytes: orphanedBytes,
      orphaned_size: formatFileSize(orphanedBytes) || "0 B",
      disk,
      generated_at: new Date().toISOString(),
      videos,
    });
  } catch (err) {
    console.error("Status error:", err);
    res.status(500).json({ success: false, error: "Failed to read download status" });
  }
};

/**
 * DELETE /api/clear-server — removes every converted file immediately.
 *
 * Registered as DELETE, not GET, deliberately. `/api/delete-video` is a GET
 * because it takes one named file and a mistake there costs one file; this
 * wipes everything, and a GET can be fired by a link prefetch, a crawler or a
 * stray click in an API client. The method is the guard rail.
 *
 * Sweeps the DIRECTORY rather than the cache, for the same reason /api/status
 * does: a restart strands the files the cache was tracking, and those orphans
 * are usually the bulk of what needs clearing. The cache is flushed afterwards
 * so its entries do not outlive the files they point at.
 *
 * Nothing here is precious — every file is regenerable by re-requesting it, and
 * would have been deleted at its TTL anyway. The one real cost is breaking a
 * download already in flight.
 */
export const ClearServer = async (req, res) => {
  try {
    let names;
    try {
      names = await fs.promises.readdir(config.downloadsDir);
    } catch (err) {
      if (err.code === "ENOENT") names = []; // nothing to clear
      else throw err;
    }

    const deleted = [];
    const failed = [];
    let freedBytes = 0;

    for (const name of names) {
      // basename() so a crafted directory entry can never escape downloadsDir.
      const filePath = path.join(config.downloadsDir, path.basename(name));

      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue; // vanished under us — a TTL expiry racing this sweep
      }
      // Only ever unlink plain files; never recurse, never follow a directory.
      if (!stat.isFile()) continue;

      try {
        await fs.promises.unlink(filePath);
        deleted.push({ key: name, size_bytes: stat.size, size: formatFileSize(stat.size) });
        freedBytes += stat.size;
      } catch (err) {
        // A locked or root-owned file: report it rather than pretending.
        failed.push({ key: name, error: err.code || err.message });
      }
    }

    // Drop the now-dangling entries. Does not fire the unlink handler.
    VideoCache.flush();

    console.log(
      `clear-server: deleted ${deleted.length} file(s), freed ${formatFileSize(freedBytes) || "0 B"}` +
        (failed.length ? `, ${failed.length} failed` : "")
    );

    res.json({
      success: failed.length === 0,
      deleted_count: deleted.length,
      freed_bytes: freedBytes,
      freed: formatFileSize(freedBytes) || "0 B",
      failed_count: failed.length,
      deleted,
      failed,
      cleared_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("ClearServer error:", err);
    res.status(500).json({ success: false, error: "Failed to clear downloads" });
  }
};
