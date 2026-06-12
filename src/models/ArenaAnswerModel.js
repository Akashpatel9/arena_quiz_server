import mongoose from "mongoose";

/**
 * One user's answer to one round of an arena game.
 *
 * The unique (arenaGroupId, round, userId) index is what enforces
 * "one answer per question" even across servers. `userName` is denormalized
 * at write time so building the result graph needs no extra lookups.
 */
const arenaAnswerSchema = new mongoose.Schema(
  {
    arenaGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ArenaGroup",
      required: true,
    },
    round: {
      type: Number,
      required: true,
    },
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "question",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "auth_user",
      required: true,
    },
    userName: {
      type: String,
      default: "",
    },
    // Denormalized like userName so the result graph can show the
    // answerer's photo without per-user lookups.
    userPhoto: {
      type: String,
      default: "",
    },
    selectedOption: {
      type: Number,
      required: true,
      min: 0,
      max: 3,
    },
    correct: {
      type: Boolean,
      required: true,
    },
    // Milliseconds from question start to the answer — the "speed" used to
    // rank correct answers on the result graph.
    timeTakenMs: {
      type: Number,
      required: true,
    },
    answeredAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

arenaAnswerSchema.index(
  { arenaGroupId: 1, round: 1, userId: 1 },
  { unique: true }
);

export default mongoose.model("arena_answer", arenaAnswerSchema);
