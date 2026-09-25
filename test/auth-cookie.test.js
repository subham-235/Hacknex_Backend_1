const test = require("node:test");
const assert = require("node:assert/strict");
const { authCookieOptions, clearAuthCookieOptions } = require("../src/config/authCookie");

test("auth cookies remain compatible with local HTTP development", () => {
  assert.deepEqual(authCookieOptions({}), {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 1000,
  });
});

test("public deployments use secure cross-site authentication cookies", () => {
  const options = authCookieOptions({ PUBLIC_BASE_URL: "https://api.example.com" });
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, true);
  assert.equal(options.sameSite, "none");
  assert.deepEqual(clearAuthCookieOptions({ NODE_ENV: "production" }), {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
});
