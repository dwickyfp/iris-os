import { createHash, randomUUID } from "node:crypto";
import type { FileStorage } from "lib/file-storage/file-storage.interface";
import type { ArtifactReference } from "./contracts";
import type { ArtifactRepository } from "./repository";

export class ArtifactService {
  constructor(
    private readonly storage: FileStorage,
    private readonly repository: ArtifactRepository,
  ) {}

  async create(input: {
    content: Buffer | string;
    filename: string;
    mediaType: string;
    userId: string;
    runId: string;
  }): Promise<ArtifactReference> {
    const bytes = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uploaded = await this.storage.upload(bytes, {
      filename: input.filename,
      contentType: input.mediaType,
      sha256,
    });
    const reference: ArtifactReference = {
      artifactId: randomUUID(),
      storageKey: uploaded.key,
      filename: input.filename,
      mediaType: input.mediaType,
      size: bytes.byteLength,
      sha256,
    };

    try {
      await this.repository.create({
        ...reference,
        userId: input.userId,
        runId: input.runId,
      });
    } catch (error) {
      await this.storage.delete(uploaded.key).catch(() => undefined);
      throw error;
    }
    return reference;
  }
}
