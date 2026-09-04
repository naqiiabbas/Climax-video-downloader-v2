/**
 * DRM detection.
 *
 * Vimeo now serves FairPlay/Widevine-encrypted CBCS streams for at least some
 * videos and publishes NO progressive mp4 alongside them, so every delivery
 * route is encrypted. yt-dlp reads the manifest fine — that is why extraction
 * still returns a full media[] with resolutions and sizes — but it cannot
 * decrypt the segments, so the download fails.
 *
 * Without this, that surfaced as a generic "Download failed" and, worse,
 * /api/downloads/mp4 would happily fetch the encrypted segments and remux them
 * into a cached file that plays back as garbage.
 *
 * The critical distinction is SAMPLE-AES vs AES-128. Plain
 * `#EXT-X-KEY:METHOD=AES-128` is ordinary HLS encryption: the key is a normal
 * HTTP fetch and ffmpeg/m3u8stream handle it. Only the DRM key systems below
 * are undownloadable, so this must never flag AES-128.
 */

/** DRM markers in a CDN URL. Vimeo puts `/playlist/drm/cbcs,...` in the path. */
const DRM_URL_RE = /\/drm\/(?:cbcs|cenc)|[?&/]drm[=/]|\/playlist\/drm\//i;

/** DRM markers in yt-dlp's stderr. */
const DRM_ERROR_RE =
  /\bDRM[\s-]?protect|\bis\s+DRM\b|known to use DRM|widevine|playready|fairplay|com\.apple\.streamingkeydelivery/i;

/**
 * DRM markers inside an HLS playlist body. SAMPLE-AES, an `skd://` key URI or
 * a DRM KEYFORMAT all mean the segments need a licence server.
 */
const DRM_PLAYLIST_RE =
  /#EXT-X-KEY:[^\n]*(?:METHOD=SAMPLE-AES|KEYFORMAT="?(?:com\.apple\.streamingkeydelivery|com\.widevine|com\.microsoft\.playready|urn:uuid))|URI="skd:\/\//i;

export const isDrmUrl = (url) => DRM_URL_RE.test(String(url || ""));

export const isDrmError = (text) => DRM_ERROR_RE.test(String(text || ""));

export const isDrmPlaylist = (text) => DRM_PLAYLIST_RE.test(String(text || ""));

/**
 * True when every playable entry is DRM-encrypted, so attempting a merge is
 * guaranteed to fail. Lets the caller skip a doomed download that would
 * otherwise run until yt-dlp gives up.
 *
 * Requires a non-empty list: an empty media[] means extraction failed, which
 * is a different problem with a different message.
 */
export function allEntriesAreDrm(media) {
  return (
    Array.isArray(media) && media.length > 0 && media.every((m) => isDrmUrl(m?.url))
  );
}

/** Shared copy so every endpoint explains this the same way. */
export const DRM_MESSAGE =
  "This video is DRM protected and cannot be downloaded.";

export const DRM_CODE = "drm_protected";

/**
 * Fetches an HLS playlist and reports whether its segments are DRM-encrypted.
 *
 * Checks the URL first (free), then the body. Follows ONE level of indirection
 * because `#EXT-X-KEY` lives in the media playlist, not the master: a master
 * that only lists variants would otherwise look clean.
 *
 * Never blocks on uncertainty. A timeout, a 403 or an unparseable body returns
 * `unchecked` rather than `isDrm`, so a network hiccup cannot break a download
 * that would have worked — the merge itself still fails safely later.
 */
export async function playlistIsDrm(url, { timeoutMs = 8000, depth = 1 } = {}) {
  if (isDrmUrl(url)) return { isDrm: true, reason: "url" };

  let text;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { isDrm: false, reason: `unchecked-http-${res.status}` };
    // Playlists are text and small; cap it so a mislabelled media file cannot
    // pull a whole video into memory.
    text = (await res.text()).slice(0, 256 * 1024);
  } catch (err) {
    return { isDrm: false, reason: `unchecked-${err.name || "error"}` };
  }

  if (!text.includes("#EXTM3U")) return { isDrm: false, reason: "not-a-playlist" };
  if (isDrmPlaylist(text)) return { isDrm: true, reason: "playlist-key" };

  // Master playlist: recurse into the first variant, where the key would be.
  if (depth > 0 && /#EXT-X-STREAM-INF/i.test(text)) {
    const variant = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (variant) {
      try {
        const abs = new URL(variant, url).toString();
        return await playlistIsDrm(abs, { timeoutMs, depth: depth - 1 });
      } catch {
        // Unresolvable variant URI — treat as unchecked, not as DRM.
      }
    }
  }

  return { isDrm: false, reason: "clear" };
}
