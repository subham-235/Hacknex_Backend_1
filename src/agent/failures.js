// Classify without logging raw provider messages, prompts or credentials.
function classifyFailure(error, source = "agent") {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = error?.code || error?.cause?.code;
  const message = String(error?.message || error?.cause?.message || "");
  if (status === 429)
    return {
      code: "RATE_LIMITED",
      retry: true,
      message: `${source} rate limit or quota reached. Check provider quota if this persists.`,
    };
  if (
    [408, 499, 504].includes(status) ||
    ["AbortError", "TimeoutError"].includes(error?.name) ||
    /timed?\s*out|timeout|deadline|aborted/i.test(message)
  )
    return {
      code: "TIMEOUT",
      retry: true,
      message: `${source} request exceeded its deadline.`,
    };
  if ([500, 502, 503].includes(status))
    return {
      code: "PROVIDER_UNAVAILABLE",
      retry: true,
      message: `${source} is temporarily unavailable (HTTP ${status}).`,
    };
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code) ||
    (error?.name === "TypeError" && /fetch|network/i.test(message))
  )
    return {
      code: "NETWORK",
      retry: true,
      message: `${source} connection failed. Check network access and service reachability.`,
    };
  if ([400, 401, 403, 404].includes(status))
    return {
      code: "CONFIGURATION",
      retry: false,
      message: `${source} rejected the request (HTTP ${status}). Check the model, credentials and API permissions.`,
    };
  return {
    code: "UNEXPECTED",
    retry: false,
    message: `${source} failed unexpectedly. Review worker code and configuration.`,
  };
}
function retryDelay(failures, config) {
  return Math.min(
    config.retryMaxMs || 600000,
    (config.retryBaseMs || 60000) *
      2 ** Math.min(Math.max(failures - 1, 0), 10),
  );
}
module.exports = { classifyFailure, retryDelay };
