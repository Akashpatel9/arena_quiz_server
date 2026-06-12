import mongoose from "mongoose";
import Question from "../models/Question.js";
import { IMAGE_BASE_URL } from "../config/env.js";

/**
 * Serve questions IN SEQUENCE (the order they sit in MongoDB, _id ascending)
 * rather than randomly. The game state only remembers the last served
 * question id (`afterQuestionId`); the next question is the first one past
 * it that matches the arena's filter. When the pool is exhausted the
 * sequence wraps to the beginning — no recent-questions list needed.
 */
export async function pickQuestion(arenaGroup, afterQuestionId = null) {
  const match = buildMatch(arenaGroup);

  let picked = null;
  if (afterQuestionId && mongoose.isValidObjectId(afterQuestionId)) {
    picked = await Question.findOne({
      ...match,
      _id: { $gt: new mongoose.Types.ObjectId(afterQuestionId) },
    }).sort({ _id: 1 });
  }
  if (!picked) {
    // First question of a fresh sequence, or wrap-around at the end.
    picked = await Question.findOne(match).sort({ _id: 1 });
  }
  return picked;
}

function buildMatch(arenaGroup) {
  const filter = arenaGroup?.filter || {};
  const match = {};
  if (filter.subject?.length) match.subject = { $in: filter.subject };
  if (filter.chapter?.length) match.chapter = { $in: filter.chapter };
  if (filter.difficulty?.length) match.difficulty = { $in: filter.difficulty };
  // ArenaGroup.filter.question_type maps to qType in the question bank.
  if (filter.question_type?.length) match.qType = { $in: filter.question_type };
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
