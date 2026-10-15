import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env.js";
import { API_PREFIX } from "./config/constants.js";
import {
  requestIdMiddleware,
  centralizedErrorMiddleware,
} from "./middleware/error.middleware.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { catalogRouter } from "./modules/catalog/catalog.routes.js";
import { videosRouter } from "./modules/videos/videos.routes.js";
import { playbackRouter } from "./modules/playback/playback.routes.js";
import {
  subscriptionsRouter,
  stripeWebhookHandler,
} from "./modules/subscriptions/subscriptions.routes.js";
import {
  healthRouter,
  httpRequestDurationMicroseconds,
} from "./observability/health.routes.js";
import { AppError } from "./errors/app-error.js";

export const app = express();

app.set("trust proxy", env.TRUST_PROXY);
app.use(requestIdMiddleware);
app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.CORS_ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(AppError.forbidden("Origin not allowed by CORS policy"));
      }
    },
    credentials: true,
  })
);

// Mount Stripe Webhook with express.raw BEFORE express.json() so signature verification succeeds
app.post(
  `${API_PREFIX}/payments/webhook`,
  express.raw({ type: "application/json", limit: "2mb" }),
  stripeWebhookHandler
);

app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser(env.COOKIE_SECRET));

// Latency telemetry middleware
app.use((req, res, next) => {
  const start = performance.now();
  res.on("finish", () => {
    const duration = performance.now() - start;
    httpRequestDurationMicroseconds
      .labels(req.method, req.route?.path ?? req.path, String(res.statusCode))
      .observe(duration);
  });
  next();
});

// OpenAPI 3.1 Specification
const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "StreamVault VOD Streaming Platform API",
    version: "1.0.0",
    description:
      "Production VOD API with Argon2id + Rotating Refresh Tokens, S3 Presigned Uploads, BullMQ FFmpeg HLS Pipeline, CloudFront Signed Playback, and Stripe Subscriptions.",
  },
  servers: [{ url: `${env.API_BASE_URL}${API_PREFIX}` }],
  paths: {
    "/auth/register": { post: { summary: "Register new account & default profile" } },
    "/auth/login": { post: { summary: "Authenticate & issue short-lived JWT + HttpOnly refresh cookie" } },
    "/auth/refresh": { post: { summary: "Rotate refresh token with family reuse detection" } },
    "/catalog/home": { get: { summary: "Fetch cached homepage featured & trending catalog" } },
    "/catalog/movies": { get: { summary: "Search, filter, and paginate published movies" } },
    "/videos/uploads/initiate": { post: { summary: "Admin: Request presigned S3 upload session" } },
    "/videos/uploads/{assetId}/complete": { post: { summary: "Admin: Verify S3 upload & enqueue BullMQ FFmpeg HLS job" } },
    "/playback/sessions": { post: { summary: "Authorize HLS playback, verify entitlement & concurrent stream limit" } },
    "/subscriptions/checkout": { post: { summary: "Create Stripe subscription checkout session" } },
    "/payments/webhook": { post: { summary: "Verified raw-body Stripe webhook processor" } },
  },
};

app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.use("/health", healthRouter);

// Backward-compatible route for starter Next.js frontend
app.get("/api/streams", (_req, res) => {
  res.json({
    streams: [
      {
        id: "vod-1",
        title: "Orbital Horizon (1080p Adaptive HLS)",
        streamer: "StreamVault Originals",
        status: "live",
        viewers: 412,
      },
    ],
  });
});

// Versioned REST API v1 routes
app.use(`${API_PREFIX}/auth`, authRouter);
app.use(`${API_PREFIX}/catalog`, catalogRouter);
app.use(`${API_PREFIX}/videos`, videosRouter);
app.use(`${API_PREFIX}/playback`, playbackRouter);
app.use(`${API_PREFIX}/subscriptions`, subscriptionsRouter);

app.use((_req, _res, next) => {
  next(AppError.notFound("API endpoint not found"));
});

app.use(centralizedErrorMiddleware);
