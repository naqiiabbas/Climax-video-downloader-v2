/**
 * The 1080p ceiling has to hold in three places that could drift apart:
 * what is accepted (ALLOWED_QUALITIES), what is offered (availableQualities),
 * and what is downloaded (mergeToMp4's format selector).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_QUALITIES,
  MAX_QUALITY,
  MAX_HEIGHT,
  qualityCap,
  parseQuality,
  availableQualities,
} from "../src/utils/quality.js";

const v = (quality, size_bytes = 1000) => ({
  quality,
  has_video: true,
  has_audio: false,
  size_bytes,
  size: "1.00 KB",
});

test("2160 and 1440 are no longer accepted", () => {
  assert.equal(ALLOWED_QUALITIES.has("2160"), false);
  assert.equal(ALLOWED_QUALITIES.has("1440"), false);
  assert.equal(parseQuality("2160", null), null);
  assert.equal(parseQuality("1440", null), null);
});

test("1080 and below are still accepted", () => {
  for (const q of ["1080", "720", "480", "360", "240", "best"]) {
    assert.equal(parseQuality(q, null), q, `${q} should be accepted`);
  }
});

test("best is clamped to 1080 rather than reaching 4K", () => {
  assert.equal(qualityCap("best"), MAX_QUALITY);
  assert.equal(qualityCap("best"), "1080");
  assert.equal(qualityCap("480"), "480");
});

test("renditions above 1080 are never offered", () => {
  const out = availableQualities([v("2160p"), v("1440p"), v("1080p"), v("720p")]);
  assert.deepEqual(out.map((q) => q.quality), ["1080", "720"]);
  assert.ok(out.every((q) => q.height <= MAX_HEIGHT));
});

test("a 4K-only source offers nothing rather than an uncappable option", () => {
  assert.deepEqual(availableQualities([v("2160p"), v("1440p")]), []);
});

test("every offered value is one the endpoint accepts", () => {
  const out = availableQualities([v("2160p"), v("1080p"), v("380p"), v("144p")]);
  assert.ok(out.length > 0);
  for (const q of out) assert.ok(ALLOWED_QUALITIES.has(q.quality), `${q.quality} rejected`);
});
