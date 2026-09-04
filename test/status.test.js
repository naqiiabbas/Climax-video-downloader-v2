/**
 * GET /api/status. Exercises the controller directly with a fake req/res so
 * the tracked-vs-orphaned split and the expiry maths are covered without
 * needing yt-dlp or a real download.
 *
 * Env has to be set before importing config.js, which reads it at module load,
 * hence the dynamic imports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-status-"));
process.env.DOWNLOADS_DIR = dir;
process.env.PUBLIC_BASE_URL = "https://example.test";
process.env.CACHE_TTL_SECONDS = "3600";
process.env.API_KEY = "test";

const { Status } = await import("../src/controllers/system.controller.js");
const { VideoCache } = await import("../src/utils/cache.js");

/** Minimal express double: captures the status code and JSON body. */
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
}
const fakeReq = { protocol: "https", get: () => "example.test" };

const write = (name, bytes) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
};

test("counts files, sums their size, and dates each deletion", async () => {
  const tracked = write("video_tracked.mp4", 2 * 1024 * 1024);
  write("video_orphan.mp4", 1024 * 1024);

  // Only the first is registered, as if the second survived a restart.
  assert.equal(VideoCache.setVideo("video_tracked.mp4", tracked), true);

  const res = fakeRes();
  await Status(fakeReq, res);
  const b = res.body;

  assert.equal(res.statusCode, 200);
  assert.equal(b.success, true);
  assert.equal(b.count, 2);
  assert.equal(b.total_size_bytes, 3 * 1024 * 1024);
  assert.equal(b.total_size, "3.00 MB");
  assert.equal(b.cache_ttl_seconds, 3600);

  const byKey = Object.fromEntries(b.videos.map((v) => [v.key, v]));

  const t = byKey["video_tracked.mp4"];
  assert.equal(t.auto_delete, true);
  assert.ok(t.expires_at, "tracked file must carry a deletion time");
  assert.equal(t.file_url, "https://example.test/downloads/video_tracked.mp4");
  assert.equal(t.size, "2.00 MB");
  // Scheduled one TTL out, within a second of tolerance for test runtime.
  const secs = (new Date(t.expires_at) - Date.now()) / 1000;
  assert.ok(secs > 3595 && secs <= 3600, `expected ~3600s, got ${secs}`);
  assert.ok(t.expires_in_seconds > 3595 && t.expires_in_seconds <= 3600);

  // The one the cache lost: on disk, no deletion scheduled, ever.
  const o = byKey["video_orphan.mp4"];
  assert.equal(o.auto_delete, false);
  assert.equal(o.expires_at, null);
  assert.equal(o.expires_in_seconds, null);

  assert.equal(b.orphaned_count, 1);
  assert.equal(b.orphaned_size_bytes, 1024 * 1024);
});

test("sorts soonest deletion first, orphans last", async () => {
  const res = fakeRes();
  await Status(fakeReq, res);
  const order = res.body.videos.map((v) => v.auto_delete);
  // Once a false appears, no true may follow it.
  assert.deepEqual(order, [...order].sort((a, b) => Number(b) - Number(a)));
});

test("reports zero cleanly when nothing is downloaded", async () => {
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  const res = fakeRes();
  await Status(fakeReq, res);
  assert.equal(res.body.count, 0);
  assert.equal(res.body.total_size_bytes, 0);
  assert.equal(res.body.total_size, "0 B");
  assert.equal(res.body.orphaned_count, 0);
  assert.deepEqual(res.body.videos, []);
});

test("does not fail when the downloads directory is missing", async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  const res = fakeRes();
  await Status(fakeReq, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 0);
});
