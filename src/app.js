import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import mongoose from "mongoose";
import { createArenaRoutes } from "./routes/arenaRoutes.js";
import { errorHandler } from "./middleware/errorHandler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(liveStore) {
  const app = express();
  // Explicit cap (the API only takes tiny JSON bodies); rejects oversized posts.
  app.use(express.json({ limit: "16kb" }));

  // Reports real dependency health so a process manager / load balancer can
  // drain an unhealthy node. Redis is fatal (no live game without it); Mongo
  // readyState 1 === connected.
  app.get("/health", (_req, res) => {
    const redisOk = liveStore.isHealthy();
    const mongoOk = mongoose.connection.readyState === 1;
    const ok = redisOk && mongoOk;
    res.status(ok ? 200 : 503).json({
      ok,
      serverTime: Date.now(),
      redis: redisOk,
      mongo: mongoOk,
    });
  });
  app.use("/api", createArenaRoutes(liveStore));

  // Minimal browser client for manual testing (public/index.html).
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.use(errorHandler);

  return app;
}
