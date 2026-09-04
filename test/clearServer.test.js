/**
 * DELETE /api/clear-server. Destructive, so the safety properties are tested
 * as hard as the happy path: it must not recurse, must not follow a symlink
 * out of the directory, and must leave the cache consistent afterwards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vd-clear-"));
const dir = path.join(root, "downloads");
fs.mkdirSync(dir);
process.env.DOWNLOADS_DIR = dir;
process.env.PUBLIC_BASE_URL = "https://example.test";
process.env.API_KEY = "test";

const { ClearServer, Status } = await import("../src/controllers/system.controller.js");
const { VideoCache } = await import("../src/utils/cache.js");

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

test("deletes every file and reports what it freed", async () => {
  const a = write("video_a.mp4", 2 * 1024 * 1024);
  write("video_b.mp4", 1024 * 1024);
  write("video_c.ts", 512 * 1024); // stray intermediate must go too
  VideoCache.setVideo("video_a.mp4", a);

  const res = fakeRes();
  await ClearServer(fakeReq, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.deleted_count, 3);
  assert.equal(res.body.failed_count, 0);
  assert.equal(res.body.freed_bytes, 3 * 1024 * 1024 + 512 * 1024);
  assert.equal(res.body.freed, "3.50 MB");
  assert.equal(fs.readdirSync(dir).length, 0, "directory must be empty");

  // Cache entries must not outlive the files they point at.
  assert.deepEqual(VideoCache.getAllVideos(), []);
});

test("/api/status reports zero straight after a clear", async () => {
  const res = fakeRes();
  await Status(fakeReq, res);
  assert.equal(res.body.count, 0);
  assert.equal(res.body.total_size_bytes, 0);
  assert.equal(res.body.orphaned_count, 0);
});

test("is idempotent — clearing an already empty server is a no-op", async () => {
  const res = fakeRes();
  await ClearServer(fakeReq, res);
  assert.equal(res.body.success, true);
  assert.equal(res.body.deleted_count, 0);
  assert.equal(res.body.freed, "0 B");
});

// Must never recurse. A subdirectory is skipped, not walked and emptied.
test("does not descend into subdirectories", async () => {
  const sub = path.join(dir, "keepme");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "inner.mp4"), "x");
  write("video_top.mp4", 1024);

  const res = fakeRes();
  await ClearServer(fakeReq, res);

  assert.equal(res.body.deleted_count, 1, "only the top-level file");
  assert.ok(fs.existsSync(path.join(sub, "inner.mp4")), "nested file must survive");
  fs.rmSync(sub, { recursive: true, force: true });
});

// The file outside downloads/ must survive: only the link is removed.
test("a symlink out of the directory cannot delete its target", async (t) => {
  const outside = path.join(root, "important.txt");
  fs.writeFileSync(outside, "do not delete");
  try {
    fs.symlinkSync(outside, path.join(dir, "escape.mp4"));
  } catch {
    return t.skip("symlinks not permitted in this environment");
  }

  const res = fakeRes();
  await ClearServer(fakeReq, res);

  assert.ok(fs.existsSync(outside), "target outside downloads/ must survive");
  assert.equal(fs.existsSync(path.join(dir, "escape.mp4")), false);
});

test("survives a missing downloads directory", async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  const res = fakeRes();
  await ClearServer(fakeReq, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted_count, 0);
});
