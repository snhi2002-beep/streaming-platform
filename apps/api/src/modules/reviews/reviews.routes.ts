import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { AppError } from "../../errors/app-error.js";

export const reviewsRouter = Router();

const createReviewSchema = z.object({
  profileId: z.string().uuid(),
  movieId: z.string().uuid().optional(),
  seriesId: z.string().uuid().optional(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

reviewsRouter.post(
  "/",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createReviewSchema.parse(req.body);
      if (!body.movieId && !body.seriesId) {
        throw AppError.badRequest("Either movieId or seriesId is required");
      }

      const profile = await prisma.profile.findFirst({
        where: { id: body.profileId, userId: req.user!.id },
      });
      if (!profile) {
        throw AppError.forbidden("Profile does not belong to your account");
      }

      const review = await prisma.$transaction(async (tx) => {
        const created = await tx.review.create({
          data: {
            profileId: profile.id,
            movieId: body.movieId,
            seriesId: body.seriesId,
            rating: body.rating,
            comment: body.comment,
          },
        });

        if (body.movieId) {
          const stats = await tx.review.aggregate({
            where: { movieId: body.movieId },
            _avg: { rating: true },
            _count: { id: true },
          });
          await tx.movie.update({
            where: { id: body.movieId },
            data: {
              averageRating: stats._avg.rating ?? 0,
              reviewCount: stats._count.id,
            },
          });
        }

        return created;
      });

      res.status(201).json({ success: true, data: review });
    } catch (err) {
      next(err);
    }
  }
);
