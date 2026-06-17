import { expectedError } from "../utils/expectedError.js";

/**
 * Pure answer validation and record construction — no Mongo, no Redis, no
 * sockets. The game engine checks the live game/phase against its cache, then
 * hands the validated game + question here; keeping this side-effect-free means
 * it can be unit-tested directly, the same way resultBuilder.js is.
 */

const MIN_OPTION = 0;
const MAX_OPTION = 3;

/** Reject anything that isn't an integer 0..3. Throws an EXPECTED error. */
export function validateSelectedOption(selectedOption) {
  if (
    !Number.isInteger(selectedOption) ||
    selectedOption < MIN_OPTION ||
    selectedOption > MAX_OPTION
  ) {
    throw expectedError("BAD_OPTION", "selectedOption must be an integer 0..3");
  }
}

/**
 * Build the stored answer record for one submission.
 *
 *  @param arenaGroupId  the arena the answer belongs to
 *  @param user          { userId, name, photo } of the answering player
 *  @param game          the live game (must be in its question phase)
 *  @param question      the round's question document
 *  @param selectedOption the chosen option (already validated)
 *  @param now           submission time (epoch ms)
 *
 * `timeTakenMs` is clamped to [0, questionDurationMs] so a late-but-in-grace
 * answer never reports a time beyond the question's own duration.
 */
export function buildAnswerRecord({
  arenaGroupId,
  user,
  game,
  question,
  selectedOption,
  now,
}) {
  const elapsed = now - game.phaseStartedAt.getTime();
  const timeTakenMs = Math.min(
    Math.max(0, elapsed),
    game.questionDurationMs ?? elapsed
  );
  return {
    arenaGroupId: String(arenaGroupId),
    round: game.round,
    questionId: String(game.questionId),
    userId: String(user.userId),
    userName: user.name || "",
    userPhoto: user.photo || "",
    selectedOption,
    correct: selectedOption === question.correctOption,
    timeTakenMs,
    answeredAt: new Date(now).toISOString(),
  };
}
