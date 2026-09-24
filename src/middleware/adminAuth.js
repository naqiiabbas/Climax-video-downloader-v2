import crypto from "crypto";
import { config } from "../config.js";

/**
 * Password gate for the /admin page.
 *
 * Separate from verifyStrongKey on purpose — see config.adminPassword. The API
 * key is extractable from the mobile binary; replacing cookies.txt should not
 * be possible with it.
 *
 * Unlike the API key, this secret is typed by a human, so it is short enough
 * to guess. The API has no rate limiting anywhere, which is tolerable for
 * endpoints that merely cost CPU but not for a password. Hence the lockout
 * below: without it an unlimited guess rate makes any human-memorable password
 * worthless.
 */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SWEEP_EVERY = 500;

/** ip -> { fails, lockedUntil }. In-process, so it resets on restart. */
const attempts = new Map();
let sinceSweep = 0;

/** Drop expired entries occasionally so a hostile IP range cannot grow this map forever. */
function sweep(now) {
  if (++sinceSweep < SWEEP_EVERY) return;
  sinceSweep = 0;
  for (const [ip, rec] of attempts) {
    if (rec.lockedUntil < now && rec.fails === 0) attempts.delete(ip);
    else if (rec.lockedUntil && rec.lockedUntil < now - LOCKOUT_MS) attempts.delete(ip);
  }
}

/**
 * Behind Caddy every request carries the proxy's IP, so trust the forwarded
 * header for rate-limit bucketing. It is spoofable, which only means an
 * attacker can avoid their own lockout — it cannot unlock anyone else, and the
 * password check itself never depends on it.
 */
function clientIp(req) {
  const fwd = req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

const timingSafeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const verifyAdminPassword = (req, res, next) => {
  if (!config.adminPassword) {
    return res.status(503).json({
      success: false,
      error: "Admin page is not configured. Set ADMIN_PASSWORD in .env.",
      error_code: "admin_not_configured",
    });
  }

  const now = Date.now();
  const ip = clientIp(req);
  const rec = attempts.get(ip);

  if (rec?.lockedUntil > now) {
    const retryAfter = Math.ceil((rec.lockedUntil - now) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({
      success: false,
      error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      error_code: "locked_out",
      retry_after_seconds: retryAfter,
    });
  }

  // Accept the password from a header (the page's fetch calls) or a multipart
  // field, because a file upload cannot always set one conveniently.
  const supplied = req.header("x-admin-password") || req.body?.password || "";

  if (supplied && timingSafeEqual(supplied, config.adminPassword)) {
    attempts.delete(ip);
    return next();
  }

  const fails = (rec?.fails || 0) + 1;
  const lockedUntil = fails >= MAX_ATTEMPTS ? now + LOCKOUT_MS : 0;
  attempts.set(ip, { fails: lockedUntil ? 0 : fails, lockedUntil });
  sweep(now);

  if (lockedUntil) {
    console.warn(`admin: locking out ${ip} after ${MAX_ATTEMPTS} failed attempts`);
    res.set("Retry-After", String(Math.ceil(LOCKOUT_MS / 1000)));
    return res.status(429).json({
      success: false,
      error: `Too many failed attempts. Try again in ${LOCKOUT_MS / 60000} minutes.`,
      error_code: "locked_out",
      retry_after_seconds: Math.ceil(LOCKOUT_MS / 1000),
    });
  }

  return res.status(401).json({
    success: false,
    error: "Wrong password",
    error_code: "bad_password",
    attempts_remaining: MAX_ATTEMPTS - fails,
  });
};

/** Test seam: lets the suite start from a clean slate between cases. */
export const _resetAttempts = () => attempts.clear();

export default verifyAdminPassword;
