/**
 * The admin password gate. This secret is typed by a human, so unlike the API
 * key it is short enough to guess — the lockout is the only thing standing
 * between a weak password and an offline dictionary run at HTTP speed. Its
 * edges are worth pinning down.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_PASSWORD = "correct-horse";
const { verifyAdminPassword, _resetAttempts } = await import("../src/middleware/adminAuth.js");

function call(password, ip) {
  const req = {
    header: (h) =>
      h.toLowerCase() === "x-admin-password"
        ? password
        : h.toLowerCase() === "x-forwarded-for"
          ? ip
          : undefined,
    body: {},
    ip: ip || "1.2.3.4",
  };
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let nexted = false;
  verifyAdminPassword(req, res, () => { nexted = true; });
  return { res, nexted };
}

test("the right password passes", () => {
  _resetAttempts();
  const { nexted } = call("correct-horse", "10.0.0.1");
  assert.equal(nexted, true);
});

test("a wrong password is rejected and counts down", () => {
  _resetAttempts();
  const { res, nexted } = call("nope", "10.0.0.2");
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error_code, "bad_password");
  assert.equal(res.body.attempts_remaining, 4);
});

test("an absent password is rejected, not treated as empty-equals-empty", () => {
  _resetAttempts();
  const { res, nexted } = call(undefined, "10.0.0.3");
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
});

test("locks out after 5 failures", () => {
  _resetAttempts();
  const ip = "10.0.0.4";
  for (let i = 1; i <= 4; i++) {
    assert.equal(call("wrong", ip).res.statusCode, 401, `attempt ${i} should still be 401`);
  }
  const fifth = call("wrong", ip);
  assert.equal(fifth.res.statusCode, 429);
  assert.equal(fifth.res.body.error_code, "locked_out");
  assert.ok(fifth.res.headers["Retry-After"], "must tell the client when to retry");
});

// The property that matters: a lockout an attacker can step around is decoration.
test("the CORRECT password is refused while locked out", () => {
  _resetAttempts();
  const ip = "10.0.0.5";
  for (let i = 0; i < 5; i++) call("wrong", ip);
  const { res, nexted } = call("correct-horse", ip);
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 429);
});

test("a lockout is per-IP, so one attacker cannot lock everyone out", () => {
  _resetAttempts();
  for (let i = 0; i < 5; i++) call("wrong", "10.0.0.6");
  assert.equal(call("wrong", "10.0.0.6").res.statusCode, 429);
  assert.equal(call("correct-horse", "10.0.0.7").nexted, true, "a different IP is unaffected");
});

test("a success clears the failure count", () => {
  _resetAttempts();
  const ip = "10.0.0.8";
  call("wrong", ip);
  call("wrong", ip);
  assert.equal(call("correct-horse", ip).nexted, true);
  // Back to a full budget rather than one failure from lockout.
  assert.equal(call("wrong", ip).res.body.attempts_remaining, 4);
});
