import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { cookieStatus } from "../utils/cookies.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** GET /admin — the page itself. Public: it is a login form, it holds no secrets. */
export const AdminPage = (_req, res) => {
  res.sendFile(path.join(here, "..", "public", "admin.html"));
};

/**
 * GET /admin/status — cookie jar state, behind the password.
 *
 * Reports whether the jar is USABLE rather than merely present: deployment
 * creates an empty cookies.txt for the docker bind mount, and `yt-dlp
 * --cookies` on an empty file aborts every request. See utils/cookies.js.
 */
export const AdminStatus = (_req, res) => {
  const cookies = cookieStatus();
  res.json({
    success: true,
    cookies: {
      usable: cookies.usable,
      reason: cookies.reason,
      path: path.basename(config.cookiesPath),
    },
    instagram_ready: cookies.usable,
  });
};

/**
 * POST /admin/test — does Instagram actually work now?
 *
 * Calls this server's own /api/instagram over loopback with the real API key,
 * so it exercises the exact path the mobile app takes — cookie jar, yt-dlp
 * flags and all — rather than approximating it. Uploading a jar and being told
 * "saved" is not the same as knowing it works; a jar can be valid Netscape
 * format and still be logged out.
 */
export const AdminTest = async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) {
    return res.status(400).json({ success: false, error: "Paste an Instagram URL to test" });
  }
  if (!config.apiKey) {
    return res.status(503).json({
      success: false,
      error: "API_KEY is not set on this server, so the test cannot run.",
    });
  }

  const target = `http://127.0.0.1:${config.port}/api/instagram?url=${encodeURIComponent(url)}`;

  try {
    const r = await fetch(target, {
      headers: { "x-api-key": config.apiKey },
      signal: AbortSignal.timeout(90_000),
    });
    const body = await r.json().catch(() => null);

    if (!r.ok) {
      // yt-dlp's stderr is the useful part — it says "login required",
      // "empty media response", "rate-limited" and so on.
      return res.json({
        success: false,
        status: r.status,
        error: body?.error || `Extraction failed (${r.status})`,
        details: String(body?.details || "").slice(0, 600),
      });
    }

    const media = Array.isArray(body?.media) ? body.media : [];
    return res.json({
      success: true,
      title: body?.title || null,
      author: body?.author || null,
      thumbnail: body?.thumbnail || null,
      formats: media.length,
      downloadable: media.filter((m) => m.has_video && m.has_audio && !m.needs_conversion).length,
    });
  } catch (err) {
    return res.status(504).json({
      success: false,
      error: err.name === "TimeoutError" ? "Test timed out after 90s" : "Test request failed",
      details: String(err.message || err).slice(0, 300),
    });
  }
};
