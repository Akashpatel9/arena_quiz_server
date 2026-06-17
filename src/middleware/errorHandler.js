/**
 * Express error-handling middleware.
 *
 * Expected (rule-violation) errors — those built by expectedError() — carry a
 * `code` and are client-facing: return them as 400 with { code, message } and
 * don't log them as crashes. Anything else is an unexpected failure: log it and
 * return an opaque 500.
 */
export function errorHandler(err, _req, res, _next) {
  if (err?.expected) {
    return res.status(400).json({ ok: false, code: err.code, message: err.message });
  }
  console.error("[http] error:", err);
  res.status(500).json({ ok: false, code: "INTERNAL", message: "Internal server error" });
}
