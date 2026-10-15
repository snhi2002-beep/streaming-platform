import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { ZodError } from "zod";
import { AppError } from "../errors/app-error.js";
import { logger } from "../infrastructure/logging/logger.js";
import { env } from "../config/env.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      user?: {
        id: string;
        email: string;
        roles: string[];
        permissions: string[];
        deviceId?: string;
      };
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.header("x-request-id");
  const requestId = incomingId && incomingId.length <= 64 ? incomingId : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

export function centralizedErrorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId ?? "unknown";

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        requestId,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error({ err, requestId, path: req.originalUrl }, "Non-operational AppError");
    }
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
        requestId,
      },
    });
    return;
  }

  logger.error({ err, requestId, path: req.originalUrl, method: req.method }, "Unhandled exception");

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message:
        env.NODE_ENV === "production"
          ? "An unexpected internal error occurred"
          : err instanceof Error
            ? err.message
            : "Unknown error",
      requestId,
    },
  });
}
