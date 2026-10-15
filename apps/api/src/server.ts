import http from "node:http";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./infrastructure/logging/logger.js";
import { prisma } from "./infrastructure/database/prisma.js";
import { redis } from "./infrastructure/redis/redis-client.js";

const server = http.createServer(app);

async function bootstrap() {
  try {
    await prisma.$connect();
    logger.info("Connected to MySQL via Prisma");

    server.listen(env.PORT, () => {
      logger.info(
        { port: env.PORT, env: env.NODE_ENV, docs: `${env.API_BASE_URL}/api/docs` },
        "VOD Streaming Platform API Server listening"
      );
    });
  } catch (err) {
    logger.fatal({ err }, "Failed to bootstrap VOD API server");
    process.exit(1);
  }
}

async function gracefulShutdown(signal: string) {
  logger.info({ signal }, "Received termination signal. Starting graceful shutdown...");
  server.close(async () => {
    try {
      await prisma.$disconnect();
      await redis.quit();
      logger.info("Database and Redis connections closed cleanly.");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

void bootstrap();
