/**
 * availableQualities() feeds the client's quality picker, so a wrong entry
 * promises a resolution or size the server cannot deliver.
 *
 *   npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { availableQualities, parseQuality, ALLOWED_QUALITIES } from "../src/utils/quality.js";

const v = (quality, size_bytes) => ({
  quality,
  has_video: true,
  has_audio: false,
  size_bytes,
  size: size_bytes ? `${(size_bytes / 1048576).toFixed(2)} MB` : null,
});

test("lists one entry per distinct rendition, tallest first", () => {
  const out = availableQualities([
    v("1080p", 12_497_303),
    v("720p", 6_200_000),
    v("480p", 3_100_000),
    v("240p", 900_000),
  ]);
  assert.deepEqual(
    out.map((q) => q.quality),
    ["1080", "720", "480", "240"]
  );
  assert.equal(out[0].size_bytes, 12_497_303);
  // Source renditions are video-only; the merged mp4 gains an audio track.
  assert.ok(out.every((q) => q.size_is_estimate === true));
});

// Every value offered must be one the endpoint actually accepts, or the picker
// would render a button that 400s (or silently falls back to the default).
test("only ever offers accepted ?quality= values", () => {
  const out = availableQualities([v("1080p"), v("380p"), v("144p")]);
  for (const q of out) {
    assert.ok(ALLOWED_QUALITIES.has(q.quality), `${q.quality} is not accepted`);
    assert.equal(parseQuality(q.quality, "1080"), q.quality);
  }
});

// A 380p rendition is reached with quality=360 (yt-dlp's res: sort picks the
// nearest height), so the value to send and the height to display differ.
test("maps an off-ladder height to the value that reaches it", () => {
  const [entry] = availableQualities([v("380p", 2_000_000)]);
  assert.equal(entry.quality, "360");
  assert.equal(entry.label, "380p");
  assert.equal(entry.height, 380);
});

test("collapses renditions that map to the same value, keeping the taller", () => {
  const out = availableQualities([v("380p", 2_000_000), v("360p", 1_800_000)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].height, 380);
  assert.equal(out[0].size_bytes, 2_000_000);
});

test("ignores audio-only and unlabelled entries", () => {
  const out = availableQualities([
    v("1080p", 100),
    { quality: "English, low", has_video: false, has_audio: true },
    { quality: "audio-128k", has_video: false, has_audio: true },
    { quality: "unknown", has_video: true },
    { quality: "direct", has_video: true },
  ]);
  assert.deepEqual(out.map((q) => q.quality), ["1080"]);
});

test("returns an empty list rather than throwing on bad input", () => {
  assert.deepEqual(availableQualities([]), []);
  assert.deepEqual(availableQualities(null), []);
  assert.deepEqual(availableQualities(undefined), []);
  assert.deepEqual(availableQualities([{}, null]), []);
});
