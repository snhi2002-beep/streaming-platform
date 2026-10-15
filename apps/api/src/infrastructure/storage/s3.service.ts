import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { env } from "../../config/env.js";
import { AppError } from "../../errors/app-error.js";

export const s3Client = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

export class S3StorageService {
  static async createPresignedUploadUrl(params: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
  }): Promise<{ uploadUrl: string; expiresInSeconds: number }> {
    const command = new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      ContentType: params.contentType,
      ContentLength: params.contentLength,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: env.S3_UPLOAD_URL_EXPIRES_SECONDS,
    });

    return {
      uploadUrl,
      expiresInSeconds: env.S3_UPLOAD_URL_EXPIRES_SECONDS,
    };
  }

  static async verifyUploadedObject(bucket: string, key: string): Promise<{
    contentLength: number;
    contentType: string;
    eTag?: string;
  }> {
    try {
      const head = await s3Client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType ?? "application/octet-stream",
        eTag: head.ETag,
      };
    } catch {
      throw AppError.badRequest(
        "Uploaded media object was not found in private storage",
        "UPLOAD_VALIDATION_FAILED"
      );
    }
  }

  static async downloadToLocalFile(bucket: string, key: string, destinationPath: string): Promise<void> {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body || !(response.Body instanceof Readable)) {
      throw new Error(`Empty S3 body for ${bucket}/${key}`);
    }
    const fileStream = createWriteStream(destinationPath);
    await pipeline(response.Body, fileStream);
  }

  static async uploadLocalFile(params: {
    bucket: string;
    key: string;
    filePath: string;
    contentType: string;
    cacheControl?: string;
  }): Promise<void> {
    const body = await readFile(params.filePath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: body,
        ContentType: params.contentType,
        CacheControl: params.cacheControl ?? "public, max-age=31536000, immutable",
      })
    );
  }
}
