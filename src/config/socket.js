import { Server } from "socket.io";
import { SOCKET_CORS_ORIGIN } from "./env.js";

/**
 * Socket.IO server options, kept here so server.js stays a thin bootstrap.
 *
 * CORS origin is driven by SOCKET_CORS_ORIGIN (see env.js): a comma-separated
 * allow-list in production, or "*" by default for local development.
 */
export const socketOptions = {
  cors: {
    origin: SOCKET_CORS_ORIGIN,
    methods: ["GET", "POST"],
  },
};

/** Build the Socket.IO server bound to an existing HTTP server. */
export function createSocketServer(httpServer) {
  return new Server(httpServer, socketOptions);
}
