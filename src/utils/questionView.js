import { IMAGE_BASE_URL } from "../config/env.js";

/**
 * Presentation helpers that shape question bank documents into the payloads
 * clients are allowed to see. Pure functions — no database access.
 */

// Make relative bank paths ("img/x.svg") absolute; leave full URLs alone.
const img = (path) =>
  path
    ? /^https?:/.test(path)
      ? path
      : IMAGE_BASE_URL + path.replace(/^\/+/, "")
    : null;

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
