// Vimeo.controller.js - prefer mp4 per quality, fallback to m3u8, single entry per quality
import { execFile } from "child_process";
import util from "util";

const execFileP = util.promisify(execFile);
import { config } from "../config.js";

const ytdlp = config.ytdlpPath;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function extractVimeoId(url) {
  const m =
    url.match(/vimeo\.com\/(?:video\/)?(?:channels\/[^\/]+\/)?(?:ondemand\/[^\/]+\/)?([0-9]+)/) ||
    url.match(/player\.vimeo\.com\/video\/([0-9]+)/);
  return m ? m[1] : null;
}

/** Extract all top-level JSON objects from a text blob (robust to strings/escapes) */
function extractAllJsonObjects(text) {
  const out = [];
  if (!text || typeof text !== "string") return out;
  let i = 0;
  while (true) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let strChar = null;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (ch === "\\" && inStr) { esc = true; continue; }
      if (inStr) {
        if (ch === strChar) { inStr = false; strChar = null; }
        continue;
      } else {
        if (ch === '"' || ch === "'") { inStr = true; strChar = ch; continue; }
        if (ch === "{") depth++;
        if (ch === "}") {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }
    }
    if (end === -1) break;
    out.push(text.slice(start, end + 1));
    i = end + 1;
  }
  return out;
}

async function runYtDlp(args = []) {
  try {
    const { stdout, stderr } = await execFileP(ytdlp, args, { maxBuffer: 1024 * 1024 * 120 });
    return { stdout: stdout || "", stderr: stderr || "" };
  } catch (err) {
    return { stdout: (err.stdout || "") + "", stderr: (err.stderr || err.message || "") + "", error: err };
  }
}

async function probe(url, extraHeaders = []) {
  const args = ["-j", "--no-warnings", "--no-playlist", "--user-agent", USER_AGENT];
  for (const h of extraHeaders) args.push("--add-header", h);
  args.push(url);
  return await runYtDlp(args);
}

