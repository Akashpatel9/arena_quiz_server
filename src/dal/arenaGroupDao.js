import ArenaGroup from "../models/ArenaGroupModel.js";

/**
 * Data access for arena definitions in Mongo. ArenaGroup holds durable
 * reference data plus a best-effort `online_user_count` used only for lobby
 * display (Redis stays the authoritative live count).
 */

/** Full active-arena documents (lobby list). */
export function listActiveArenas() {
  return ArenaGroup.find({ status: 1 }).lean();
}

/** A single arena document by id (Mongoose doc, not lean). */
export function findArenaById(id) {
  return ArenaGroup.findById(id);
}

/** Ids of every active arena (bot population / refresh). */
export async function listActiveArenaIds() {
  const groups = await ArenaGroup.find({ status: 1 }).select("_id").lean();
  return groups.map((g) => String(g._id));
}

/** Best-effort lobby count for one arena. */
export function setOnlineCount(id, count) {
  return ArenaGroup.updateOne(
    { _id: id },
    { $set: { online_user_count: count } }
  );
}

/** Best-effort lobby counts for many arenas in one round-trip. */
export function bulkSetOnlineCounts(updates) {
  return ArenaGroup.bulkWrite(updates, { ordered: false });
}

/** Zero every arena's lobby count (single-server boot cleanup). */
export function resetAllOnlineCounts() {
  return ArenaGroup.updateMany({}, { $set: { online_user_count: 0 } });
}
