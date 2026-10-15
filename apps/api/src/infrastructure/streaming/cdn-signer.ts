import { getSignedUrl, getSignedCookies } from "@aws-sdk/cloudfront-signer";
import { env } from "../../config/env.js";
import crypto from "node:crypto";

export interface SignedPlaybackGrant {
  masterManifestUrl: string;
  expiresAt: Date;
  signedCookies?: Record<string, string>;
}

export class CdnPlaybackSigner {
  /**
   * Generates authorized CDN URLs and/or Signed Cookies scoped to the asset prefix
   * so adaptive bitrate HLS segment fetches (.ts/.m4s) are authorized at the CDN edge.
   */
  static signHlsPlayback(hlsMasterPlaylistKey: string): SignedPlaybackGrant {
    const expiresAt = new Date(Date.now() + env.PLAYBACK_SESSION_TTL_SECONDS * 1000);
    const resourceBaseUrl = `${env.CDN_BASE_URL.replace(/\/$/, "")}/${hlsMasterPlaylistKey}`;

    if (
      env.CDN_SIGNING_ENABLED &&
      env.CDN_KEY_PAIR_ID &&
      env.CDN_PRIVATE_KEY_BASE64
    ) {
      const privateKey = Buffer.from(env.CDN_PRIVATE_KEY_BASE64, "base64").toString("utf8");
      const assetDirectoryPrefix = resourceBaseUrl.substring(
        0,
        resourceBaseUrl.lastIndexOf("/") + 1
      );

      const policy = JSON.stringify({
        Statement: [
          {
            Resource: `${assetDirectoryPrefix}*`,
            Condition: {
              DateLessThan: {
                "AWS:EpochTime": Math.floor(expiresAt.getTime() / 1000),
              },
            },
          },
        ],
      });

      const cookies = getSignedCookies({
        keyPairId: env.CDN_KEY_PAIR_ID,
        privateKey,
        policy,
      });

      const signedManifestUrl = getSignedUrl({
        url: resourceBaseUrl,
        keyPairId: env.CDN_KEY_PAIR_ID,
        privateKey,
        dateLessThan: expiresAt.toISOString(),
      });

      return {
        masterManifestUrl: signedManifestUrl,
        expiresAt,
        signedCookies: {
          "CloudFront-Policy": cookies["CloudFront-Policy"] ?? "",
          "CloudFront-Signature": cookies["CloudFront-Signature"] ?? "",
          "CloudFront-Key-Pair-Id": cookies["CloudFront-Key-Pair-Id"] ?? "",
        },
      };
    }

    // Development / HMAC signed fallback when CloudFront keys are not active
    const expEpoch = Math.floor(expiresAt.getTime() / 1000);
    const sig = crypto
      .createHmac("sha256", env.JWT_ACCESS_SECRET)
      .update(`${hlsMasterPlaylistKey}:${expEpoch}`)
      .digest("hex");

    return {
      masterManifestUrl: `${resourceBaseUrl}?exp=${expEpoch}&sig=${sig}`,
      expiresAt,
    };
  }
}
