import pino from "pino";
import { env } from "../../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: env.APP_NAME,
    env: env.NODE_ENV,
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers[\"x-csrf-token\"]",
      "body.password",
      "body.newPassword",
      "body.currentPassword",
      "passwordHash",
      "refreshToken",
      "tokenHash",
    ],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
