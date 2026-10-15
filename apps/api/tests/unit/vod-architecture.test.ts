import { describe, it, expect } from "vitest";
import { FFmpegProcessor } from "../../src/infrastructure/streaming/ffmpeg.processor.js";
import { hashPassword, verifyPassword, sha256Hex } from "../../src/utils/crypto.js";
import { MATURITY_RATING_ORDER } from "../../src/config/constants.js";

describe("VOD Streaming Platform Core Unit Tests", () => {
  it("hashes and verifies passwords with Argon2id securely", async () => {
    const raw = "Sup3rS3cur3P@ssw0rd!";
    const hash = await hashPassword(raw);
    expect(hash).not.toBe(raw);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, raw)).toBe(true);
    expect(await verifyPassword(hash, "WrongPassword123")).toBe(false);
  });

  it("produces deterministic 64-char SHA-256 hex digests for refresh token storage", () => {
    const digest = sha256Hex("sample-refresh-token-value");
    expect(digest).toHaveLength(64);
    expect(digest).toBe(sha256Hex("sample-refresh-token-value"));
  });

  it("prevents upscaling when selecting HLS adaptive bitrate encoding ladder", () => {
    const ladder720 = FFmpegProcessor.selectEncodingLadder(720);
    expect(ladder720.map((r) => r.name)).toEqual(["360p", "480p", "720p"]);

    const ladder480 = FFmpegProcessor.selectEncodingLadder(480);
    expect(ladder480.map((r) => r.name)).toEqual(["360p", "480p"]);

    const ladder1080 = FFmpegProcessor.selectEncodingLadder(1080);
    expect(ladder1080.map((r) => r.name)).toEqual(["360p", "480p", "720p", "1080p"]);
  });

  it("enforces monotonically increasing maturity rating hierarchy", () => {
    expect(MATURITY_RATING_ORDER["G"]!).toBeLessThan(MATURITY_RATING_ORDER["PG"]!);
    expect(MATURITY_RATING_ORDER["PG"]!).toBeLessThan(MATURITY_RATING_ORDER["PG_13"]!);
    expect(MATURITY_RATING_ORDER["PG_13"]!).toBeLessThan(MATURITY_RATING_ORDER["R"]!);
    expect(MATURITY_RATING_ORDER["R"]!).toBeLessThan(MATURITY_RATING_ORDER["NC_17"]!);
  });
});
