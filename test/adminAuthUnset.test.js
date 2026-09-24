/**
 * The ADMIN_PASSWORD-unset case needs its own file.
 *
 * config.js reads the environment once at module load, and the node test
 * runner gives each file its own process — so this is the only way to observe
 * the middleware with an empty password without restructuring it to take one
 * as an argument. Clearing process.env inside the other file does nothing,
 * because config.js is already cached there.
 */
process.env.ADMIN_PASSWORD = "";

import test from "node:test";
import assert from "node:assert/strict";

const { verifyAdminPassword } = await import("../src/middleware/adminAuth.js");

test("an unset password refuses every action rather than opening them up", () => {
  for (const supplied of [undefined, "", "guess", "anything at all"]) {
    const res = {
      statusCode: 200, body: null,
      set() { return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    let nexted = false;
    verifyAdminPassword(
      { header: () => supplied, body: {}, ip: "10.0.0.9" },
      res,
      () => { nexted = true; }
    );

    // The failure mode worth guarding: an empty configured password must never
    // compare equal to an empty supplied one and let a caller straight through.
    assert.equal(nexted, false, `supplied ${JSON.stringify(supplied)} must not pass`);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error_code, "admin_not_configured");
  }
});
