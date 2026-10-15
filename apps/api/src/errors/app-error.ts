export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_SUSPENDED"
  | "TOKEN_REUSE_DETECTED"
  | "RESOURCE_NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMIT_EXCEEDED"
  | "SUBSCRIPTION_REQUIRED"
  | "MATURITY_RESTRICTION"
  | "CONCURRENT_STREAM_LIMIT_EXCEEDED"
  | "DEVICE_LIMIT_EXCEEDED"
  | "UPLOAD_VALIDATION_FAILED"
  | "MEDIA_NOT_READY"
  | "PAYMENT_PROVIDER_ERROR"
  | "INTERNAL_SERVER_ERROR";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace(this);
  }

  static badRequest(message: string, code: ErrorCode = "VALIDATION_ERROR", details?: unknown) {
    return new AppError(400, code, message, details);
  }

  static unauthorized(message = "Authentication required", code: ErrorCode = "UNAUTHORIZED") {
    return new AppError(401, code, message);
  }

  static forbidden(message = "Insufficient permissions", code: ErrorCode = "FORBIDDEN") {
    return new AppError(403, code, message);
  }

  static notFound(message = "The requested resource was not found") {
    return new AppError(404, "RESOURCE_NOT_FOUND", message);
  }

  static conflict(message: string) {
    return new AppError(409, "CONFLICT", message);
  }

  static tooManyRequests(message = "Rate limit exceeded", code: ErrorCode = "RATE_LIMIT_EXCEEDED") {
    return new AppError(429, code, message);
  }

  static internal(message = "An unexpected internal error occurred") {
    return new AppError(500, "INTERNAL_SERVER_ERROR", message, undefined, false);
  }
}
