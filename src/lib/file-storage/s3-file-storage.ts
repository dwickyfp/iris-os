import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FileNotFoundError } from "lib/errors";
import { generateUUID } from "lib/utils";
import type {
  FileMetadata,
  FileStorage,
  UploadOptions,
  UploadUrl,
  UploadUrlOptions,
} from "./file-storage.interface";
import { sanitizeFilename, toBuffer } from "./storage-utils";

type PresignCommand = PutObjectCommand | GetObjectCommand;

export type S3Presigner = (
  client: S3Client,
  command: PresignCommand,
  options: { expiresIn: number },
) => Promise<string>;

export interface S3FileStorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
  prefix?: string;
  client?: S3Client;
  presigner?: S3Presigner;
  clientFactory?: (config: S3ClientConfig) => S3Client;
}

const normalizePrefix = (prefix: string) =>
  prefix.replace(/^\/+|\/+$/g, "").trim();

const buildKey = (filename: string, prefix: string) => {
  const safeName = sanitizeFilename(filename || "file");
  const id = generateUUID();
  return path.posix.join(prefix, `${id}-${safeName}`);
};

const encodeKeySegment = (segment: string) =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const encodeKey = (key: string) =>
  key.split("/").map(encodeKeySegment).join("/");

const buildPublicUrl = (
  bucket: string,
  region: string,
  key: string,
  publicBaseUrl?: string,
  endpoint?: string,
  forcePathStyle?: boolean,
) => {
  const encodedKey = encodeKey(key);

  if (publicBaseUrl) {
    return `${publicBaseUrl.replace(/\/+$/, "")}/${encodedKey}`;
  }

  if (endpoint) {
    const base = endpoint.replace(/\/+$/, "");
    if (forcePathStyle) return `${base}/${bucket}/${encodedKey}`;
    try {
      const url = new URL(base);
      return `${url.protocol}//${bucket}.${url.host}/${encodedKey}`;
    } catch {
      return `${base}/${bucket}/${encodedKey}`;
    }
  }

  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
};

const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "$metadata" in error &&
  (error.$metadata as { httpStatusCode?: number } | undefined)
    ?.httpStatusCode === 404;

/**
 * Creates S3 storage from explicit configuration. Calling without configuration
 * temporarily retains the legacy environment-based factory used by the router.
 */
export const createS3FileStorage = (
  input: S3FileStorageConfig,
): FileStorage => {
  const config = input;
  const {
    accessKeyId,
    bucket,
    endpoint,
    forcePathStyle = false,
    publicBaseUrl,
    region,
    secretAccessKey,
  } = config;
  const prefix = normalizePrefix(config.prefix ?? "uploads");

  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      "S3 accessKeyId and secretAccessKey must be provided together",
    );
  }

  const clientConfig: S3ClientConfig = {
    region,
    endpoint,
    forcePathStyle,
    credentials:
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : undefined,
  };
  const s3 =
    config.client ??
    (config.clientFactory ?? ((options) => new S3Client(options)))(clientConfig);
  const presign = config.presigner ?? (getSignedUrl as S3Presigner);

  return {
    destroy() {
      s3.destroy();
    },
    async upload(content, options: UploadOptions = {}) {
      const buffer = await toBuffer(content);
      const filename = options.filename ?? "file";
      const key = options.key ?? buildKey(filename, prefix);

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: options.contentType,
          Metadata: options.sha256 ? { sha256: options.sha256 } : undefined,
          ACL: undefined,
        }),
      );

      const metadata: FileMetadata = {
        key,
        filename: path.posix.basename(key),
        contentType: options.contentType || "application/octet-stream",
        size: buffer.byteLength,
        uploadedAt: new Date(),
      };

      return {
        key,
        sourceUrl: buildPublicUrl(
          bucket,
          region,
          key,
          publicBaseUrl,
          endpoint,
          forcePathStyle,
        ),
        metadata,
      };
    },

    async createUploadUrl(
      options: UploadUrlOptions,
    ): Promise<UploadUrl | null> {
      const key = buildKey(options.filename, prefix);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: options.contentType,
      });
      const expires = Math.max(
        60,
        Math.min(60 * 60 * 12, options.expiresInSeconds ?? 900),
      );
      const url = await presign(s3, command, { expiresIn: expires });
      return {
        key,
        url,
        method: "PUT",
        expiresAt: new Date(Date.now() + expires * 1000),
        headers: { "Content-Type": options.contentType },
      };
    },

    async download(key) {
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        const body = res.Body;
        if (!body) throw new FileNotFoundError(key);
        const stream = body as unknown as NodeJS.ReadableStream;
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          stream.on("data", (chunk) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          stream.once("end", resolve);
          stream.once("error", reject);
        });
        return Buffer.concat(chunks);
      } catch (error: unknown) {
        if (isNotFound(error)) {
          throw new FileNotFoundError(key, error);
        }
        throw error;
      }
    },

    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async exists(key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error: unknown) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },

    async getMetadata(key) {
      try {
        const res = await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return {
          key,
          filename: path.posix.basename(key),
          contentType: res.ContentType || "application/octet-stream",
          size: Number(res.ContentLength || 0),
          uploadedAt: res.LastModified ?? undefined,
        } satisfies FileMetadata;
      } catch (error: unknown) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async getSourceUrl(key) {
      return buildPublicUrl(
        bucket,
        region,
        key,
        publicBaseUrl,
        endpoint,
        forcePathStyle,
      );
    },

    async getDownloadUrl(key) {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      return presign(s3, command, { expiresIn: 3600 });
    },
  } satisfies FileStorage;
};
