import Question from "../models/Question.js";

/**
 * Data access for the read-only question bank. All Mongo reads of questions go
 * through here so the services never touch the model directly.
 */

/** Load a single question document by its id. */
export function findQuestionById(id) {
  return Question.findById(id);
}

/**
 * Serve a RANDOM question matching the arena's `filter` (MongoDB `$sample`).
 * `filter` is { subject?, chapter?, difficulty?, question_type? }, each an
 * array. Returns null when the filter matches nothing.
 *
 * `$sample` returns a plain object, so rehydrate it into a Mongoose doc —
 * callers read virtuals (`correctOption`, `explanation`) off the result.
 */
export async function pickQuestion(filter) {
  const [doc] = await Question.aggregate([
    { $match: buildMatch(filter) },
    { $sample: { size: 1 } },
  ]);
  return doc ? Question.hydrate(doc) : null;
}

function buildMatch(filter = {}) {
  const f = filter || {};
  const match = {};
  if (f.subject?.length) match.subject = { $in: f.subject };
  if (f.chapter?.length) match.chapter = { $in: f.chapter };
  if (f.difficulty?.length) match.difficulty = { $in: f.difficulty };
  // ArenaGroup.filter.question_type maps to qType in the question bank.
  if (f.question_type?.length) match.qType = { $in: f.question_type };
  // Only questions with a usable single correct answer (0..3).
  match["answer.0"] = { $in: [0, 1, 2, 3, "0", "1", "2", "3"] };
  return match;
}
