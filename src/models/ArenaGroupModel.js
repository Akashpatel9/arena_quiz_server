import mongoose from "mongoose";

const filterSchema = new mongoose.Schema(
  {
    subject: {
      type: [Number],
      default: [],
    },
    chapter: {
      type: [String],
      default: [],
    },
    difficulty: {
      type: [Number],
      enum: [1, 2, 3],
      default: [],
    },
    question_type: {
      type: [Number],
      default: []
    },
  },
  { _id: false }
);

const arenaGroupSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    subtitle: {
      type: String
    },
    description: {
      type: String,
      required: true,
    },
    online_user_count: {
      type: Number,
      default: 0,
      required: true,
    },
    image: {
      type: String,
      required: true,
    },
    status: {
      type: Number,
      enum: [0, 1, 2],   //0 for inactive, 1 for active and 2 for pending states
      default: 0,
      required: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    filter: filterSchema,
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

export default mongoose.model("ArenaGroup", arenaGroupSchema);
