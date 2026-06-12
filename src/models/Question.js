import mongoose from "mongoose";

/**
 * READ-ONLY view of the real `staging_QuestionBank` collection (owned by the
 * question-bank service — we never write to it).
 *
 * Real document shape (verified against the live collection, 2026-06-12):
 *   text:        [String]   question text (parts; join for display)
 *   image:       [String]   question images (relative paths, may be null)
 *   optionsText: [String]   4 entries; null when the option is an image
 *   optionsImg:  [String]   4 entries; image path per option (or null)
 *   answer:      [String|Number]  0-INDEXED correct option, single answer
 *                (verified: distinct values are 0..3, no multi-answer docs)
 *   solutionText/solutionImg     the explanation
 *   subject:Number · chapter:String ("6.1") · difficulty:1|2|3 · qType:Number
 */
const questionSchema = new mongoose.Schema(
  {
    text: { type: [String], default: [] },
    image: { type: [String], default: [] },
    optionsText: { type: [String], default: [] },
    optionsImg: { type: [String], default: [] },
    answer: { type: [mongoose.Schema.Types.Mixed], default: [] },
    solutionText: { type: [String], default: [] },
    solutionImg: { type: [String], default: [] },
    subject: { type: Number },
    chapter: { type: String },
    difficulty: { type: Number },
    qType: { type: Number },
    marks: { type: Number },
  },
  { collection: "staging_QuestionBank", strict: false, timestamps: false }
);

// The engine compares selectedOption === question.correctOption.
questionSchema.virtual("correctOption").get(function () {
  const n = Number(this.answer?.[0]);
  return Number.isInteger(n) ? n : null;
});

// The result screen shows question.explanation.
questionSchema.virtual("explanation").get(function () {
  return (this.solutionText || []).filter(Boolean).join("\n");
});

export default mongoose.model("question", questionSchema);
