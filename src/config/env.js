import dotenv from "dotenv";

dotenv.config();

export const PORT = Number(process.env.PORT) || 3000;
export const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/arena";
export const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
// CDN/S3 prefix for relative image paths from the question bank
// (normalized to always end with exactly one "/").
export const IMAGE_BASE_URL = process.env.IMAGE_BASE_URL
  ? process.env.IMAGE_BASE_URL.replace(/\/+$/, "") + "/"
  : "";
// Allowed CORS origins for Socket.IO. Comma-separated list, or "*" (default)
// to allow any origin. Tighten this in production via env.
export const SOCKET_CORS_ORIGIN = process.env.SOCKET_CORS_ORIGIN
  ? process.env.SOCKET_CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : "*";
export const RESET_ONLINE_COUNTS =
  (process.env.RESET_ONLINE_COUNTS ?? "true") !== "false";
// Simulated players in every arena (see services/botService.js).
export const BOTS_ENABLED = (process.env.BOTS_ENABLED ?? "true") !== "false";
