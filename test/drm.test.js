/**
 * Locks in DRM detection. The regexes here decide whether a download is
 * attempted at all, and a false positive silently disables a working source —
 * so the negative cases matter as much as the positive ones.
 *
 *   node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isDrmUrl,
  isDrmError,
  isDrmPlaylist,
  allEntriesAreDrm,
} from "../src/utils/drm.js";

// Captured verbatim from a real GET /api/vimeo?url=https://vimeo.com/76979871
// on 2026-09-04, the response that returned "Download failed" with no reason.
const VIMEO_DRM_URL =
  "https://vod-adaptive-ak.vimeocdn.com/exp=1788511207~acl=%2Fccfaa6de-0af0-44cb-a61a-8ecebadb6ad1%2F%2A~hmac=56de47e6/ccfaa6de-0af0-44cb-a61a-8ecebadb6ad1/v2/playlist/drm/cbcs,derivedv2,ccfaa6de-0af0-44cb-a61a-8ecebadb6ad1,ed7ebc7c3bb14eeb8770374ffbd7512b/av/ccfaa6de/avf/ec6cca58/media.m3u8?pathsig=8c953e4f&st=video";

// The #EXT-X-KEY line served by that playlist.
const FAIRPLAY_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.006000,
segment.m4s`;

test("flags the real Vimeo DRM url", () => {
  assert.equal(isDrmUrl(VIMEO_DRM_URL), true);
});

test("flags a FairPlay playlist", () => {
  assert.equal(isDrmPlaylist(FAIRPLAY_PLAYLIST), true);
});

test("flags Widevine and PlayReady key formats", () => {
  assert.equal(
    isDrmPlaylist('#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.widevine.alpha"'),
    true
  );
  assert.equal(
    isDrmPlaylist('#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.microsoft.playready"'),
    true
  );
});

// The one that must never regress: plain AES-128 is ordinary HLS encryption.
// The key is a normal HTTP fetch and ffmpeg handles it, so treating it as DRM
// would refuse downloads that work today.
test("does NOT flag plain AES-128 HLS encryption", () => {
  assert.equal(
    isDrmPlaylist('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k.bin",IV=0x0'),
    false
  );
});

test("does not flag ordinary playlists or urls", () => {
  assert.equal(isDrmPlaylist("#EXTM3U\n#EXTINF:6.0,\nseg.ts"), false);
  assert.equal(isDrmUrl("https://dm.com/sec(abc)/video/x.m3u8"), false);
  assert.equal(isDrmUrl("https://skyfire.vimeocdn.com/a/v2/playlist/av/x/media.m3u8"), false);
  // "drm" as a substring of an unrelated word must not match.
  assert.equal(isDrmUrl("https://cdn.example/hydrmixer/master.m3u8"), false);
});

test("recognises yt-dlp DRM errors but not unrelated failures", () => {
  assert.equal(isDrmError("ERROR: [vimeo] 76979871: This video is DRM protected"), true);
  assert.equal(isDrmError("The requested site is known to use DRM protection."), true);
  assert.equal(
    isDrmError("ERROR: [vimeo] 1071084785: Unable to download webpage: HTTP Error 401"),
    false
  );
  assert.equal(isDrmError("ERROR: Unable to extract universal data"), false);
});

test("allEntriesAreDrm needs every entry to be encrypted", () => {
  // The six entries from the real response: 4 video renditions + 2 audio.
  const realMedia = Array.from({ length: 6 }, () => ({ url: VIMEO_DRM_URL }));
  assert.equal(allEntriesAreDrm(realMedia), true);

  // One clear route is enough to be worth attempting.
  assert.equal(
    allEntriesAreDrm([{ url: VIMEO_DRM_URL }, { url: "https://cdn/x.mp4" }]),
    false
  );

  // Empty means extraction failed — a different problem with a different message.
  assert.equal(allEntriesAreDrm([]), false);
  assert.equal(allEntriesAreDrm(null), false);
});
