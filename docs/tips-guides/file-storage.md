# File Storage

Iris stores user uploads, generated images, reports, canonical artifacts, and
large capability-result evidence in S3-compatible object storage.

## Configure in Admin > Settings

Use **Object Storage Profiles** on `/admin/settings`:

1. Enter the MinIO or S3 endpoint, region, bucket, access key, secret key,
   optional public base URL, and prefix.
2. Choose **Create MinIO Profile**.
3. Choose **Test**. The server writes, reads, verifies, and deletes a bounded
   probe object under `iris-health/`.
4. Choose **Activate** only after the test passes.

Access and secret keys are encrypted with AES-256-GCM before persistence and are
never returned to the browser. Profiles are immutable location records: changing
buckets or endpoints creates a new profile rather than rewriting the location of
existing objects.

The first activation does not adopt untracked historical objects by default.
Select the adoption option only when those objects already live in the same
bucket/endpoint represented by the profile. If an older deployment used another
backend, migrate or explicitly re-register those objects first; otherwise their
downloads and cleanup must be completed with the original backend before
switching.

## Local MinIO

The Docker stack includes MinIO on ports `9000` (S3 API) and `9001` (console)
and creates an `iris` bucket. From the application container, use:

```text
Endpoint: http://minio:9000
Region: us-east-1
Bucket: iris
Force path style: true
```

For browser-visible source URLs, expose MinIO through a reverse proxy or CDN and
set **Public base URL** to that externally reachable origin. Do not use the
internal Docker hostname as the public URL.

## Upload behavior

- Browser-to-server uploads are authenticated and limited to 50 MiB.
- Every upload is registered in PostgreSQL with its owner, storage profile, key,
  filename, media type, and size.
- CSV ingestion resolves the key through that ownership record; it cannot read
  arbitrary object keys.
- Canonical artifacts remain private and download through authenticated
  `/api/artifacts/:artifactId`, which rechecks ownership, active state, length,
  and SHA-256.
- Cleanup records retain their original storage-profile identity, so worker
  deletion targets the backend where the object was created.
