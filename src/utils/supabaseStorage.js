import fs from "fs";
import NodeCache from "node-cache";
import { config } from "../config.js";

/**
 * Best-effort longer-lived copy of every converted file, alongside the
 * VPS-disk copy VideoCache already serves. No user auth of any kind — the
 * server uploads with the anon key alone, same security model as
 * /downloads/<file>, which is already unauthenticated.
 *
 * Supabase Storage has no built-in object-expiry feature, unlike the VPS disk
 * (which gets automatic cleanup for free via node-cache's TTL). This file
 * builds the same TTL-timer pattern in-process instead, just pointed at a
 * DELETE call to Storage's REST API rather than fs.unlink.
 *
 * A failed upload never fails the surrounding request — the VPS copy is
 * always the one guaranteed to exist, so callers treat this purely as an
 * optional enhancement and surface `error` rather than throwing.
 */

const cache = new NodeCache({
  stdTTL: config.supabaseStorage.ttlSeconds,
  checkperiod: Math.max(30, Math.floor(config.supabaseStorage.ttlSeconds / 60)),
});

cache.on("expired", (_key, objectName) => {
  deleteObject(objectName).catch((err) =>
    console.error(`Failed to delete expired Storage object ${objectName}:`, err.message)
  );
});

function objectUrl(objectName) {
  return `${config.supabase.url}/storage/v1/object/${config.supabaseStorage.bucket}/${objectName}`;
}

function publicUrl(objectName) {
  return `${config.supabase.url}/storage/v1/object/public/${config.supabaseStorage.bucket}/${objectName}`;
}

function contentTypeFor(filePath) {
  return filePath.endsWith(".mp4") ? "video/mp4" : "application/octet-stream";
}

/**
 * Uploads `filePath` as `objectName` and starts its TTL clock. Streams the
 * file rather than buffering it in memory — converted files run 10s of MB up
 * to several hundred, and the VPS is already carrying yt-dlp+ffmpeg for the
 * same request.
 *
 * Returns `{ url, error }` — `url` is null and `error` is set on any failure,
 * never throws. Returns `{ url: null, error: null }` immediately when
 * SUPABASE_STORAGE_ENABLED is not set, so this is a silent no-op until the
 * bucket and its policies (supabase/storage-schema.sql) are actually set up.
 */
export async function uploadAndTrack(filePath, objectName) {
  if (!config.supabaseStorage.enabled) return { url: null, error: null };
  if (!config.supabase.enabled) {
    return { url: null, error: "SUPABASE_URL/SUPABASE_ANON_KEY not configured" };
  }

  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    return { url: null, error: `Local file missing before upload: ${err.message}` };
  }

  try {
    const res = await fetch(objectUrl(objectName), {
      method: "POST",
      headers: {
        apikey: config.supabase.anonKey,
        Authorization: `Bearer ${config.supabase.anonKey}`,
        "Content-Type": contentTypeFor(filePath),
        "Content-Length": String(size),
        // Overwrite rather than error if the same object name is ever reused.
        "x-upsert": "true",
      },
      body: fs.createReadStream(filePath),
      duplex: "half", // required by Node's fetch (undici) for a streamed body
      signal: AbortSignal.timeout(config.supabaseStorage.uploadTimeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${text.slice(0, 200)}`);
    }

    cache.set(objectName, objectName);
    return { url: publicUrl(objectName), error: null };
  } catch (err) {
    const message = err.name === "TimeoutError" ? "Upload timed out" : err.message;
    console.error(`Supabase Storage upload failed for ${objectName}:`, message);
    return { url: null, error: message };
  }
}

export async function deleteObject(objectName) {
  const res = await fetch(objectUrl(objectName), {
    method: "DELETE",
    headers: {
      apikey: config.supabase.anonKey,
      Authorization: `Bearer ${config.supabase.anonKey}`,
    },
  });
  // 404 means it is already gone (e.g. manually removed) — not an error here.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete failed: ${res.status}`);
  }
}
