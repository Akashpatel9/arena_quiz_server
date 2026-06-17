import { Router } from "express";
import mongoose from "mongoose";
import { listActiveArenas } from "../dal/arenaGroupDao.js";

export function createArenaRoutes(liveStore) {
  const router = Router();

  // Active arenas a user can join.
  router.get("/arena-groups", async (_req, res, next) => {
    try {
      const groups = await listActiveArenas();
      res.json({ ok: true, data: groups });
    } catch (e) {
      next(e);
    }
  });

  // Lightweight peek at an arena's live state (debugging / lobby preview).
  router.get("/arena-groups/:id/state", async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ ok: false, message: "Bad arena id" });
      }
      const [game, humans, bots] = await Promise.all([
        liveStore.getGame(req.params.id),
        liveStore.getOnline(req.params.id),
        liveStore.getBotCount(req.params.id),
      ]);
      const counts = { online: humans + bots, humans, bots };
      res.json({
        ok: true,
        data: game
          ? {
              status: game.status,
              phase: game.phase,
              round: game.round,
              phaseEndsAt: game.phaseEndsAt,
              ...counts,
              serverTime: Date.now(),
            }
          : {
              status: "idle",
              phase: null,
              round: 0,
              ...counts,
              serverTime: Date.now(),
            },
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
