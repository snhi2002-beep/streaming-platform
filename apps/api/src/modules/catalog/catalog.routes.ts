import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { redis } from "../../infrastructure/redis/redis-client.js";
import { AppError } from "../../errors/app-error.js";
import { requireAuth, requirePermission } from "../../middleware/auth.middleware.js";
import { CACHE_TTL_SECONDS, REDIS_KEYS } from "../../config/constants.js";

export const catalogRouter = Router();

const listCatalogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  genre: z.string().optional(),
  q: z.string().trim().max(120).optional(),
  sortBy: z.enum(["trendingScore", "releaseDate", "createdAt"]).default("trendingScore"),
});

const createMovieSchema = z.object({
  title: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/),
  synopsis: z.string().min(10),
  runtimeSeconds: z.number().int().min(0).default(0),
  maturityRating: z.enum(["G", "PG", "PG_13", "R", "NC_17"]).default("PG_13"),
  requiresPremium: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
  genreIds: z.array(z.string().uuid()).optional(),
});

catalogRouter.get("/home", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const cacheKey = REDIS_KEYS.catalogHome();
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.json({ success: true, data: JSON.parse(cached), cached: true });
      return;
    }

    const [featuredMovies, trendingMovies, featuredSeries] = await Promise.all([
      prisma.movie.findMany({
        where: { status: "PUBLISHED", isFeatured: true },
        take: 10,
        orderBy: { trendingScore: "desc" },
        include: { genres: { include: { genre: true } } },
      }),
      prisma.movie.findMany({
        where: { status: "PUBLISHED" },
        take: 20,
        orderBy: { trendingScore: "desc" },
      }),
      prisma.series.findMany({
        where: { status: "PUBLISHED" },
        take: 10,
        orderBy: { trendingScore: "desc" },
        include: { seasons: { where: { status: "PUBLISHED" } } },
      }),
    ]);

    const payload = { featuredMovies, trendingMovies, featuredSeries };
    await redis.set(cacheKey, JSON.stringify(payload), "EX", CACHE_TTL_SECONDS.CATALOG_HOME);

    res.json({ success: true, data: payload, cached: false });
  } catch (err) {
    next(err);
  }
});

catalogRouter.get("/movies", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listCatalogQuerySchema.parse(req.query);
    const skip = (query.page - 1) * query.limit;

    const whereClause = {
      status: "PUBLISHED" as const,
      ...(query.genre
        ? { genres: { some: { genre: { slug: query.genre } } } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q } },
              { synopsis: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.movie.findMany({
        where: whereClause,
        skip,
        take: query.limit,
        orderBy: { [query.sortBy]: "desc" },
        include: { genres: { include: { genre: true } } },
      }),
      prisma.movie.count({ where: whereClause }),
    ]);

    res.json({
      success: true,
      data: items,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

catalogRouter.get("/movies/:slug", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = req.params.slug!;
    const movie = await prisma.movie.findFirst({
      where: { slug, status: "PUBLISHED" },
      include: {
        genres: { include: { genre: true } },
        cast: { include: { castMember: true }, orderBy: { billingOrder: "asc" } },
        mediaAsset: {
          select: {
            id: true,
            status: true,
            durationSeconds: true,
            renditions: {
              select: { name: true, width: true, height: true, videoBitrateKbps: true },
            },
            subtitleTracks: true,
          },
        },
      },
    });

    if (!movie) {
      throw AppError.notFound("Movie not found");
    }

    res.json({ success: true, data: movie });
  } catch (err) {
    next(err);
  }
});

// Admin endpoint to create a movie
catalogRouter.post(
  "/admin/movies",
  requireAuth,
  requirePermission("catalog:write"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createMovieSchema.parse(req.body);

      const movie = await prisma.$transaction(async (tx) => {
        const created = await tx.movie.create({
          data: {
            title: body.title,
            slug: body.slug,
            synopsis: body.synopsis,
            runtimeSeconds: body.runtimeSeconds,
            maturityRating: body.maturityRating,
            requiresPremium: body.requiresPremium,
            isFeatured: body.isFeatured,
            status: "DRAFT",
            ...(body.genreIds?.length
              ? {
                  genres: {
                    create: body.genreIds.map((genreId) => ({ genreId })),
                  },
                }
              : {}),
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: req.user!.id,
            action: "MOVIE_CREATED",
            entityType: "Movie",
            entityId: created.id,
            ipAddress: req.ip,
          },
        });

        return created;
      });

      await redis.del(REDIS_KEYS.catalogHome());
      res.status(201).json({ success: true, data: movie });
    } catch (err) {
      next(err);
    }
  }
);

// Admin endpoint to publish a movie (verifying that primary MediaAsset is READY)
catalogRouter.patch(
  "/admin/movies/:movieId/publish",
  requireAuth,
  requirePermission("catalog:write"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const movieId = req.params.movieId!;
      const movie = await prisma.movie.findUnique({
        where: { id: movieId },
        include: { mediaAsset: true },
      });

      if (!movie) {
        throw AppError.notFound("Movie not found");
      }

      if (!movie.mediaAsset || movie.mediaAsset.status !== "READY") {
        throw AppError.badRequest(
          "Cannot publish movie until its primary HLS MediaAsset has finished transcoding (status = READY)",
          "MEDIA_NOT_READY"
        );
      }

      const updated = await prisma.$transaction(async (tx) => {
        const pub = await tx.movie.update({
          where: { id: movieId },
          data: { status: "PUBLISHED", publishedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: req.user!.id,
            action: "MOVIE_PUBLISHED",
            entityType: "Movie",
            entityId: pub.id,
            ipAddress: req.ip,
          },
        });
        return pub;
      });

      await redis.del(REDIS_KEYS.catalogHome());
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }
);
