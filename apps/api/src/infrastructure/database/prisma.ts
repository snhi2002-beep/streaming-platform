import { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { logger } from "../logging/logger.js";

export const prisma = new PrismaClient({
  log: [
    { emit: "event", level: "query" },
    { emit: "event", level: "error" },
    { emit: "event", level: "warn" },
  ],
});

prisma.$on("query", (e) => {
  if (e.duration >= env.SLOW_QUERY_THRESHOLD_MS) {
    logger.warn(
      {
        durationMs: e.duration,
        query: e.query,
        target: e.target,
      },
      "Slow database query detected"
    );
  }
});

prisma.$on("error", (e) => {
  logger.error({ target: e.target, message: e.message }, "Prisma database error");
});
