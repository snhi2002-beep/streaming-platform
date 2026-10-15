import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { redis } from "../../infrastructure/redis/redis-client.js";
import { AppError } from "../../errors/app-error.js";
import {
  hashPassword,
  verifyPassword,
  sha256Hex,
  generateSecureToken,
} from "../../utils/crypto.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/jwt.js";
import { env } from "../../config/env.js";
import { AUTH_CONSTANTS, REDIS_KEYS } from "../../config/constants.js";
import { createRateLimiter, requireAuth } from "../../middleware/auth.middleware.js";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email().max(255).transform((e) => e.toLowerCase().trim()),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(128)
    .regex(/[A-Z]/, "Must contain an uppercase letter")
    .regex(/[a-z]/, "Must contain a lowercase letter")
    .regex(/[0-9]/, "Must contain a number"),
  profileName: z.string().min(1).max(64).default("Main Profile"),
});

const loginSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase().trim()),
  password: z.string().min(1),
  deviceFingerprint: z.string().min(4).max(128).default("web-browser-default"),
  deviceName: z.string().min(1).max(128).default("Web Browser"),
  deviceType: z.string().min(1).max(64).default("WEB"),
});

function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(AUTH_CONSTANTS.REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "strict",
    domain: env.COOKIE_DOMAIN,
    path: "/api/v1/auth",
    maxAge: env.JWT_REFRESH_EXPIRES_IN_SECONDS * 1000,
  });
}

