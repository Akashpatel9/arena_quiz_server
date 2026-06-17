/**
 * Create the shared pool of simulated bot users in Mongo.
 *   npm run create:bots
 *
 * This is a deliberate one-off provisioning step. The server no longer creates
 * bots on startup — it only loads whatever this script has already created, so
 * arenas run without bots until you run this. Idempotent: re-running upserts
 * the same fixed pool (no duplicates).
 */
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import { createBotPool } from "../src/services/botService.js";

async function main() {
  await connectDB();
  const pool = await createBotPool();
  console.log(`[create:bots] ${pool.length} bot profiles ready in Mongo`);
  await mongoose.disconnect();
  console.log("[create:bots] done");
}

main().catch((e) => {
  console.error("[create:bots] failed:", e);
  process.exit(1);
});
