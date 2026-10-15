import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((val) => val === "true" || val === "1");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    APP_NAME: z.string().min(1).default("streamvault-vod"),
    APP_URL: z.string().url().default("http://localhost:3000"),
    API_BASE_URL: z.string().url().default("http://localhost:4000"),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),

    DATABASE_URL: z.string().min(10),

    REDIS_HOST: z.string().min(1).default("localhost"),
    REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
    REDIS_PASSWORD: z.string().optional().default(""),
    REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
    REDIS_TLS_ENABLED: booleanString.default("false"),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRES_IN_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    JWT_REFRESH_EXPIRES_IN_SECONDS: z.coerce.number().int().min(3600).default(604800),
    JWT_ISSUER: z.string().min(1).default("streamvault.api"),
    JWT_AUDIENCE: z.string().min(1).default("streamvault.client"),

    COOKIE_SECRET: z.string().min(32),
    COOKIE_DOMAIN: z.string().min(1).default("localhost"),
    COOKIE_SECURE: booleanString.default("false"),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((val) =>
        val
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean)
      ),
    CSRF_PROTECTION_ENABLED: booleanString.default("true"),

    AUTH_MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
    AUTH_LOCKOUT_DURATION_SECONDS: z.coerce.number().int().min(60).default(900),

    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_ENDPOINT: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: booleanString.default("true"),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_RAW_UPLOADS_BUCKET: z.string().min(3).default("vod-raw-uploads-private"),
    S3_PROCESSED_MEDIA_BUCKET: z.string().min(3).default("vod-processed-hls-private"),
    S3_UPLOAD_URL_EXPIRES_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
    MAX_UPLOAD_FILE_SIZE_BYTES: z.coerce
      .number()
      .int()
      .min(1048576)
      .default(10 * 1024 * 1024 * 1024),

    CDN_BASE_URL: z.string().url().default("https://cdn.streamvault.example.com"),
    CDN_SIGNING_ENABLED: booleanString.default("false"),
    CDN_KEY_PAIR_ID: z.string().optional(),
    CDN_PRIVATE_KEY_BASE64: z.string().optional(),
    PLAYBACK_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).default(14400),
    PLAYBACK_HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(120),
    DEFAULT_MAX_CONCURRENT_STREAMS: z.coerce.number().int().min(1).max(10).default(2),
    MAX_DEVICES_PER_ACCOUNT: z.coerce.number().int().min(1).max(20).default(5),

    FFMPEG_PATH: z.string().min(1).default("/usr/bin/ffmpeg"),
    FFPROBE_PATH: z.string().min(1).default("/usr/bin/ffprobe"),
    WORKER_TRANSCODE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    WORKER_FFMPEG_THREADS: z.coerce.number().int().min(1).max(32).default(4),
    TRANSCODE_TIMEOUT_MS: z.coerce.number().int().min(60000).default(7200000),
    TRANSCODE_TEMP_DIR: z.string().min(1).default("/tmp/vod-transcode"),

    STRIPE_SECRET_KEY: z.string().min(10),
    STRIPE_WEBHOOK_SECRET: z.string().min(10),
    STRIPE_SUCCESS_URL: z.string().url().default("http://localhost:3000/billing?status=success"),
    STRIPE_CANCEL_URL: z.string().url().default("http://localhost:3000/billing?status=canceled"),
    SUBSCRIPTION_GRACE_PERIOD_DAYS: z.coerce.number().int().min(0).max(30).default(3),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    METRICS_ENABLED: booleanString.default("true"),
    SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().min(50).default(500),
  })
  .superRefine((data, ctx) => {
    if (data.JWT_ACCESS_SECRET === data.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_REFRESH_SECRET"],
        message: "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be distinct secrets",
      });
    }
    if (data.NODE_ENV === "production" && !data.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SECURE"],
        message: "COOKIE_SECURE must be true in production",
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("FATAL: Invalid environment configuration:", parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
