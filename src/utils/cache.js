import NodeCache from "node-cache";
import fs from "fs";
import { config } from "../config.js";

// Converted mp4 files are disposable: the cache TTL is also the file's lifetime
// on disk, so the VPS does not fill up with abandoned downloads.
const cache = new NodeCache({
  stdTTL: config.cacheTtlSeconds,
  checkperiod: Math.max(10, Math.floor(config.cacheTtlSeconds / 60)),
});

cache.on("expired", (key, filePath) => {
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log(`Auto-deleted expired video file: ${filePath}`);
    } catch (err) {
      console.error(`Failed to delete video file (${filePath}):`, err);
    }
  }
});

export const VideoCache = {
  setVideo: (key, filePath) => {
    if (fs.existsSync(filePath)) {
      cache.set(key, filePath);
      return true;
    }
    console.log(`File not found, skipping cache: ${filePath}`);
    return false;
  },

  getVideo: (key) => {
    const filePath = cache.get(key);
    if (filePath && fs.existsSync(filePath)) return filePath;
    return null;
  },

  removeVideo: (key) => {
    const filePath = cache.get(key);
    if (filePath) {
      cache.del(key);
      return filePath;
    }
    return null;
  },

  deleteVideoFile: (filePath) => {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        return true;
      } catch (err) {
        console.error(`Failed to delete video file (${filePath}):`, err);
        return false;
      }
    }
    return false;
  },

  getAllVideos: () => cache.keys(),

  /**
   * When `key` is due for deletion, as an epoch-ms timestamp, or null when the
   * cache is not tracking it.
   *
   * node-cache distinguishes three states that all have to be separated here:
   * `undefined` for an unknown key, `0` for a key with no TTL (never expires),
   * and a timestamp otherwise. Both of the first two mean "no deletion is
   * scheduled" — which for a file already on disk means it will sit there
   * forever, so /api/status has to be able to say so.
   */
  getExpiry: (key) => {
    const ttl = cache.getTtl(key);
    return ttl ? ttl : null;
  },

  /**
   * Drops every entry without touching the filesystem.
   *
   * Safe to call after deleting the files yourself: node-cache emits "flush"
   * here, not "expired", so the unlink handler above does not fire and there is
   * no second delete racing a filename that may have been reused.
   */
  flush: () => cache.flushAll(),
};

export default cache;
