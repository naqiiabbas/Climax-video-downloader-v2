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
};

export default cache;
