import crypto from "node:crypto";
import mongoose from "mongoose";
import { findUserById, createUser } from "../dal/userDao.js";

/**
 * Socket.IO connection middleware: resolve the player for this connection.
 * Clients pass { userId, name } in `socket.handshake.auth`; an unknown/missing
 * userId gets a guest account (the client must persist the userId from the
 * `session` event to stay the same player across reconnects).
 *
 * NOTE: this is intentionally permissive for development. Production should
 * verify a signed token (e.g. the Google-login JWT) here instead.
 */
export async function socketAuth(socket, next) {
  try {
    const { userId, name } = socket.handshake.auth || {};
    let user = null;
    if (userId && mongoose.isValidObjectId(userId)) {
      user = await findUserById(userId);
    }
    if (!user) {
      const uid = crypto.randomUUID();
      user = await createUser({
        googleId: `guest-${uid}`,
        email: `guest-${uid}@arena.local`,
        name: name?.trim() || `Guest-${uid.slice(0, 5)}`,
      });
    }
    socket.data.userId = String(user._id);
    socket.data.name = user.name || "Player";
    socket.data.photo = user.profilePicture || "";
    next();
  } catch (e) {
    next(e);
  }
}
