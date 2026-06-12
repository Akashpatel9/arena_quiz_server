import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: false, trim: true },
    profilePicture: { type: String, required: false },
    coins: { type: Number, default: 100, min: 100 },
    onboardingCompleted: { type: Boolean, default: false },
    // Simulated arena players (services/botService.js). Filter these out of
    // any real-user queries/analytics.
    isBot: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model("auth_user", userSchema);
