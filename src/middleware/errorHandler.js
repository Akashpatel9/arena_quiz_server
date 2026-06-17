/** Express error-handling middleware: log the error and return a 500. */
export function errorHandler(err, _req, res, _next) {
  console.error("[http] error:", err);
  res.status(500).json({ ok: false, message: "Internal server error" });
}
