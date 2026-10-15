export const API_PREFIX = "/api/v1";

export const AUTH_CONSTANTS = {
  REFRESH_COOKIE_NAME: "sv_refresh_token",
  CSRF_COOKIE_NAME: "sv_csrf_token",
  CSRF_HEADER_NAME: "x-csrf-token",
  EMAIL_VERIFICATION_TTL_HOURS: 24,
  PASSWORD_RESET_TTL_MINUTES: 30,
  MAX_PROFILES_PER_USER: 5,
} as const;

export const REDIS_KEYS = {
  rateLimit: (scope: string, identifier: string) => `rl:${scope}:${identifier}`,
  loginAttempts: (emailOrIp: string) => `auth:attempts:${emailOrIp}`,
  accountLockout: (userIdOrEmail: string) => `auth:lockout:${userIdOrEmail}`,
  userEntitlement: (userId: string) => `cache:entitlement:${userId}`,
  catalogHome: () => `cache:catalog:home`,
  catalogItem: (slugOrId: string) => `cache:catalog:item:${slugOrId}`,
  playbackActiveStreams: (userId: string) => `playback:active:${userId}`,
  playbackSessionState: (sessionId: string) => `playback:session:${sessionId}`,
  uploadProgress: (assetId: string) => `upload:progress:${assetId}`,
} as const;

export const CACHE_TTL_SECONDS = {
  CATALOG_HOME: 300,
  CATALOG_ITEM: 600,
  USER_ENTITLEMENT: 120,
} as const;

export const QUEUE_NAMES = {
  VIDEO_TRANSCODE: "video-transcode-queue",
  EMAIL_DELIVERY: "email-delivery-queue",
  MEDIA_CLEANUP: "media-cleanup-queue",
} as const;

export interface EncodingRenditionPreset {
  name: "360p" | "480p" | "720p" | "1080p";
  width: number;
  height: number;
  videoBitrateKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  audioBitrateKbps: number;
  profile: "main" | "high";
}

export const HLS_ENCODING_LADDER: readonly EncodingRenditionPreset[] = [
  {
    name: "360p",
    width: 640,
    height: 360,
    videoBitrateKbps: 800,
    maxrateKbps: 856,
    bufsizeKbps: 1200,
    audioBitrateKbps: 96,
    profile: "main",
  },
  {
    name: "480p",
    width: 854,
    height: 480,
    videoBitrateKbps: 1400,
    maxrateKbps: 1498,
    bufsizeKbps: 2100,
    audioBitrateKbps: 128,
    profile: "main",
  },
  {
    name: "720p",
    width: 1280,
    height: 720,
    videoBitrateKbps: 2800,
    maxrateKbps: 2996,
    bufsizeKbps: 4200,
    audioBitrateKbps: 128,
    profile: "high",
  },
  {
    name: "1080p",
    width: 1920,
    height: 1080,
    videoBitrateKbps: 5000,
    maxrateKbps: 5350,
    bufsizeKbps: 7500,
    audioBitrateKbps: 192,
    profile: "high",
  },
] as const;

export const ALLOWED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
] as const;

export const MATURITY_RATING_ORDER: Record<string, number> = {
  G: 1,
  PG: 2,
  PG_13: 3,
  R: 4,
  NC_17: 5,
};
