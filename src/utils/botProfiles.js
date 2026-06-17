import { BOT_POOL_SIZE } from "../constants/bot.js";
import { mulberry32, pick } from "./random.js";

/**
 * The deterministic catalogue of bot identities and the mapping from auth_user
 * docs to the lightweight pool entries the bot service uses. Touches no
 * database — generated from a fixed seed so the create:bots script and the
 * server always agree on the same googleIds/names/photos.
 */

const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Arjun", "Reyansh", "Krishna", "Ishaan",
  "Shaurya", "Atharv", "Kabir", "Ananya", "Diya", "Aadhya", "Saanvi",
  "Pari", "Anika", "Navya", "Myra", "Ira", "Riya", "Rohan", "Karan",
  "Nikhil", "Siddharth", "Pranav", "Tanvi", "Sneha", "Pooja", "Kavya",
  "Meera", "Dev", "Yash",
];
const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Patel", "Singh", "Kumar", "Reddy", "Nair",
  "Iyer", "Joshi", "Mehta", "Agarwal", "Chauhan", "Mishra", "Das", "Bose",
  "Kulkarni", "Rao", "Pandey", "Malhotra",
];

/** The fixed list of bot identities (stable across the script and the server). */
export function botProfiles() {
  const rand = mulberry32(0xb07_5eed);
  return Array.from({ length: BOT_POOL_SIZE }, (_, i) => {
    const name = `${pick(FIRST_NAMES, rand)} ${pick(LAST_NAMES, rand)}`;
    return {
      googleId: `arena-bot-${i}`,
      email: `arena-bot-${i}@bots.arena.local`,
      name,
      photo: `https://i.pravatar.cc/150?img=${(i % 70) + 1}`,
    };
  });
}

/** Map auth_user docs to the lightweight pool entries the service uses. */
export function toPoolEntries(profiles, docs) {
  const byGoogleId = new Map(docs.map((d) => [d.googleId, d]));
  return profiles
    .map((p) => {
      const doc = byGoogleId.get(p.googleId);
      if (!doc) return null;
      return {
        userId: String(doc._id),
        name: doc.name || p.name,
        photo: doc.profilePicture || p.photo,
      };
    })
    .filter(Boolean);
}
