const ONE_HOUR_MS = 60 * 60 * 1000;

function authCookieOptions(env = process.env) {
  const publicHttps = Boolean(env.PUBLIC_BASE_URL) || env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: publicHttps,
    sameSite: publicHttps ? "none" : "lax",
    path: "/",
    maxAge: ONE_HOUR_MS,
  };
}

function clearAuthCookieOptions(env = process.env) {
  const { maxAge, ...options } = authCookieOptions(env);
  return options;
}

module.exports = { authCookieOptions, clearAuthCookieOptions };
