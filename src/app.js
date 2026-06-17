import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createArenaRoutes } from "./routes/arenaRoutes.js";
import { errorHandler } from "./middleware/errorHandler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(liveStore) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) =>
    res.json({ ok: true, serverTime: Date.now() })
  );
  app.use("/api", createArenaRoutes(liveStore));

  // Minimal browser client for manual testing (public/index.html).
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.use(errorHandler);

  return app;
}
