import Question from "../models/Question.js";
import { IMAGE_BASE_URL } from "../config/env.js";

/**
 * Serve a RANDOM question matching the arena's `filter` (MongoDB `$sample`).
 * `filter` is { subject?, chapter?, difficulty?, question_type? }, each an
 * array. Returns null when the filter matches nothing.
 *
 * `$sample` returns a plain object, so rehydrate it into a Mongoose doc —
 * the engine reads virtuals (`correctOption`, `explanation`) off the result.
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

// Make relative bank paths ("img/x.svg") absolute; leave full URLs alone.
const img = (path) =>
  path ? (/^https?:/.test(path) ? path : IMAGE_BASE_URL + path.replace(/^\/+/, "")) : null;

/** Solution images for the result screen (text comes from .explanation). */
export function solutionImagesOf(question) {
  return (question.solutionImg || []).filter(Boolean).map(img);
}

/**
 * What clients are allowed to see while the question is live.
 * Options are {text, image} — either may be null (some options are images).
 * NEVER include answer/solution fields here.
 */
export function sanitizeQuestion(question) {
  const options = Array.from({ length: 4 }, (_, i) => ({
    text: question.optionsText?.[i] ?? null,
    image: img(question.optionsImg?.[i]),
  }));
  return {
    id: String(question._id),
    text: (question.text || []).filter(Boolean).join("\n"),
    images: (question.image || []).filter(Boolean).map(img),
    options,
    difficulty: question.difficulty,
    subject: question.subject,
    chapter: question.chapter,
    qType: question.qType,
    marks: question.marks,
  };
}
