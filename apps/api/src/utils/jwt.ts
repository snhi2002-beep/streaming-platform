import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";

export interface AccessTokenPayload {
  sub: string;
  email: string;
  roles: string[];
  permissions: string[];
  deviceId?: string;
}

export interface RefreshTokenJwtPayload {
  sub: string;
  familyId: string;
  jti: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ["HS256"],
    }) as AccessTokenPayload;
  } catch {
    throw AppError.unauthorized("Invalid or expired access token");
  }
}

export function signRefreshToken(payload: RefreshTokenJwtPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    algorithm: "HS256",
  });
}

export function verifyRefreshToken(token: string): RefreshTokenJwtPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ["HS256"],
    }) as RefreshTokenJwtPayload;
  } catch {
    throw AppError.unauthorized("Invalid or expired refresh token");
  }
}
