import { Worker, Job } from "bullmq";
import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { buildRedisOptions } from "../infrastructure/redis/redis-client.js";
import { QUEUE_NAMES } from "../config/constants.js";
import { TranscodeJobPayload } from "../infrastructure/queue/queues.js";
import { prisma } from "../infrastructure/database/prisma.js";
import { S3StorageService } from "../infrastructure/storage/s3.service.js";
import { FFmpegProcessor } from "../infrastructure/streaming/ffmpeg.processor.js";
import { env } from "../config/env.js";
import { logger } from "../infrastructure/logging/logger.js";

async function processVideoTranscodeJob(job: Job<TranscodeJobPayload>): Promise<void> {
  const { mediaAssetId, rawBucket, rawKey, outputBucket } = job.data;
  const workDir = path.join(env.TRANSCODE_TEMP_DIR, mediaAssetId);
  const inputFilePath = path.join(workDir, "source_input");
  const outputDir = path.join(workDir, "hls_out");

  logger.info({ mediaAssetId, jobId: job.id }, "Starting HLS transcode worker job");

  await prisma.mediaAsset.update({
    where: { id: mediaAssetId },
    data: {
      status: "PROCESSING",
      processingStartedAt: new Date(),
      processingProgress: 5,
      errorMessage: null,
    },
  });

  try {
    await mkdir(workDir, { recursive: true });
    await S3StorageService.downloadToLocalFile(rawBucket, rawKey, inputFilePath);

    const probeMeta = await FFmpegProcessor.probeMedia(inputFilePath);
    await prisma.mediaAsset.update({
      where: { id: mediaAssetId },
      data: {
        sourceWidth: probeMeta.width,
        sourceHeight: probeMeta.height,
        durationSeconds: probeMeta.durationSeconds,
        videoCodec: probeMeta.videoCodec,
        audioCodec: probeMeta.audioCodec,
        processingProgress: 20,
      },
    });

    const hlsOutput = await FFmpegProcessor.transcodeToHls(
      inputFilePath,
      outputDir,
      probeMeta
    );

    const s3Prefix = `hls/${mediaAssetId}`;

    // Upload master playlist and poster
    await S3StorageService.uploadLocalFile({
      bucket: outputBucket,
      key: `${s3Prefix}/master.m3u8`,
      filePath: hlsOutput.masterPlaylistPath,
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "public, max-age=60",
    });

    await S3StorageService.uploadLocalFile({
      bucket: outputBucket,
      key: `${s3Prefix}/poster.jpg`,
      filePath: hlsOutput.posterPath,
      contentType: "image/jpeg",
    });

    // Upload each rendition's playlist & .ts segments
    for (const rendition of hlsOutput.renditions) {
      const renditionLocalDir = path.join(outputDir, rendition.name);
      const files = await readdir(renditionLocalDir);
      for (const fileName of files) {
        const isPlaylist = fileName.endsWith(".m3u8");
        await S3StorageService.uploadLocalFile({
          bucket: outputBucket,
          key: `${s3Prefix}/${rendition.name}/${fileName}`,
          filePath: path.join(renditionLocalDir, fileName),
          contentType: isPlaylist ? "application/vnd.apple.mpegurl" : "video/mp2t",
        });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.videoRendition.deleteMany({ where: { mediaAssetId } });
      for (const r of hlsOutput.renditions) {
        await tx.videoRendition.create({
          data: {
            mediaAssetId,
            name: r.name,
            width: r.width,
            height: r.height,
            videoBitrateKbps: r.videoBitrateKbps,
            audioBitrateKbps: r.audioBitrateKbps,
            codecs: r.codecs,
            playlistKey: `${s3Prefix}/${r.playlistRelativePath}`,
            segmentCount: r.segmentCount,
            totalSizeBytes: r.totalSizeBytes,
          },
        });
      }

      await tx.mediaAsset.update({
        where: { id: mediaAssetId },
        data: {
          status: "READY",
          hlsMasterPlaylistKey: `${s3Prefix}/master.m3u8`,
          posterThumbnailKey: `${s3Prefix}/poster.jpg`,
          processingProgress: 100,
          processingCompletedAt: new Date(),
        },
      });
    });

    logger.info({ mediaAssetId }, "Completed HLS transcode job successfully");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown transcoding failure";
    logger.error({ err, mediaAssetId }, "HLS transcoding failed");
    await prisma.mediaAsset.update({
      where: { id: mediaAssetId },
      data: {
        status: "FAILED",
        errorMessage,
      },
    });
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const transcodeWorker = new Worker<TranscodeJobPayload>(
  QUEUE_NAMES.VIDEO_TRANSCODE,
  processVideoTranscodeJob,
  {
    connection: buildRedisOptions(null),
    concurrency: env.WORKER_TRANSCODE_CONCURRENCY,
  }
);

transcodeWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "BullMQ video transcode job failed");
});

async function shutdownWorker(signal: string) {
  logger.info({ signal }, "Shutting down BullMQ transcode worker gracefully...");
  await transcodeWorker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdownWorker("SIGTERM"));
process.on("SIGINT", () => void shutdownWorker("SIGINT"));
