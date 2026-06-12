import http from "node:http";
import { Server } from "socket.io";
import { connectDB } from "./config/db.js";
import { PORT, RESET_ONLINE_COUNTS, BOTS_ENABLED } from "./config/env.js";
import { createApp } from "./app.js";
import { createGameEngine } from "./services/gameEngine.js";
import { createLiveStore } from "./services/liveStore.js";
import { createBotService } from "./services/botService.js";
import { registerArenaSockets } from "./sockets/arenaSocket.js";
import ArenaGroup from "./models/ArenaGroupModel.js";

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
    await ArenaGroup.updateMany({}, { $set: { online_user_count: 0 } });
  }

  const app = createApp(liveStore);
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: "*" }, // tighten for production
  });

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

  const shutdown = () => {
    console.log("[server] shutting down");
    bots?.stop();
    engine.stop();
    liveStore.close();
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[server] fatal:", e);
  process.exit(1);
});
