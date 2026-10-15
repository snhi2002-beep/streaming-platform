import { Request, Response, NextFunction } from "express";
import { redis } from "../infrastructure/redis/redis-client.js";
import { REDIS_KEYS } from "../config/constants.js";
import { AppError } from "../errors/app-error.js";
import { verifyAccessToken } from "../utils/jwt.js";

export function createRateLimiter(options: {
  scope: string;
  windowSeconds: number;
  maxRequests: number;
}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const identifier = req.user?.id ?? req.ip ?? "anonymous";
      const key = REDIS_KEYS.rateLimit(options.scope, identifier);

      const currentCount = await redis.incr(key);
      if (currentCount === 1) {
        await redis.expire(key, options.windowSeconds);
      }

      res.setHeader("X-RateLimit-Limit", String(options.maxRequests));
      res.setHeader(
        "X-RateLimit-Remaining",
        String(Math.max(0, options.maxRequests - currentCount))
      );

      if (currentCount > options.maxRequests) {
        next(
          AppError.tooManyRequests(
            `Too many requests for ${options.scope}. Please try again later.`
          )
        );
        return;
      }
      next();
    } catch {
      // Fail open if Redis is momentarily unreachable so API remains resilient
      next();
    }
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    next(AppError.unauthorized("Missing or malformed Authorization Bearer header"));
    return;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email,
      roles: payload.roles,
      permissions: payload.permissions,
      deviceId: payload.deviceId,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized());
      return;
    }
    const hasRole = req.user.roles.some((r) => allowedRoles.includes(r));
    if (!hasRole) {
      next(AppError.forbidden(`Requires one of roles: ${allowedRoles.join(", ")}`));
      return;
    }
    next();
  };
}

export function requirePermission(...requiredPermissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized());
      return;
    }
    const hasAll = requiredPermissions.every((p) => req.user!.permissions.includes(p));
    if (!hasAll) {
      next(
        AppError.forbidden(`Missing required permissions: ${requiredPermissions.join(", ")}`)
      );
      return;
    }
    next();
  };
}
