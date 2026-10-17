import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  CandidateAssetDeleteResultSchema,
  CandidateAssetImportInputSchema,
  CandidateAssetImportResultSchema,
  CandidateAssetListResultSchema,
  CandidateAssetRestoreInputSchema,
  CandidateAssetRestoreResultSchema,
  CandidateAssetSchema,
  type CandidateAsset,
  type CandidateAssetDeleteResult,
  type CandidateAssetImportInput,
  type ParsedCandidateAssetImportInput,
  type CandidateAssetImportResult,
  type CandidateAssetKind,
  type CandidateAssetListInput,
  type CandidateAssetListResult,
  type CandidateAssetRestoreInput,
  type CandidateAssetRestoreResult,
  type CandidateAssetRetention,
} from "@nestor/contracts";

const GLOBAL_MAX_BYTES = 25 * 1024 * 1024;
const TEXT_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const DOCX_MAX_BYTES = 15 * 1024 * 1024;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;
const TRASH_GRACE_DAYS = 7;
const ORPHAN_RECOVERY_GRACE_MILLISECONDS = 60 * 60 * 1_000;
const ASSET_STORAGE_NAME_PATTERN =
  /^asset_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/;
const ASSET_IMPORTING_NAME_PATTERN =
  /^asset_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+\.importing$/;

const supportedMimeByKind: Record<CandidateAssetKind, ReadonlySet<string>> = {
  resume: new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ]),
  cover_letter: new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ]),
  application_response: new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ]),
  portfolio: new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/plain",
  ]),
  work_sample: new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/plain",
  ]),
  transcript: new Set([
    "application/pdf",
    "text/plain",
    "text/vtt",
    "application/x-subrip",
  ]),
  certificate: new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]),
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
  other: new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/plain",
    "text/vtt",
    "application/x-subrip",
  ]),
};

interface InternalCandidateAssetRecord {
  asset: CandidateAsset;
  storageName: string;
}

interface CandidateAssetIndex {
  version: 1;
  assets: InternalCandidateAssetRecord[];
}

function parseCandidateAssetIndex(value: unknown): CandidateAssetIndex {
  if (!value || typeof value !== "object") {
    throw new CandidateAssetLibraryError(
      "The candidate asset index is invalid.",
    );
  }
  const candidate = value as { version?: unknown; assets?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.assets)) {
    throw new CandidateAssetLibraryError(
      "The candidate asset index is invalid.",
    );
  }
  const assets = candidate.assets.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new CandidateAssetLibraryError(
        "The candidate asset index is invalid.",
      );
    }
    const record = entry as { asset?: unknown; storageName?: unknown };
    if (
      typeof record.storageName !== "string" ||
      !ASSET_STORAGE_NAME_PATTERN.test(record.storageName)
    ) {
      throw new CandidateAssetLibraryError(
        "The candidate asset index is invalid.",
      );
    }
    return {
      asset: CandidateAssetSchema.parse(record.asset),
      storageName: record.storageName,
    };
  });
  return { version: 1, assets };
}

/** File extensions a person would recognise, per stored media type. */
const FILE_TYPE_NAMES: Readonly<Record<string, string>> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
  "text/plain": "plain text (TXT, MD, CSV)",
  "text/vtt": "VTT",
  "application/x-subrip": "SRT",
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/webp": "WEBP",
};

/**
 * The file types one category accepts, written the way a person would say
 * them. Choosing "Certificate" and picking a .txt used to fail with the raw
 * storage sentence, which never said what would have worked.
 */
export function describeAcceptedFileTypes(kind: CandidateAssetKind): string {
  const names = [...supportedMimeByKind[kind]].map(
    (mime) => FILE_TYPE_NAMES[mime] ?? mime,
  );
  if (names.length <= 1) {
    return names[0] ?? "no file types";
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export class CandidateAssetLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateAssetLibraryError";
  }
}