authRouter.post(
  "/register",
  createRateLimiter({ scope: "auth-register", windowSeconds: 300, maxRequests: 10 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = registerSchema.parse(req.body);
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) {
        throw AppError.conflict("An account with this email already exists");
      }

      const passwordHash = await hashPassword(body.password);
      const rawVerifyToken = generateSecureToken(32);
      const verifyTokenHash = sha256Hex(rawVerifyToken);

      const viewerRole = await prisma.role.upsert({
        where: { name: "VIEWER" },
        update: {},
        create: { name: "VIEWER", description: "Standard Streaming Viewer" },
      });

      const user = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            email: body.email,
            passwordHash,
            status: "ACTIVE",
            emailVerifiedAt: new Date(),
            userRoles: {
              create: [{ roleId: viewerRole.id }],
            },
            profiles: {
              create: [
                {
                  name: body.profileName,
                  watchlist: { create: {} },
                },
              ],
            },
            emailVerificationTokens: {
              create: [
                {
                  tokenHash: verifyTokenHash,
                  expiresAt: new Date(
                    Date.now() + AUTH_CONSTANTS.EMAIL_VERIFICATION_TTL_HOURS * 3600 * 1000
                  ),
                },
              ],
            },
          },
          include: { profiles: true },
        });
        return createdUser;
      });

      res.status(201).json({
        success: true,
        data: {
          userId: user.id,
          email: user.email,
          status: user.status,
          profiles: user.profiles,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

authRouter.post(
  "/login",
  createRateLimiter({ scope: "auth-login", windowSeconds: 300, maxRequests: 10 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = loginSchema.parse(req.body);
      const lockoutKey = REDIS_KEYS.accountLockout(body.email);
      const isLocked = await redis.get(lockoutKey);
      if (isLocked) {
        throw new AppError(
          423,
          "ACCOUNT_LOCKED",
          "Account is temporarily locked due to repeated failed login attempts"
        );
      }

      const user = await prisma.user.findUnique({
        where: { email: body.email },
        include: {
          userRoles: {
            include: {
              role: {
                include: {
                  rolePermissions: { include: { permission: true } },
                },
              },
            },
          },
        },
      });

      if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
        const attemptsKey = REDIS_KEYS.loginAttempts(body.email);
        const attempts = await redis.incr(attemptsKey);
        if (attempts === 1) {
          await redis.expire(attemptsKey, env.AUTH_LOCKOUT_DURATION_SECONDS);
        }
        if (attempts >= env.AUTH_MAX_LOGIN_ATTEMPTS) {
          await redis.set(lockoutKey, "1", "EX", env.AUTH_LOCKOUT_DURATION_SECONDS);
        }
        throw AppError.unauthorized("Invalid email or password");
      }

      if (user.status === "SUSPENDED" || user.status === "DELETED") {
        throw new AppError(403, "ACCOUNT_SUSPENDED", `Account is ${user.status.toLowerCase()}`);
      }

      await redis.del(REDIS_KEYS.loginAttempts(body.email));

      const roles = user.userRoles.map((ur) => ur.role.name);
      const permissions = Array.from(
        new Set(
          user.userRoles.flatMap((ur) =>
            ur.role.rolePermissions.map((rp) => rp.permission.code)
          )
        )
      );

      const device = await prisma.device.upsert({
        where: {
          userId_deviceFingerprint: {
            userId: user.id,
            deviceFingerprint: body.deviceFingerprint,
          },
        },
        update: {
          deviceName: body.deviceName,
          lastIpAddress: req.ip,
          userAgent: req.header("user-agent") ?? null,
          lastActiveAt: new Date(),
        },
        create: {
          userId: user.id,
          deviceFingerprint: body.deviceFingerprint,
          deviceName: body.deviceName,
          deviceType: body.deviceType,
          lastIpAddress: req.ip,
          userAgent: req.header("user-agent") ?? null,
        },
      });

      const familyId = crypto.randomUUID();
      const jti = crypto.randomUUID();
      const rawRefreshToken = signRefreshToken({ sub: user.id, familyId, jti });
      const refreshTokenHash = sha256Hex(rawRefreshToken);

      await prisma.$transaction([
        prisma.refreshToken.create({
          data: {
            userId: user.id,
            deviceId: device.id,
            tokenHash: refreshTokenHash,
            familyId,
            ipAddress: req.ip,
            userAgent: req.header("user-agent") ?? null,
            expiresAt: new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_SECONDS * 1000),
          },
        }),
        prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date(), failedLoginAttempts: 0 },
        }),
      ]);

      const accessToken = signAccessToken({
        sub: user.id,
        email: user.email,
        roles,
        permissions,
        deviceId: device.id,
      });

      setRefreshCookie(res, rawRefreshToken);

      res.json({
        success: true,
        data: {
          accessToken,
          expiresInSeconds: env.JWT_ACCESS_EXPIRES_IN_SECONDS,
          user: {
            id: user.id,
            email: user.email,
            roles,
            permissions,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Refresh token endpoint with strict rotation and family reuse detection.
 */
authRouter.post("/refresh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawToken =
      req.cookies?.[AUTH_CONSTANTS.REFRESH_COOKIE_NAME] ?? req.body?.refreshToken;
    if (!rawToken || typeof rawToken !== "string") {
      throw AppError.unauthorized("Refresh token is missing");
    }

    const decoded = verifyRefreshToken(rawToken);
    const incomingHash = sha256Hex(rawToken);

    const storedToken = await prisma.refreshToken.findUnique({
      where: { tokenHash: incomingHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: { include: { rolePermissions: { include: { permission: true } } } },
              },
            },
          },
        },
      },
    });

    if (!storedToken) {
      await prisma.refreshToken.updateMany({
        where: { familyId: decoded.familyId, isRevoked: false },
        data: {
          isRevoked: true,
          revokedReason: "TOKEN_REUSE_UNRECOGNIZED_HASH",
          revokedAt: new Date(),
        },
      });
      throw AppError.unauthorized("Compromised session detected", "TOKEN_REUSE_DETECTED");
    }

    // Reuse detection: if token was already rotated or revoked, invalidate the entire family!
    if (storedToken.isRevoked || storedToken.replacedByTokenHash !== null) {
      await prisma.refreshToken.updateMany({
        where: { familyId: storedToken.familyId, isRevoked: false },
        data: {
          isRevoked: true,
          revokedReason: "REFRESH_TOKEN_REUSE_DETECTED",
          revokedAt: new Date(),
        },
      });
      res.clearCookie(AUTH_CONSTANTS.REFRESH_COOKIE_NAME, { path: "/api/v1/auth" });
      throw AppError.unauthorized(
        "Refresh token reuse detected. All sessions in this token family have been revoked.",
        "TOKEN_REUSE_DETECTED"
      );
    }

    if (storedToken.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthorized("Refresh token has expired");
    }

    const newJti = crypto.randomUUID();
    const newRawRefreshToken = signRefreshToken({
      sub: storedToken.userId,
      familyId: storedToken.familyId,
      jti: newJti,
    });
    const newTokenHash = sha256Hex(newRawRefreshToken);

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: {
          isRevoked: true,
          replacedByTokenHash: newTokenHash,
          revokedReason: "ROTATED",
          revokedAt: new Date(),
        },
      }),
      prisma.refreshToken.create({
        data: {
          userId: storedToken.userId,
          deviceId: storedToken.deviceId,
          tokenHash: newTokenHash,
          familyId: storedToken.familyId,
          ipAddress: req.ip,
          userAgent: req.header("user-agent") ?? null,
          expiresAt: new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_SECONDS * 1000),
        },
      }),
    ]);

    const roles = storedToken.user.userRoles.map((ur) => ur.role.name);
    const permissions = Array.from(
      new Set(
        storedToken.user.userRoles.flatMap((ur) =>
          ur.role.rolePermissions.map((rp) => rp.permission.code)
        )
      )
    );

    const accessToken = signAccessToken({
      sub: storedToken.user.id,
      email: storedToken.user.email,
      roles,
      permissions,
      deviceId: storedToken.deviceId ?? undefined,
    });

    setRefreshCookie(res, newRawRefreshToken);

    res.json({
      success: true,
      data: {
        accessToken,
        expiresInSeconds: env.JWT_ACCESS_EXPIRES_IN_SECONDS,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post(
  "/logout",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawToken =
        req.cookies?.[AUTH_CONSTANTS.REFRESH_COOKIE_NAME] ?? req.body?.refreshToken;
      if (rawToken && typeof rawToken === "string") {
        const hash = sha256Hex(rawToken);
        await prisma.refreshToken.updateMany({
          where: { tokenHash: hash, userId: req.user!.id },
          data: { isRevoked: true, revokedReason: "USER_LOGOUT", revokedAt: new Date() },
        });
      }
      res.clearCookie(AUTH_CONSTANTS.REFRESH_COOKIE_NAME, { path: "/api/v1/auth" });
      res.json({ success: true, data: { message: "Logged out of current device" } });
    } catch (err) {
      next(err);
    }
  }
);

authRouter.post(
  "/logout-all",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.$transaction([
        prisma.refreshToken.updateMany({
          where: { userId: req.user!.id, isRevoked: false },
          data: { isRevoked: true, revokedReason: "USER_LOGOUT_ALL", revokedAt: new Date() },
        }),
        prisma.playbackSession.updateMany({
          where: { userId: req.user!.id, status: "ACTIVE" },
          data: { status: "REVOKED", endedAt: new Date() },
        }),
      ]);
      await redis.del(REDIS_KEYS.playbackActiveStreams(req.user!.id));
      res.clearCookie(AUTH_CONSTANTS.REFRESH_COOKIE_NAME, { path: "/api/v1/auth" });
      res.json({
        success: true,
        data: { message: "Revoked all active sessions and playback streams across all devices" },
      });
    } catch (err) {
      next(err);
    }
  }
);
