import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { redis } from "../../infrastructure/redis/redis-client.js";
import { CdnPlaybackSigner } from "../../infrastructure/streaming/cdn-signer.js";
import { requireAuth, createRateLimiter } from "../../middleware/auth.middleware.js";
import { AppError } from "../../errors/app-error.js";
import { generateSecureToken, sha256Hex } from "../../utils/crypto.js";
import { MATURITY_RATING_ORDER, REDIS_KEYS } from "../../config/constants.js";
import { env } from "../../config/env.js";

export const playbackRouter = Router();

const createPlaybackSessionSchema = z.object({
  profileId: z.string().uuid(),
  movieId: z.string().uuid().optional(),
  episodeId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
});

const heartbeatSchema = z.object({
  positionSeconds: z.number().int().min(0),
  durationSeconds: z.number().int().min(1),
});

/**
 * Authorizes playback, checks subscription entitlements, enforces maturity ratings
 * and concurrent stream limits via Redis sorted sets, and returns signed CDN HLS credentials.
 */
playbackRouter.post(
  "/sessions",
  requireAuth,
  createRateLimiter({ scope: "playback-authorize", windowSeconds: 60, maxRequests: 20 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createPlaybackSessionSchema.parse(req.body);
      if (!body.movieId && !body.episodeId) {
        throw AppError.badRequest("Either movieId or episodeId must be provided");
      }

      const profile = await prisma.profile.findFirst({
        where: { id: body.profileId, userId: req.user!.id },
      });
      if (!profile) {
        throw AppError.forbidden("Profile does not belong to the authenticated account");
      }

      let mediaAssetId: string | null = null;
      let hlsMasterPlaylistKey: string | null = null;
      let contentMaturity = "PG_13";
      let requiresPremium = true;

      if (body.movieId) {
        const movie = await prisma.movie.findFirst({
          where: { id: body.movieId, status: "PUBLISHED" },
          include: { mediaAsset: true },
        });
        if (!movie || !movie.mediaAsset || movie.mediaAsset.status !== "READY") {
          throw AppError.notFound("Requested movie stream is not available");
        }
        mediaAssetId = movie.mediaAsset.id;
        hlsMasterPlaylistKey = movie.mediaAsset.hlsMasterPlaylistKey;
        contentMaturity = movie.maturityRating;
        requiresPremium = movie.requiresPremium;
      } else if (body.episodeId) {
        const episode = await prisma.episode.findFirst({
          where: { id: body.episodeId, status: "PUBLISHED" },
          include: { mediaAsset: true, season: { include: { series: true } } },
        });
        if (!episode || !episode.mediaAsset || episode.mediaAsset.status !== "READY") {
          throw AppError.notFound("Requested episode stream is not available");
        }
        mediaAssetId = episode.mediaAsset.id;
        hlsMasterPlaylistKey = episode.mediaAsset.hlsMasterPlaylistKey;
        contentMaturity = episode.season.series.maturityRating;
        requiresPremium = episode.season.series.requiresPremium;
      }

      if (!mediaAssetId || !hlsMasterPlaylistKey) {
        throw AppError.badRequest("HLS master playlist is not ready", "MEDIA_NOT_READY");
      }

      // 1. Enforce Profile Maturity Restriction
      if (
        (MATURITY_RATING_ORDER[contentMaturity] ?? 5) >
        (MATURITY_RATING_ORDER[profile.maxMaturityRating] ?? 5)
      ) {
        throw new AppError(
          403,
          "MATURITY_RESTRICTION",
          `This title is rated ${contentMaturity}, which exceeds this profile's ${profile.maxMaturityRating} limit.`
        );
      }

      // 2. Verify Active Subscription Entitlement & Stream Concurrency Quota
      const activeSub = await prisma.subscription.findFirst({
        where: {
          userId: req.user!.id,
          OR: [
            { status: { in: ["ACTIVE", "TRIALING"] }, currentPeriodEnd: { gt: new Date() } },
            { status: "PAST_DUE", gracePeriodEndsAt: { gt: new Date() } },
          ],
        },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
      });

      if (requiresPremium && !activeSub) {
        throw new AppError(
          403,
          "SUBSCRIPTION_REQUIRED",
          "An active premium subscription is required to stream this title"
        );
      }

      const maxAllowedStreams =
        activeSub?.plan.maxConcurrentStreams ?? env.DEFAULT_MAX_CONCURRENT_STREAMS;

      // 3. Distributed Concurrent Stream Enforcement via Redis ZSET
      const activeStreamsKey = REDIS_KEYS.playbackActiveStreams(req.user!.id);
      const nowMs = Date.now();
      const cutoffMs = nowMs - env.PLAYBACK_HEARTBEAT_TIMEOUT_SECONDS * 1000;

      await redis.zremrangebyscore(activeStreamsKey, "-inf", cutoffMs);
      const activeStreamCount = await redis.zcard(activeStreamsKey);

      if (activeStreamCount >= maxAllowedStreams) {
        throw new AppError(
          429,
          "CONCURRENT_STREAM_LIMIT_EXCEEDED",
          `Your plan allows up to ${maxAllowedStreams} simultaneous streams.`
        );
      }

      const rawSessionToken = generateSecureToken(32);
      const sessionTokenHash = sha256Hex(rawSessionToken);
      const signedGrant = CdnPlaybackSigner.signHlsPlayback(hlsMasterPlaylistKey);

      const playbackSession = await prisma.playbackSession.create({
        data: {
          userId: req.user!.id,
          profileId: profile.id,
          deviceId: body.deviceId,
          mediaAssetId,
          sessionTokenHash,
          ipAddress: req.ip,
          userAgent: req.header("user-agent") ?? null,
          expiresAt: signedGrant.expiresAt,
        },
      });

      await redis.zadd(activeStreamsKey, nowMs, playbackSession.id);
      await redis.expire(activeStreamsKey, env.PLAYBACK_SESSION_TTL_SECONDS);

      // Lookup resume position from WatchHistory
      const history = await prisma.watchHistory.findFirst({
        where: {
          profileId: profile.id,
          ...(body.movieId ? { movieId: body.movieId } : { episodeId: body.episodeId }),
        },
      });

      if (signedGrant.signedCookies) {
        for (const [cookieName, cookieVal] of Object.entries(signedGrant.signedCookies)) {
          res.cookie(cookieName, cookieVal, {
            httpOnly: true,
            secure: env.COOKIE_SECURE,
            sameSite: "none",
            domain: env.COOKIE_DOMAIN,
          });
        }
      }

      res.status(201).json({
        success: true,
        data: {
          sessionId: playbackSession.id,
          sessionToken: rawSessionToken,
          masterPlaylistUrl: signedGrant.masterManifestUrl,
          expiresAt: signedGrant.expiresAt.toISOString(),
          resumePositionSeconds: history && !history.completed ? history.progressSeconds : 0,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Heartbeat & Watch-History progress synchronization endpoint.
 */
playbackRouter.post(
  "/sessions/:sessionId/heartbeat",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.params.sessionId!;
      const body = heartbeatSchema.parse(req.body);

      const session = await prisma.playbackSession.findFirst({
        where: { id: sessionId, userId: req.user!.id, status: "ACTIVE" },
        include: { mediaAsset: true },
      });

      if (!session) {
        throw AppError.notFound("Active playback session not found");
      }

      const activeStreamsKey = REDIS_KEYS.playbackActiveStreams(req.user!.id);
      await redis.zadd(activeStreamsKey, Date.now(), session.id);

      const isCompleted = body.positionSeconds / body.durationSeconds >= 0.92;

      await prisma.$transaction(async (tx) => {
        await tx.playbackSession.update({
          where: { id: session.id },
          data: {
            lastPositionSec: body.positionSeconds,
            lastHeartbeatAt: new Date(),
            ...(isCompleted ? { status: "COMPLETED", endedAt: new Date() } : {}),
          },
        });

        if (session.mediaAsset.movieId) {
          await tx.watchHistory.upsert({
            where: {
              profileId_movieId: {
                profileId: session.profileId,
                movieId: session.mediaAsset.movieId,
              },
            },
            update: {
              progressSeconds: body.positionSeconds,
              durationSeconds: body.durationSeconds,
              completed: isCompleted,
              completedAt: isCompleted ? new Date() : null,
              lastWatchedAt: new Date(),
            },
            create: {
              profileId: session.profileId,
              movieId: session.mediaAsset.movieId,
              progressSeconds: body.positionSeconds,
              durationSeconds: body.durationSeconds,
              completed: isCompleted,
              completedAt: isCompleted ? new Date() : null,
            },
          });
        }
      });

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          progressSeconds: body.positionSeconds,
          completed: isCompleted,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);
