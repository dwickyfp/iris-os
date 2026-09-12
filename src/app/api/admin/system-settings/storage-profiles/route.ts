import { randomUUID } from "node:crypto";
import { requireAdminActor } from "auth/permissions";
import { pgStorageProfileRepository } from "lib/db/pg/repositories/storage-profile-repository.pg";
import { encryptSystemSettingValue } from "lib/security/encrypted-value";
import { z } from "zod";

const NO_STORE = { "Cache-Control": "private, no-store" };
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "URL must use HTTP or HTTPS",
  });
const ProfileSchema = z.object({
  name: z.string().trim().min(1).max(160),
  driver: z.enum(["s3", "minio"]),
  endpoint: httpUrl.optional(),
  region: z.string().trim().min(1).max(120).default("us-east-1"),
  bucket: z.string().trim().min(1).max(240).optional(),
  accessKeyId: z.string().min(1).max(4096).optional(),
  secretAccessKey: z.string().min(1).max(4096).optional(),
  forcePathStyle: z.boolean().default(false),
  publicBaseUrl: httpUrl.optional(),
  prefix: z.string().trim().max(256).default("uploads"),
});

function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

export async function GET() {
  try {
    await requireAdminActor();
    return Response.json(
      { profiles: await pgStorageProfileRepository.listForAdmin() },
      { headers: NO_STORE },
    );
  } catch {
    return error("Forbidden", 403);
  }
}

export async function POST(request: Request) {
  let actor: { id: string };
  try {
    actor = await requireAdminActor();
  } catch {
    return error("Forbidden", 403);
  }
  const parsed = ProfileSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return error(parsed.error.issues[0]?.message ?? "Invalid profile", 400);
  const value = parsed.data;
  if (!value.bucket || !value.accessKeyId || !value.secretAccessKey)
    return error("S3/MinIO bucket and credentials are required", 400);
  if (value.driver === "minio" && !value.endpoint)
    return error("MinIO endpoint is required", 400);
  const id = randomUUID();
  const profile = await pgStorageProfileRepository.create({
    id,
    name: value.name,
    driver: value.driver,
    actorId: actor.id,
    s3: {
      endpoint: value.endpoint,
      region: value.region,
      bucket: value.bucket,
      accessKeyId: value.accessKeyId,
      secretAccessKey: value.secretAccessKey,
      forcePathStyle: value.driver === "minio" ? true : value.forcePathStyle,
      publicBaseUrl: value.publicBaseUrl,
      prefix: value.prefix,
    },
    encryptedAccessKey: encryptSystemSettingValue(
      `fileStorage.profile.${id}.accessKey`,
      value.accessKeyId,
    ),
    encryptedSecretKey: encryptSystemSettingValue(
      `fileStorage.profile.${id}.secretKey`,
      value.secretAccessKey,
    ),
  });
  return Response.json(
    {
      profile: {
        id: profile.id,
        name: profile.name,
        driver: profile.driver,
        hasCredentials: true,
        active: false,
      },
    },
    { status: 201, headers: NO_STORE },
  );
}
