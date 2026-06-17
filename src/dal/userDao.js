import AuthUser from "../models/AuthUser.js";

/**
 * Data access for auth_user documents (real players and simulated bots).
 */

/** Load a user by id (Mongoose doc). */
export function findUserById(id) {
  return AuthUser.findById(id);
}

/** Create a user document. */
export function createUser(doc) {
  return AuthUser.create(doc);
}

/**
 * Upsert the shared pool of bot users from their fixed profiles. Idempotent:
 * matches on googleId and only sets fields on insert.
 */
export function upsertBotUsers(profiles) {
  return AuthUser.bulkWrite(
    profiles.map((p) => ({
      updateOne: {
        filter: { googleId: p.googleId },
        update: {
          $setOnInsert: {
            googleId: p.googleId,
            email: p.email,
            name: p.name,
            profilePicture: p.photo,
            isBot: true,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

/** Lightweight bot user docs for the given googleIds (read-only). */
export function findBotUsersByGoogleIds(googleIds) {
  return AuthUser.find({ isBot: true, googleId: { $in: googleIds } })
    .select("_id googleId name profilePicture")
    .lean();
}

/** Lightweight user docs for the given googleIds, regardless of isBot. */
export function findUsersByGoogleIds(googleIds) {
  return AuthUser.find({ googleId: { $in: googleIds } })
    .select("_id googleId name profilePicture")
    .lean();
}
