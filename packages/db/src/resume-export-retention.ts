import type { ResumeExportArtifact, TailoredAsset } from "@nestor/contracts";

/** References are metadata only: no resume bodies are needed for file retention. */
export function retainedResumeExportPaths(input: {
  assets: readonly Pick<TailoredAsset, "storagePath">[];
  exports: readonly Pick<
    ResumeExportArtifact,
    | "id"
    | "draftId"
    | "format"
    | "filePath"
    | "exportedAt"
    | "isApproved"
    | "sha256"
  >[];
  references: readonly string[];
}): string[] {
  const references = new Set(input.references);
  const paths = new Set(
    input.assets.flatMap((asset) =>
      asset.storagePath ? [asset.storagePath] : [],
    ),
  );
  const current = new Set<string>();
  for (const artifact of [...input.exports].sort(
    (a, b) =>
      b.exportedAt.localeCompare(a.exportedAt) || a.id.localeCompare(b.id),
  )) {
    const key = `${artifact.draftId}:${artifact.format}`;
    if (
      !current.has(key) ||
      artifact.isApproved ||
      references.has(artifact.id) ||
      references.has(artifact.filePath) ||
      (artifact.sha256 && references.has(artifact.sha256))
    )
      paths.add(artifact.filePath);
    current.add(key);
  }
  for (const value of references)
    if (/[/\\]/u.test(value) && /\.(?:pdf|html)$/iu.test(value))
      paths.add(value);
  return [...paths];
}

/** Used by the memory repository; SQLite selects these scalar leaves directly. */
export function collectResumeFileReferences(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectResumeFileReferences);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(collectResumeFileReferences);
  return [];
}
