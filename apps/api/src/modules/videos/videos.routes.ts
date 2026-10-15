import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { S3StorageService } from "../../infrastructure/storage/s3.service.js";
import { enqueueVideoTranscodeJob } from "../../infrastructure/queue/queues.js";
import { requireAuth, requirePermission, createRateLimiter } from "../../middleware/auth.middleware.js";
import { ALLOWED_VIDEO_MIME_TYPES } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { AppError } from "../../errors/app-error.js";

export const videosRouter = Router();

const initiateUploadSchema = z.object({
  ownerType: z.enum(["MOVIE", "EPISODE", "TRAILER"]),
  movieId: z.string().uuid().optional(),
  episodeId: z.string().uuid().optional(),
  fileName: z.string().min(1).max(200),
  mimeType: z.enum(ALLOWED_VIDEO_MIME_TYPES),
  fileSizeBytes: z.number().int().min(1024).max(env.MAX_UPLOAD_FILE_SIZE_BYTES),
});

/**
 * Step 1-3: Authorize upload, validate quota & MIME type, create MediaAsset, and return presigned S3 PUT URL.
 */
videosRouter.post(
  "/uploads/initiate",
  requireAuth,
  requirePermission("media:upload"),
  createRateLimiter({ scope: "media-upload", windowSeconds: 3600, maxRequests: 30 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = initiateUploadSchema.parse(req.body);
      const safeExt = body.fileName.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "") || "mp4";
      const assetId = crypto.randomUUID();
      const rawStorageKey = `raw/${body.ownerType.toLowerCase()}/${assetId}/source.${safeExt}`;

      const asset = await prisma.mediaAsset.create({
        data: {
          id: assetId,
          ownerType: body.ownerType,
          movieId: body.ownerType === "MOVIE" ? body.movieId : undefined,
          movieTrailerId: body.ownerType === "TRAILER" ? body.movieId : undefined,
          episodeId: body.ownerType === "EPISODE" ? body.episodeId : undefined,
          uploadedByUserId: req.user!.id,
          status: "UPLOADING",
          originalFileName: body.fileName,
          originalMimeType: body.mimeType,
          expectedFileSizeBytes: BigInt(body.fileSizeBytes),
          rawStorageBucket: env.S3_RAW_UPLOADS_BUCKET,
          rawStorageKey,
          processedBucket: env.S3_PROCESSED_MEDIA_BUCKET,
        },
      });

      const presigned = await S3StorageService.createPresignedUploadUrl({
        bucket: env.S3_RAW_UPLOADS_BUCKET,
        key: rawStorageKey,
        contentType: body.mimeType,
        contentLength: body.fileSizeBytes,
      });

      res.status(201).json({
        success: true,
        data: {
          assetId: asset.id,
          status: asset.status,
          uploadUrl: presigned.uploadUrl,
          expiresInSeconds: presigned.expiresInSeconds,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Step 5-6: Verify uploaded object in S3 via HeadObject and enqueue idempotent BullMQ FFmpeg job.
 */
videosRouter.post(
  "/uploads/:assetId/complete",
  requireAuth,
  requirePermission("media:upload"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assetId = req.params.assetId!;
      const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId } });

      if (!asset) {
        throw AppError.notFound("MediaAsset not found");
      }

      if (asset.status === "READY" || asset.status === "PROCESSING" || asset.status === "QUEUED") {
        res.json({
          success: true,
          data: {
            assetId: asset.id,
            status: asset.status,
            jobId: asset.processingJobId,
          },
        });
        return;
      }

      const objectMeta = await S3StorageService.verifyUploadedObject(
        asset.rawStorageBucket,
        asset.rawStorageKey
      );

      if (objectMeta.contentLength <= 0 || objectMeta.contentLength > env.MAX_UPLOAD_FILE_SIZE_BYTES) {
        throw AppError.badRequest(
          "Uploaded object size violates configured limits",
          "UPLOAD_VALIDATION_FAILED"
        );
      }

      const job = await enqueueVideoTranscodeJob({
        mediaAssetId: asset.id,
        rawBucket: asset.rawStorageBucket,
        rawKey: asset.rawStorageKey,
        outputBucket: env.S3_PROCESSED_MEDIA_BUCKET,
        requestedByUserId: req.user!.id,
      });

      const updated = await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          status: "QUEUED",
          actualFileSizeBytes: BigInt(objectMeta.contentLength),
          uploadCompletedAt: new Date(),
          processingJobId: job.id ?? `transcode:${asset.id}`,
        },
      });

      res.json({
        success: true,
        data: {
          assetId: updated.id,
          status: updated.status,
          processingJobId: updated.processingJobId,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

videosRouter.get(
  "/uploads/:assetId/status",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asset = await prisma.mediaAsset.findUnique({
        where: { id: req.params.assetId! },
        include: { renditions: true, subtitleTracks: true },
      });

      if (!asset) {
        throw AppError.notFound("MediaAsset not found");
      }

      res.json({
        success: true,
        data: {
          id: asset.id,
          status: asset.status,
          progress: asset.processingProgress,
          durationSeconds: asset.durationSeconds,
          sourceResolution:
            asset.sourceWidth && asset.sourceHeight
              ? `${asset.sourceWidth}x${asset.sourceHeight}`
              : null,
          errorMessage: asset.errorMessage,
          renditions: asset.renditions.map((r) => ({
            name: r.name,
            resolution: `${r.width}x${r.height}`,
            videoBitrateKbps: r.videoBitrateKbps,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);
