import fs from "fs";
import { config } from "../config.js";

/**
 * Guards against handing yt-dlp an unusable cookie jar.
 *
 * `docker-compose` bind-mounts cookies.txt, so the file has to exist before the
 * container starts — deployment docs tell you to `touch` it. That leaves an
 * EMPTY file on disk, and `yt-dlp --cookies` on an empty file aborts every
 * request with:
 *
 *   ERROR: './cookies.txt' does not look like a Netscape format cookies file
 *
 * Checking existence alone is therefore not enough: the file must also be
 * non-empty, carry the Netscape header, and hold at least one real entry.
 */

const NETSCAPE_HEADER = /^#\s*(?:Netscape\s+HTTP\s+Cookie\s+File|HTTP\s+Cookie\s+File)/im;

export function cookieStatus() {
  let stat;
  try {
    stat = fs.statSync(config.cookiesPath);
  } catch {
    return { usable: false, reason: "missing" };
  }

  if (!stat.isFile()) return { usable: false, reason: "not-a-file" };
  if (stat.size === 0) return { usable: false, reason: "empty" };

  let head;
  try {
    head = fs.readFileSync(config.cookiesPath, "utf8").slice(0, 8192);
  } catch {
    return { usable: false, reason: "unreadable" };
  }

  if (!NETSCAPE_HEADER.test(head)) {
    return { usable: false, reason: "not-netscape-format" };
  }

  const hasEntry = head
    .split(/\r?\n/)
    .some((l) => l.trim() && !l.trim().startsWith("#"));
  if (!hasEntry) return { usable: false, reason: "no-entries" };

  return { usable: true, reason: "ok" };
}

export const hasUsableCookies = () => cookieStatus().usable;

/** `--cookies "<path>" ` for the shell-string callers, or "" when unusable. */
export function cookieArgString() {
  return hasUsableCookies()
    ? `--cookies ${JSON.stringify(config.cookiesPath)} `
    : "";
}

/** `["--cookies", "<path>"]` for the execFile callers, or [] when unusable. */
export function cookieArgList() {
  return hasUsableCookies() ? ["--cookies", config.cookiesPath] : [];
}