function hasPrefix(bytes: Buffer, prefix: readonly number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

function isValidUtf8Text(bytes: Buffer) {
  const text = bytes.toString("utf8");
  return !text.includes("\u0000") && !text.includes("\uFFFD");
}

function detectMime(bytes: Buffer, originalName: string): string | null {
  const extension = path.extname(originalName).toLowerCase();
  if (
    extension === ".pdf" &&
    bytes.subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    return "application/pdf";
  }
  if (extension === ".png" && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return hasPrefix(bytes, [0xff, 0xd8, 0xff]) ? "image/jpeg" : null;
  }
  if (
    extension === ".webp" &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (extension === ".docx" && hasPrefix(bytes, [0x50, 0x4b])) {
    const zipDirectory = bytes.toString("latin1");
    if (
      zipDirectory.includes("[Content_Types].xml") &&
      zipDirectory.includes("word/")
    ) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    return null;
  }
  if ([".txt", ".md", ".csv"].includes(extension) && isValidUtf8Text(bytes)) {
    return "text/plain";
  }
  if (extension === ".vtt" && isValidUtf8Text(bytes)) return "text/vtt";
  if (extension === ".srt" && isValidUtf8Text(bytes))
    return "application/x-subrip";
  return null;
}

function getMimeByteLimit(mime: string) {
  if (mime.startsWith("text/") || mime === "application/x-subrip")
    return TEXT_MAX_BYTES;
  if (mime.startsWith("image/")) return IMAGE_MAX_BYTES;
  if (mime.includes("officedocument")) return DOCX_MAX_BYTES;
  return GLOBAL_MAX_BYTES;
}

function createExtractedTextMetadata(
  bytes: Buffer,
  mime: string,
  createdAt: string,
) {
  if (!mime.startsWith("text/") && mime !== "application/x-subrip") return null;
  return {
    status: "ready" as const,
    characterCount: [...bytes.toString("utf8")].length,
    language: null,
    extractedAt: createdAt,
  };
}

function addDays(timestamp: string, days: number) {
  return new Date(
    new Date(timestamp).getTime() + days * DAY_IN_MILLISECONDS,
  ).toISOString();
}

function getExpiresAt(
  retention: CandidateAssetRetention,
  retentionStartedAt: string,
) {
  if (retention === "until_deleted") return null;
  return addDays(retentionStartedAt, retention === "30_days" ? 30 : 90);
}

function createActiveLifecycle(
  retention: CandidateAssetRetention,
  retentionStartedAt: string,
) {
  return {
    retentionStartedAt,
    expiresAt: getExpiresAt(retention, retentionStartedAt),
    deletionReason: null,
    purgeAt: null,
  } as const;
}

export class CandidateAssetLibrary {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rootDirectory: string,
    private readonly now: () => Date = () => new Date(),
    private readonly deleteStoredFile: (filePath: string) => Promise<void> = (
      filePath,
    ) => rm(filePath, { force: true }),
  ) {}

  list(input: CandidateAssetListInput): Promise<CandidateAssetListResult> {
    return this.runExclusive(async () => {
      const index = await this.enforceLifecycleUnsafe(this.now());
      return CandidateAssetListResultSchema.parse({
        assets: index.assets
          .map((record) => record.asset)
          .filter((asset) => input.includeDeleted || asset.deletedAt === null)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      });
    });
  }

  resolveForApplication(assetId: string) {
    return this.runExclusive(async () => {
      const index = await this.enforceLifecycleUnsafe(this.now());
      const record = this.getAttachableRecord(index, assetId);
      await this.readVerifiedBytes(record);
      return {
        asset: record.asset,
        loadVerifiedBytes: () =>
          this.runExclusive(async () => {
            const refreshedIndex = await this.enforceLifecycleUnsafe(
              this.now(),
            );
            const refreshedRecord = this.getAttachableRecord(
              refreshedIndex,
              assetId,
            );
            return this.readVerifiedBytes(refreshedRecord);
          }),
      };
    });
  }

  /**
   * Writes a read-only copy of a saved file, under the name the person knows
   * it by, into `directory` and returns its path. The stored copy is never
   * handed out, so viewing can not change what an application attaches.
   */
  writeViewingCopy(assetId: string, directory: string): Promise<string> {
    return this.runExclusive(async () => {
      const index = await this.enforceLifecycleUnsafe(this.now());
      const record = index.assets.find(
        (candidate) => candidate.asset.id === assetId,
      );
      if (!record || record.asset.deletedAt !== null) {
        throw new CandidateAssetLibraryError(
          "This file is no longer saved in Job Finder.",
        );
      }
      const bytes = await this.readVerifiedBytes(record);
      const viewingDirectory = path.join(directory, randomUUID());
      await mkdir(viewingDirectory, { recursive: true, mode: 0o700 });
      const viewingPath = path.join(
        viewingDirectory,
        path.basename(record.asset.originalName),
      );
      await writeFile(viewingPath, bytes, { mode: 0o400 });
      return viewingPath;
    });
  }

  importFromSourcePath(
    sourcePath: string,
    rawInput: CandidateAssetImportInput,
  ): Promise<CandidateAssetImportResult> {
    const input = CandidateAssetImportInputSchema.parse(rawInput);
    return this.runExclusive(async () => {
      await this.enforceLifecycleUnsafe(this.now());
      return this.importUnsafe(sourcePath, input);
    });
  }

  softDelete(assetId: string): Promise<CandidateAssetDeleteResult> {
    return this.runExclusive(async () => {
      const timestamp = this.now().toISOString();
      const index = await this.enforceLifecycleUnsafe(new Date(timestamp));
      const record = index.assets.find(
        (candidate) => candidate.asset.id === assetId,
      );
      if (!record)
        throw new CandidateAssetLibraryError("Candidate asset was not found.");
      if (record.asset.deletedAt === null) {
        record.asset = CandidateAssetSchema.parse({
          ...record.asset,
          deletedAt: timestamp,
          lifecycle: {
            ...(record.asset.lifecycle ??
              createActiveLifecycle(
                record.asset.retention,
                record.asset.createdAt,
              )),
            deletionReason: "removed",
            purgeAt: addDays(timestamp, TRASH_GRACE_DAYS),
          },
        });
        await this.writeIndex(index);
      }
      return CandidateAssetDeleteResultSchema.parse({ asset: record.asset });
    });
  }

  restore(
    rawInput: CandidateAssetRestoreInput,
  ): Promise<CandidateAssetRestoreResult> {
    const input = CandidateAssetRestoreInputSchema.parse(rawInput);
    return this.runExclusive(async () => {
      const timestamp = this.now().toISOString();
      const index = await this.enforceLifecycleUnsafe(new Date(timestamp));
      const record = index.assets.find(
        (candidate) => candidate.asset.id === input.assetId,
      );
      if (!record) {
        throw new CandidateAssetLibraryError(
          "Candidate asset is no longer available in Trash.",
        );
      }
      if (record.asset.deletedAt === null) {
        throw new CandidateAssetLibraryError(
          "Candidate asset is already active.",
        );
      }

      await this.readVerifiedBytes(record);
      record.asset = CandidateAssetSchema.parse({
        ...record.asset,
        retention: input.retention,
        deletedAt: null,
        lifecycle: createActiveLifecycle(input.retention, timestamp),
      });
      await this.writeIndex(index);
      return CandidateAssetRestoreResultSchema.parse({ asset: record.asset });
    });
  }

  enforceLifecycle(): Promise<void> {
    return this.runExclusive(async () => {
      await this.enforceLifecycleUnsafe(this.now());
    });
  }

  private async importUnsafe(
    sourcePath: string,
    input: ParsedCandidateAssetImportInput,
  ): Promise<CandidateAssetImportResult> {
    const sourceStats = await stat(sourcePath).catch(() => null);
    if (!sourceStats?.isFile()) {
      throw new CandidateAssetLibraryError("Select a readable file to import.");
    }
    if (sourceStats.size <= 0 || sourceStats.size > GLOBAL_MAX_BYTES) {
      throw new CandidateAssetLibraryError(
        "The selected file must be between 1 byte and 25 MB.",
      );
    }

    const bytes = await readFile(sourcePath);
    if (
      bytes.byteLength !== sourceStats.size ||
      bytes.byteLength > GLOBAL_MAX_BYTES
    ) {
      throw new CandidateAssetLibraryError(
        "The selected file changed while it was being imported.",
      );
    }
    const originalName = path.basename(sourcePath);
    const mime = detectMime(bytes, originalName);
    if (!mime || !supportedMimeByKind[input.kind].has(mime)) {
      throw new CandidateAssetLibraryError(
        `${path.extname(originalName).replace(".", "").toUpperCase() || "That"} files cannot be saved under ${input.kind.replaceAll("_", " ")}. This category accepts ${describeAcceptedFileTypes(input.kind)}.`,
      );
    }
    if (bytes.byteLength > getMimeByteLimit(mime)) {
      throw new CandidateAssetLibraryError(
        "The selected file exceeds the size limit for its file type.",
      );
    }

    const id = `asset_${randomUUID()}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const extension = path.extname(originalName).toLowerCase();
    const storageName = `${id}${extension}`;
    const destinationPath = path.join(this.rootDirectory, storageName);
    const temporaryPath = `${destinationPath}.importing`;
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });

    try {
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      const copiedBytes = await readFile(temporaryPath);
      const copiedSha256 = createHash("sha256")
        .update(copiedBytes)
        .digest("hex");
      if (copiedSha256 !== sha256) {
        throw new CandidateAssetLibraryError(
          "The imported copy failed integrity verification.",
        );
      }
      await rename(temporaryPath, destinationPath);

      const createdAt = this.now().toISOString();
      const asset = CandidateAssetSchema.parse({
        id,
        kind: input.kind,
        originalName,
        mime,
        byteSize: bytes.byteLength,
        sha256,
        createdAt,
        sensitivity: input.sensitivity,
        consentScope: input.consentScope,
        retention: input.retention,
        deletedAt: null,
        lifecycle: createActiveLifecycle(input.retention, createdAt),
        extractedText: createExtractedTextMetadata(bytes, mime, createdAt),
        forJob: input.forJob,
      });
      const index = await this.readIndex();
      index.assets.push({ asset, storageName });
      await this.writeIndex(index);
      return CandidateAssetImportResultSchema.parse({
        status: "imported",
        asset,
      });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await rm(destinationPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async enforceLifecycleUnsafe(now: Date) {
    const index = await this.readIndex();
    await this.recoverOrphanFilesUnsafe(index, now);
    const nowTimestamp = now.toISOString();
    const retainedRecords: InternalCandidateAssetRecord[] = [];
    let changed = false;

    for (const record of index.assets) {
      let asset = record.asset;
      if (!asset.lifecycle) {
        const lifecycle = createActiveLifecycle(
          asset.retention,
          asset.createdAt,
        );
        const legacyExpiredAt =
          asset.deletedAt !== null &&
          lifecycle.expiresAt !== null &&
          asset.deletedAt >= lifecycle.expiresAt
            ? lifecycle.expiresAt
            : null;
        asset = CandidateAssetSchema.parse({
          ...asset,
          deletedAt: legacyExpiredAt ?? asset.deletedAt,
          lifecycle:
            asset.deletedAt === null
              ? lifecycle
              : {
                  ...lifecycle,
                  deletionReason: legacyExpiredAt ? "expired" : "removed",
                  purgeAt: addDays(
                    legacyExpiredAt ?? asset.deletedAt,
                    TRASH_GRACE_DAYS,
                  ),
                },
        });
        changed = true;
      }

      if (
        asset.deletedAt === null &&
        asset.lifecycle?.expiresAt !== null &&
        asset.lifecycle?.expiresAt !== undefined &&
        asset.lifecycle.expiresAt <= nowTimestamp
      ) {
        const expiredAt = asset.lifecycle.expiresAt;
        asset = CandidateAssetSchema.parse({
          ...asset,
          deletedAt: expiredAt,
          lifecycle: {
            ...asset.lifecycle,
            deletionReason: "expired",
            purgeAt: addDays(expiredAt, TRASH_GRACE_DAYS),
          },
        });
        changed = true;
      }

      if (
        asset.deletedAt !== null &&
        asset.lifecycle?.purgeAt !== null &&
        asset.lifecycle?.purgeAt !== undefined &&
        asset.lifecycle.purgeAt <= nowTimestamp
      ) {
        await this.deleteStoredFile(
          path.join(this.rootDirectory, record.storageName),
        );
        changed = true;
        continue;
      }

      record.asset = asset;
      retainedRecords.push(record);
    }

    if (changed) {
      index.assets = retainedRecords;
      await this.writeIndex(index);
    }
    return index;
  }

  private async recoverOrphanFilesUnsafe(
    index: CandidateAssetIndex,
    now: Date,
  ) {
    const indexedStorageNames = new Set(
      index.assets.map((record) => record.storageName),
    );
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isStoredAsset = ASSET_STORAGE_NAME_PATTERN.test(entry.name);
      const isImportingAsset = ASSET_IMPORTING_NAME_PATTERN.test(entry.name);
      if (!isStoredAsset && !isImportingAsset) continue;
      if (isStoredAsset && indexedStorageNames.has(entry.name)) continue;

      const filePath = path.join(this.rootDirectory, entry.name);
      const fileStats = await stat(filePath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (!fileStats?.isFile()) continue;
      if (
        now.getTime() - fileStats.mtimeMs <
        ORPHAN_RECOVERY_GRACE_MILLISECONDS
      ) {
        continue;
      }

      await this.deleteStoredFile(filePath);
    }
  }

  private getAttachableRecord(index: CandidateAssetIndex, assetId: string) {
    const record = index.assets.find(
      (candidate) => candidate.asset.id === assetId,
    );
    if (!record || record.asset.deletedAt !== null) {
      throw new CandidateAssetLibraryError(
        "The selected candidate asset is no longer available.",
      );
    }
    if (record.asset.consentScope !== "job_application_attachment") {
      throw new CandidateAssetLibraryError(
        "This asset is stored privately but is not approved for application attachments.",
      );
    }
    return record;
  }

  private async readVerifiedBytes(record: InternalCandidateAssetRecord) {
    const filePath = path.join(this.rootDirectory, record.storageName);
    const bytes = await readFile(filePath).catch(() => null);
    if (!bytes || bytes.byteLength !== record.asset.byteSize) {
      throw new CandidateAssetLibraryError(
        "The selected asset is missing or changed on disk.",
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== record.asset.sha256) {
      throw new CandidateAssetLibraryError(
        "The selected asset failed integrity verification.",
      );
    }
    return Uint8Array.from(bytes);
  }

  private async readIndex(): Promise<CandidateAssetIndex> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const indexPath = path.join(this.rootDirectory, "index.json");
    const raw = await readFile(indexPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (raw === null) return { version: 1, assets: [] };
    try {
      return parseCandidateAssetIndex(JSON.parse(raw));
    } catch {
      throw new CandidateAssetLibraryError(
        "The candidate asset index is invalid.",
      );
    }
  }

  private async writeIndex(index: CandidateAssetIndex) {
    const parsed = parseCandidateAssetIndex(index);
    const indexPath = path.join(this.rootDirectory, "index.json");
    const temporaryPath = path.join(
      this.rootDirectory,
      `index.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, JSON.stringify(parsed, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, indexPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
