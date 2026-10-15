import { Queue } from "bullmq";
import { buildRedisOptions } from "../redis/redis-client.js";
import { QUEUE_NAMES } from "../../config/constants.js";

export interface TranscodeJobPayload {
  mediaAssetId: string;
  rawBucket: string;
  rawKey: string;
  outputBucket: string;
  requestedByUserId: string;
}

const queueConnection = buildRedisOptions(null);

export const videoTranscodeQueue = new Queue<TranscodeJobPayload>(
  QUEUE_NAMES.VIDEO_TRANSCODE,
  {
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 10000,
      },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  }
);

export async function enqueueVideoTranscodeJob(payload: TranscodeJobPayload) {
  const deterministicJobId = `transcode:${payload.mediaAssetId}`;
  return videoTranscodeQueue.add("transcode-hls", payload, {
    jobId: deterministicJobId,
  });
}
