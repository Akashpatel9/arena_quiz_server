import http from "node:http";
import { connectDB } from "./config/db.js";
import { PORT, RESET_ONLINE_COUNTS, BOTS_ENABLED } from "./config/env.js";
import { createApp } from "./app.js";
import { createSocketServer } from "./config/socket.js";
import { createGameEngine } from "./services/gameEngine.js";
import { createLiveStore } from "./dal/liveStore.js";
import { createBotService } from "./services/botService.js";
import { registerArenaSockets } from "./sockets/arenaSocket.js";
import { resetAllOnlineCounts } from "./dal/arenaGroupDao.js";

async function main() {
  await connectDB();

  const liveStore = createLiveStore();
  if (!(await liveStore.ready())) {
    // The live game state lives in Redis — without it there is no game.
    console.error("[server] Redis is not reachable; cannot start");
    process.exit(1);
  }

  if (RESET_ONLINE_COUNTS) {
    // After a crash the counters can be stale (disconnects never ran).
    // Single-server only — disable via env when running multiple instances.
    await liveStore.resetOnlineCounts();
    await resetAllOnlineCounts();
  }

  const app = createApp(liveStore);
  const server = http.createServer(app);
  const io = createSocketServer(server);

  const bots = BOTS_ENABLED ? createBotService(io, liveStore) : null;
  const engine = createGameEngine(io, liveStore, {
    onQuestionStarted: bots ? bots.onQuestionStarted : undefined,
  });
  registerArenaSockets(io, engine, liveStore);

  // Games that were live when the process died pick up where they left off.
  await engine.recoverRunningGames();
  if (bots) await bots.start();

  server.listen(PORT, () => {
    console.log(`[server] arena server listening on http://localhost:${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // ignore a second SIGINT/SIGTERM
    shuttingDown = true;
    console.log("[server] shutting down");
    // Hard cap: exit even if a close() hangs.
    setTimeout(() => process.exit(0), 3000).unref();
    bots?.stop();
    engine.stop();
    try {
      await io.close(); // stop accepting connections, flush sockets
      await liveStore.close(); // clean Redis quit (drains in-flight writes)
    } catch (e) {
      console.error("[server] shutdown cleanup error:", e.message);
    }
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[server] fatal:", e);
  process.exit(1);
});
