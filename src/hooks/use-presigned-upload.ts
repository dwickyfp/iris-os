"use client";

import { getStorageInfoAction } from "@/app/api/storage/actions";
import { upload as uploadToVercelBlob } from "@vercel/blob/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";

// Types
interface StorageInfo {
  type: "vercel-blob" | "s3" | "minio";
  supportsDirectUpload: boolean;
}

interface UploadOptions {
  filename?: string;
  contentType?: string;
}

interface UploadResult {
  pathname: string;
  url: string;
  contentType?: string;
  size?: number;
}

// Helpers
function useStorageInfo() {
  const { data, isLoading, mutate } = useSWR<StorageInfo>(
    "storage-info",
    getStorageInfoAction,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 60000, // Cache for 1 minute
    },
  );

  return {
    storageType: data?.type,
    supportsDirectUpload: data?.supportsDirectUpload ?? false,
    isLoading,
    revalidate: mutate,
  };
}

/**
 * Hook for uploading files to storage.
 *
 * Automatically uses the optimal upload method based on storage backend:
 * - Vercel Blob: Direct upload from browser (fast)
 * - S3: Presigned URL (future)
 * - Local FS: Server upload (fallback)
 *
 * @example
 * ```tsx
 * function FileUpload() {
 *   const { upload, isUploading } = useFileUpload();
 *
 *   const handleFile = async (file: File) => {
 *     const result = await upload(file);
 *     console.log('Public URL:', result.url);
 *   };
 *
 *   return <input type="file" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />;
 * }
 * ```
 */
export function useFileUpload() {
  const {
    storageType,
    supportsDirectUpload,
    isLoading: isLoadingStorageInfo,
    revalidate: revalidateStorageInfo,
  } = useStorageInfo();
  const [isUploading, setIsUploading] = useState(false);

  // Mirror the latest storage state so an in-flight upload() can read fresh
  // values after waiting, instead of the stale ones captured at call time.
  const storageStateRef = useRef({ storageType, supportsDirectUpload });
  useEffect(() => {
    storageStateRef.current = { storageType, supportsDirectUpload };
  }, [storageType, supportsDirectUpload]);

  const waitForStorageInfo = useCallback(
    async (timeoutMs = 10000): Promise<boolean> => {
      // Revalidate in case the initial fetch failed or is still in flight.
      void revalidateStorageInfo();
      const deadline = Date.now() + timeoutMs;
      while (!storageStateRef.current.storageType && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return Boolean(storageStateRef.current.storageType);
    },
    [revalidateStorageInfo],
  );

  const upload = useCallback(
    async (
      file: File,
      uploadOptions: UploadOptions = {},
    ): Promise<UploadResult | undefined> => {
      if (!(file instanceof File)) {
        toast.error("Upload expects a File instance");
        return;
      }

      const filename = uploadOptions.filename ?? file.name;
      const contentType =
        uploadOptions.contentType || file.type || "application/octet-stream";

      // Wait for storage info to load instead of failing on the first attempt
      if (!storageStateRef.current.storageType) {
        const ready = await waitForStorageInfo();
        if (!ready) {
          toast.error("Storage is not ready yet. Please try again shortly.");
          return;
        }
      }
      const { storageType: type, supportsDirectUpload: direct } =
        storageStateRef.current;

      setIsUploading(true);
      try {
        // Vercel Blob direct upload
        if (type === "vercel-blob") {
          const blob = await uploadToVercelBlob(filename, file, {
            access: "public",
            handleUploadUrl: "/api/storage/upload-url",
            contentType,
          });

          return {
            pathname: blob.pathname,
            url: blob.url,
            contentType: blob.contentType,
            size: file.size,
          };
        }

        // S3 or other direct upload (future)
        if (direct && type === "s3") {
          // Request presigned URL
          const uploadUrlResponse = await fetch("/api/storage/upload-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename, contentType }),
          });

          if (!uploadUrlResponse.ok) {
            const errorBody = await uploadUrlResponse.json().catch(() => ({}));

            // Display detailed error with solution if available
            if (errorBody.solution) {
              toast.error(errorBody.error || "Failed to get upload URL", {
                description: errorBody.solution,
                duration: 10000, // Show for 10 seconds
              });
            } else {
              toast.error(errorBody.error || "Failed to get upload URL");
            }
            return;
          }

          const uploadUrlData = await uploadUrlResponse.json();

          // Upload to presigned URL
          const uploadResponse = await fetch(uploadUrlData.url, {
            method: uploadUrlData.method || "PUT",
            headers: uploadUrlData.headers || { "Content-Type": contentType },
            body: file,
          });

          if (!uploadResponse.ok) {
            toast.error(`Upload failed: ${uploadResponse.status}`);
            return;
          }

          return {
            pathname: uploadUrlData.key,
            // Use server-provided public source URL (not the presigned PUT URL)
            url: uploadUrlData.sourceUrl ?? uploadUrlData.url,
            contentType,
            size: file.size,
          };
        }

        // Fallback: Server upload (Local FS)
        const formData = new FormData();
        formData.append("file", file);

        const serverUploadResponse = await fetch("/api/storage/upload", {
          method: "POST",
          body: formData,
        });

        if (!serverUploadResponse.ok) {
          const errorBody = await serverUploadResponse.json().catch(() => ({}));

          // Display detailed error with solution if available
          if (errorBody.solution) {
            toast.error(errorBody.error || "Server upload failed", {
              description: errorBody.solution,
              duration: 10000, // Show for 10 seconds
            });
          } else {
            toast.error(errorBody.error || "Server upload failed");
          }
          return;
        }

        const result = await serverUploadResponse.json();

        return {
          pathname: result.key,
          url: result.url,
          contentType: result.metadata?.contentType,
          size: result.metadata?.size,
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Upload failed";
        toast.error(message);
        return;
      } finally {
        setIsUploading(false);
      }
    },
    [waitForStorageInfo],
  );

  return {
    upload,
    isUploading: isUploading || isLoadingStorageInfo,
  };
}

// Alias for backward compatibility
export const usePresignedUpload = useFileUpload;
