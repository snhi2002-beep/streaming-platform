import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { AppError } from "../../errors/app-error.js";
import { AUTH_CONSTANTS } from "../../config/constants.js";

export const profilesRouter = Router();

const createProfileSchema = z.object({
  name: z.string().min(1).max(64),
  avatarUrl: z.string().url().optional(),
  isKidsProfile: z.boolean().default(false),
  maxMaturityRating: z.enum(["G", "PG", "PG_13", "R", "NC_17"]).default("NC_17"),
  preferredAudioLanguage: z.string().min(2).max(16).default("en"),
  preferredSubtitleLanguage: z.string().min(2).max(16).optional(),
  subtitlesEnabled: z.boolean().default(false),
});

profilesRouter.use(requireAuth);

profilesRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profiles = await prisma.profile.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "asc" },
    });
    res.json({ success: true, data: profiles });
  } catch (err) {
    next(err);
  }
});

profilesRouter.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createProfileSchema.parse(req.body);
    const existingCount = await prisma.profile.count({
      where: { userId: req.user!.id },
    });

    if (existingCount >= AUTH_CONSTANTS.MAX_PROFILES_PER_USER) {
      throw AppError.badRequest(
        `Maximum of ${AUTH_CONSTANTS.MAX_PROFILES_PER_USER} viewing profiles allowed per account`
      );
    }

    const profile = await prisma.profile.create({
      data: {
        userId: req.user!.id,
        name: body.name,
        avatarUrl: body.avatarUrl,
        isKidsProfile: body.isKidsProfile,
        maxMaturityRating: body.isKidsProfile ? "PG" : body.maxMaturityRating,
        preferredAudioLanguage: body.preferredAudioLanguage,
        preferredSubtitleLanguage: body.preferredSubtitleLanguage,
        subtitlesEnabled: body.subtitlesEnabled,
        watchlist: { create: {} },
      },
    });

    res.status(201).json({ success: true, data: profile });
  } catch (err) {
    next(err);
  }
});

profilesRouter.get(
  "/:profileId/watchlist",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.profile.findFirst({
        where: { id: req.params.profileId!, userId: req.user!.id },
        include: {
          watchlist: {
            include: {
              items: {
                include: { movie: true, series: true },
                orderBy: { addedAt: "desc" },
              },
            },
          },
        },
      });

      if (!profile) {
        throw AppError.notFound("Profile not found");
      }

      res.json({ success: true, data: profile.watchlist?.items ?? [] });
    } catch (err) {
      next(err);
    }
  }
);

profilesRouter.post(
  "/:profileId/watchlist",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        movieId: z.string().uuid().optional(),
        seriesId: z.string().uuid().optional(),
      });
      const body = schema.parse(req.body);
      if (!body.movieId && !body.seriesId) {
        throw AppError.badRequest("Provide movieId or seriesId");
      }

      const profile = await prisma.profile.findFirst({
        where: { id: req.params.profileId!, userId: req.user!.id },
        include: { watchlist: true },
      });

      if (!profile || !profile.watchlist) {
        throw AppError.notFound("Profile watchlist not found");
      }

      const item = await prisma.watchlistItem.create({
        data: {
          watchlistId: profile.watchlist.id,
          movieId: body.movieId,
          seriesId: body.seriesId,
        },
      });

      res.status(201).json({ success: true, data: item });
    } catch (err) {
      next(err);
    }
  }
);

profilesRouter.get(
  "/:profileId/continue-watching",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.profile.findFirst({
        where: { id: req.params.profileId!, userId: req.user!.id },
      });
      if (!profile) {
        throw AppError.notFound("Profile not found");
      }

      const items = await prisma.watchHistory.findMany({
        where: { profileId: profile.id, completed: false, progressSeconds: { gt: 0 } },
        orderBy: { lastWatchedAt: "desc" },
        take: 20,
        include: { movie: true, episode: { include: { season: { include: { series: true } } } } },
      });

      res.json({ success: true, data: items });
    } catch (err) {
      next(err);
    }
  }
);
