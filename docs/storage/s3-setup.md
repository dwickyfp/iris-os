# S3 Storage Setup

S3-compatible buckets are configured in **Admin > Settings**, not environment
variables. See [file storage](../tips-guides/file-storage.md) for the operator
workflow.

## Buckets
- Pick a region (e.g., `us-east-2`)
  - Dev/Test example: `iris-os-dev` (public GET on `uploads/` only if needed)
  - Prod example: `iris-os-prod` (private)
- Enable default encryption (SSE-S3) and versioning on both buckets.

## CORS
- Dev bucket: allow PUT/GET/HEAD from the origins you use locally and in staging, for example:
  - `http://localhost:3000`, `http://127.0.0.1:3000`
  - `https://staging.your-domain.com`, `http://staging.your-domain.com`
- Prod bucket: allow GET/HEAD only from your production domain (e.g., `https://app.your-domain.com`). Avoid enabling browser PUT in production.

## Dev public-read policy (prefix-only)
Grant public GET for the `uploads/` prefix on the dev bucket only if you need unauthenticated downloads:
```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPublicReadForUploadsPrefix",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::iris-os-dev/uploads/*"
    }
  ]
}
```

## IAM (app runtime)
Least privilege for app role/user:
- Actions: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:HeadObject`
- Resources: `arn:aws:s3:::<bucket-name>/uploads/*`

## Credentials

Enter a least-privileged access key pair in Admin > Settings. It needs
`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, and `s3:HeadObject` on the
configured prefix. For AWS workloads where workload identity is available,
prefer a runtime role over long-lived static keys; this application currently
activates explicit profiles for portable self-hosted and MinIO deployments.

## Verification

Use **Test** on the storage profile. The probe performs put, head, get,
byte comparison, and delete against the configured bucket. Activation is a
separate explicit action and does not run automatically after a successful test.
