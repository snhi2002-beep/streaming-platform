import { Router, Request, Response } from "express";
import client from "prom-client";
import { prisma } from "../infrastructure/database/prisma.js";
import { redis } from "../infrastructure/redis/redis-client.js";

export const metricsRegistry = new client.Registry();
client.collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestDurationMicroseconds = new client.Histogram({
  name: "http_request_duration_ms",
  help: "Duration of HTTP requests in ms",
  labelNames: ["method", "route", "status_code"],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [metricsRegistry],
});

export const healthRouter = Router();

healthRouter.get("/live", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get("/ready", async (_req: Request, res: Response) => {
  try {
    await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    res.json({
      status: "ready",
      dependencies: { database: "up", redis: "up" },
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: "degraded",
      dependencies: { database: "check_failed", redis: "check_failed" },
      timestamp: new Date().toISOString(),
    });
  }
});

healthRouter.get("/metrics", async (_req: Request, res: Response) => {
  res.setHeader("Content-Type", metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
});
