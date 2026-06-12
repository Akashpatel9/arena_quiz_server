/**
 * Seed a demo arena + question bank so the game is playable out of the box.
 *   npm run seed
 * Idempotent: clears and recreates only the demo arena and demo questions.
 */
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import ArenaGroup from "../src/models/ArenaGroupModel.js";
import Question from "../src/models/Question.js";
import { createLiveStore } from "../src/services/liveStore.js";

const SUBJECT_MATH = 1;
const CHAPTER = "Algebra";
const QUESTION_TYPE_MCQ = 1;

// difficulty: 1 easy (30s) / 2 medium (60s) / 3 hard (90s)
const QUESTIONS = [
  // ----- easy
  q(1, "What is 7 × 8?", ["54", "56", "63", "48"], 1, "7 × 8 = 56."),
  q(1, "Solve: x + 5 = 12", ["5", "6", "7", "8"], 2, "Subtract 5 from both sides: x = 12 − 5 = 7."),
  q(1, "What is 15% of 200?", ["20", "25", "30", "35"], 2, "15% of 200 = 0.15 × 200 = 30."),
  q(1, "Simplify: 2(x + 3) − 6", ["2x", "2x + 3", "x", "2x − 6"], 0, "2(x + 3) − 6 = 2x + 6 − 6 = 2x."),
  // ----- medium
  q(2, "If 3x − 4 = 2x + 9, what is x?", ["5", "9", "13", "−13"], 2, "3x − 2x = 9 + 4, so x = 13."),
  q(2, "What is the sum of the roots of x² − 5x + 6 = 0?", ["−5", "5", "6", "1"], 1, "For x² − 5x + 6 = 0, sum of roots = −b/a = 5 (roots are 2 and 3)."),
  q(2, "A train covers 240 km in 3 hours. Its speed in m/s is:", ["22.2", "80", "13.3", "44.4"], 0, "80 km/h = 80 × 1000 / 3600 ≈ 22.2 m/s."),
  q(2, "If log₁₀ 2 ≈ 0.301, then log₁₀ 8 is about:", ["0.602", "0.903", "1.204", "0.301"], 1, "log 8 = log 2³ = 3 × 0.301 = 0.903."),
  // ----- hard
  q(3, "How many real roots does x³ − 3x + 2 = 0 have?", ["0", "1", "2", "3"], 3, "x³ − 3x + 2 = (x − 1)²(x + 2): roots 1 (double) and −2 — three real roots counting multiplicity, two distinct. Counting with multiplicity: 3."),
  q(3, "The sum of the infinite series 1 + 1/2 + 1/4 + 1/8 + … is:", ["1.5", "2", "2.5", "∞"], 1, "Geometric series with a = 1, r = 1/2: sum = a / (1 − r) = 2."),
  q(3, "If f(x) = x² and g(x) = 2x + 1, what is f(g(2))?", ["9", "16", "25", "36"], 2, "g(2) = 5, then f(5) = 25."),
  q(3, "In how many ways can 5 people sit in a row if 2 must sit together?", ["24", "48", "120", "12"], 1, "Treat the pair as one unit: 4! × 2! = 24 × 2 = 48."),
];

// Demo questions in the REAL staging_QuestionBank shape (arrays everywhere,
// 0-indexed answer, solutionText for the explanation).
function q(difficulty, text, options, correctOption, explanation) {
  return {
    subject: SUBJECT_MATH,
    chapter: CHAPTER,
    difficulty,
    qType: QUESTION_TYPE_MCQ,
    text: [text],
    image: [],
    optionsText: options,
    optionsImg: [null, null, null, null],
    answer: [correctOption],
    solutionText: [explanation],
    solutionImg: [],
  };
}

async function main() {
  // Never write demo data into a real/staging database by accident.
  const uri = process.env.MONGODB_URI || "";
  if (uri && !/127\.0\.0\.1|localhost/.test(uri) && !process.argv.includes("--force")) {
    console.error(
      "[seed] MONGODB_URI points at a non-local database — refusing to seed.\n" +
        "[seed] The real DB already has arenagroups + staging_QuestionBank.\n" +
        "[seed] Use --force only if you really mean it."
    );
    process.exit(1);
  }
  await connectDB();

  await Question.deleteMany({ subject: SUBJECT_MATH, chapter: CHAPTER });
  const questions = await Question.insertMany(QUESTIONS);
  console.log(`[seed] inserted ${questions.length} questions`);

  await ArenaGroup.deleteMany({ title: "Math Arena (demo)" });
  const group = await ArenaGroup.create({
    title: "Math Arena (demo)",
    subtitle: "Algebra speed-run",
    description: "Live algebra quiz — answer fast, climb the speed graph.",
    image: "https://placehold.co/256x256?text=Math",
    status: 1,
    online_user_count: 0,
    tags: ["math", "algebra", "demo"],
    filter: {
      subject: [SUBJECT_MATH],
      chapter: [CHAPTER],
      difficulty: [1, 2, 3],
      question_type: [QUESTION_TYPE_MCQ],
    },
  });
  // Clear any stale live state for this arena in Redis.
  const liveStore = createLiveStore();
  if (await liveStore.ready(3000)) {
    await liveStore.clearArena(group._id);
  } else {
    console.warn("[seed] Redis unreachable — skipped clearing live state");
  }
  await liveStore.close();
  console.log(`[seed] arena group ready: ${group._id}`);

  await mongoose.disconnect();
  console.log("[seed] done");
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
