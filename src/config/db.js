import mongoose from "mongoose";
import { MONGODB_URI } from "./env.js";

export async function connectDB() {
  mongoose.connection.on("error", (err) => {
    console.error("[db] connection error:", err.message);
  });
  await mongoose.connect(MONGODB_URI);
  console.log(`[db] connected to ${MONGODB_URI}`);
}