function humanSize(bytes) {
  if (bytes == null || isNaN(bytes)) return null;
  const b = Number(bytes);
  if (b === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  const v = b / Math.pow(1024, i);
  const format = i >= 2 ? v.toFixed(1) : Math.round(v);
  return `${format} ${units[i]}`;
}

function pickMeta(o = {}) {
  return {
    url: o.webpage_url || o.original_url || o.url || null,
    source: o.extractor_key || o.extractor || null,
    author: o.uploader || o.uploader_id || o.uploader_name || null,
    thumbnail: o.thumbnail || null,
    title: o.title || null,
    duration: o.duration || null,
  };
}

function isHlsFormat(f, url) {
  if (!f && !url) return false;
  if (typeof url === "string" && url.includes(".m3u8")) return true;
  if (f?.ext === "m3u8") return true;
  if (typeof f?.format_id === "string" && f.format_id.startsWith("hls-")) return true;
  return false;
}

function isMp4Format(f, url) {
  if (!f && !url) return false;
  if (typeof url === "string" && url.includes(".mp4")) return true;
  if (f?.ext === "mp4") return true;
  if (f?.vcodec && !f.vcodec.includes("none") && f.ext !== "m3u8") return true;
  return false;
}

function qualityKeyFor(f) {
  if (!f) return "unknown";
  
  // Use actual height if available
  if (f.height) return `${f.height}p`;
  
  // Parse from format_note if it contains resolution info
  if (f.format_note) {
    const note = String(f.format_note);
    const resolutionMatch = note.match(/(\d+)\s*p/);
    if (resolutionMatch) return `${resolutionMatch[1]}p`;
    return note;
  }
  
  // Parse from format_id if it contains resolution info
  if (f.format_id) {
    const id = String(f.format_id);
    const resolutionMatch = id.match(/(\d+)\s*p/) || id.match(/http-(\d+)p/);
    if (resolutionMatch) return `${resolutionMatch[1]}p`;
    return id;
  }
  
  return "unknown";
}

function scoreFormat(f) {
  const h = Number(f?.height || 0);
  const tbr = Number(f?.tbr || 0);
  const fs = Number(f?.filesize || f?.filesize_approx || 0);
  return (h * 1000000) + (tbr * 1000) + (fs / 1024);
}

function normalizeQuality(quality) {
  if (!quality) return "unknown";
  
  const str = String(quality);
  
  // Extract resolution number
  const resolutionMatch = str.match(/(\d+)\s*p/);
  if (resolutionMatch) {
    return `${resolutionMatch[1]}p`;
  }
  
  // Handle format_id patterns like "http-240p"
  const formatIdMatch = str.match(/http-(\d+)p/);
  if (formatIdMatch) {
    return `${formatIdMatch[1]}p`;
  }
  
  return str;
}

function calculateSizeBytes(chosen, meta) {
  // Try direct filesize first
  if (chosen.filesize && Number.isFinite(Number(chosen.filesize))) {
    return Number(chosen.filesize);
  }
  
  // Try approximate filesize
  if (chosen.filesize_approx && Number.isFinite(Number(chosen.filesize_approx))) {
    return Number(chosen.filesize_approx);
  }
  
  // Calculate from bitrate and duration
  if (chosen.tbr && meta.duration) {
    const bitrate = Number(chosen.tbr) * 1000; // Convert kbps to bps
    const duration = Number(meta.duration);
    if (bitrate > 0 && duration > 0) {
      return (bitrate / 8) * duration;
    }
  }
  
  // Estimate based on resolution and duration (for video)
  const vcodec = chosen.vcodec || "";
  const isVideo = !(typeof vcodec === "string" && vcodec.includes("none"));
  
  if (isVideo && meta.duration && chosen.height) {
    const duration = Number(meta.duration);
    if (duration > 0) {
      // Enhanced bitrate estimation based on resolution
      const bitrateEstimates = {
        144: 200_000,    // 200 kbps
        240: 400_000,    // 400 kbps  
        360: 800_000,    // 800 kbps
        480: 1_200_000,  // 1.2 Mbps
        540: 1_500_000,  // 1.5 Mbps
        720: 2_500_000,  // 2.5 Mbps
        1080: 4_000_000, // 4 Mbps
        1440: 8_000_000, // 8 Mbps
        2160: 15_000_000, // 15 Mbps
      };
      
      const height = Number(chosen.height);
      let bitrate = 2_000_000; // Default 2 Mbps
      
      // Find closest resolution
      const resolutions = Object.keys(bitrateEstimates).map(Number).sort((a, b) => a - b);
      for (const res of resolutions) {
        if (height <= res) {
          bitrate = bitrateEstimates[res];
          break;
        }
      }
      // Use highest bitrate if resolution is above our max
      if (height > Math.max(...resolutions)) {
        bitrate = bitrateEstimates[2160];
      }
      
      return (bitrate / 8) * duration;
    }
  }
  
  // For audio formats
  if (!isVideo && meta.duration) {
    const duration = Number(meta.duration);
    if (duration > 0) {
      // Audio bitrate estimation (128-320 kbps depending on quality)
      let audioBitrate = 128_000; // 128 kbps default
      if (chosen.format_note && chosen.format_note.includes('high')) {
        audioBitrate = 320_000; // 320 kbps for high quality audio
      } else if (chosen.format_note && chosen.format_note.includes('low')) {
        audioBitrate = 96_000; // 96 kbps for low quality audio
      }
      return (audioBitrate / 8) * duration;
    }
  }
  
  return null;
}

// Express-style handler
export const FetchVimeo = async (req, res) => {
  let url = req.body?.url || req.query?.url;
  if (typeof url === "string") url = decodeURIComponent(url);
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try { new URL(url); } catch (e) { return res.status(400).json({ error: "Invalid URL" }); }

  try {
    const vid = extractVimeoId(url);
    const referer = vid ? `https://vimeo.com/${vid}` : "https://vimeo.com/";
    const headers = [`Referer: ${referer}`];

    // primary probe
    let { stdout, stderr } = await probe(url, headers);

    // if nothing useful, try player URL
    if ((!stdout || stdout.trim() === "") && vid) {
      const player = `https://player.vimeo.com/video/${vid}`;
      ({ stdout, stderr } = await probe(player, [`Referer: https://vimeo.com/${vid}`]));
    }

    const allFormats = [];
    let meta = {};

    const sTrim = (stdout || "").trim();
    if (sTrim) {
      try {
        const parsedWhole = JSON.parse(sTrim);
        if (Array.isArray(parsedWhole)) {
          for (const obj of parsedWhole) {
            if (obj?.formats) for (const f of obj.formats) if (f?.url) allFormats.push(f);
            meta = { ...meta, ...pickMeta(obj) };
          }
        } else if (typeof parsedWhole === "object" && parsedWhole !== null) {
          if (parsedWhole.formats) for (const f of parsedWhole.formats) if (f?.url) allFormats.push(f);
          meta = { ...meta, ...pickMeta(parsedWhole) };
        }
      } catch (_) {
        const candidates = extractAllJsonObjects(stdout || "");
        for (const c of candidates) {
          try {
            const o = JSON.parse(c);
            if (o?.formats) for (const f of o.formats) if (f?.url) allFormats.push(f);
            meta = { ...meta, ...pickMeta(o) };
          } catch (_) {}
        }
      }
    }

    // Group formats by quality
    const qualityGroups = new Map();
    for (const f of allFormats) {
      if (!f || !f.url) continue;
      const q = qualityKeyFor(f);
      if (!qualityGroups.has(q)) qualityGroups.set(q, []);
      qualityGroups.get(q).push(f);
    }

    // For each quality pick one format (prefer progressive mp4)
    const selectedUrls = new Set();
    const media = [];

    for (const [quality, arr] of qualityGroups.entries()) {
      let progressiveCandidates = arr.filter(f => !isHlsFormat(f, f.url) && (f.ext === "mp4" || !f.url.includes(".m3u8")));
      if (progressiveCandidates.length === 0) {
        progressiveCandidates = arr.filter(f => !isHlsFormat(f, f.url));
      }

      let chosen = null;
      if (progressiveCandidates.length > 0) {
        chosen = progressiveCandidates.reduce((best, cur) => (scoreFormat(cur) > scoreFormat(best) ? cur : best));
      } else {
        const hlsCandidates = arr.filter(f => isHlsFormat(f, f.url));
        if (hlsCandidates.length > 0) {
          chosen = hlsCandidates.reduce((best, cur) => (scoreFormat(cur) > scoreFormat(best) ? cur : best));
        }
      }

      if (!chosen || !chosen.url) continue;
      if (selectedUrls.has(chosen.url)) continue;
      selectedUrls.add(chosen.url);

      // Calculate size for ALL formats
      const sizeBytes = calculateSizeBytes(chosen, meta);
      
      // Normalize quality label
      const finalQuality = normalizeQuality(quality);

      const vcodec = chosen.vcodec || "";
      const type = (typeof vcodec === "string" && vcodec.includes("none")) ? "audio" : "video";

      media.push({
        url: chosen.url,
        format_id: chosen.format_id || null,
        quality: finalQuality,
        extension: (chosen.url && chosen.url.includes(".m3u8"))
          ? "m3u8"
          : (chosen.ext || null),
        type,
        size_bytes: sizeBytes ? Math.round(sizeBytes) : null,
        size: humanSize(sizeBytes),
      });
    }

    // Sort media by quality (highest first)
    media.sort((a, b) => {
      const aRes = parseInt(a.quality) || 0;
      const bRes = parseInt(b.quality) || 0;
      return bRes - aRes;
    });

    // NEW CONDITION: Filter to only MP4 formats if available
    let finalMedia = media;
    const mp4Media = media.filter(item => 
      isMp4Format({ ext: item.extension, vcodec: item.type === 'video' ? 'avc' : 'none' }, item.url)
    );

    if (mp4Media.length > 0) {
      finalMedia = mp4Media;
    }

    const response = {
      url: meta.url || null,
      source: meta.source || null,
      author: meta.author || null,
      thumbnail: meta.thumbnail || null,
      title: meta.title || null,
      duration: meta.duration || null,
      media: finalMedia,
      format_preference: mp4Media.length > 0 ? 'mp4_only' : 'all_formats',
      ...(finalMedia.length === 0 ? {
        debug: {
          stderr_sample: (stderr || "").slice(0, 2000),
          stdout_sample: (stdout || "").slice(0, 2000),
        },
      } : {}),
    };

    return res.json(response);
  } catch (err) {
    console.error("FetchVimeo error:", err);
    return res.status(500).json({ error: "Server error", details: err?.toString?.() || String(err) });
  }
};