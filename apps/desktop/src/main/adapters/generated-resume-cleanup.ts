import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

/** Resolve managed paths in a moved workspace without touching their old location. */
function localExportPath(directory: string, value: string): string | null {
  const normalized = value.replaceAll("\\", "/");
  const marker = "/documents/resumes/generated/";
  const markerAt = normalized.toLowerCase().lastIndexOf(marker);
  const resolved =
    markerAt >= 0
      ? path.resolve(directory, normalized.slice(markerAt + marker.length))
      : path.resolve(value);
  const relative = path.relative(directory, resolved);
  return relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
    ? resolved
    : null;
}

export function createGeneratedResumeCleanup(input: {
  directory: string;
  retainedPaths: () => Promise<readonly string[]>;
}) {
  const directory = path.resolve(input.directory);
  const pathKey = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const pendingDirectories = new Set<string>();
  const pendingFiles = new Set<string>();
  let queued: Promise<void> = Promise.resolve();
  return {
    rendering(artifactDirectory: string) {
      pendingDirectories.add(pathKey(path.resolve(artifactDirectory)));
    },
    renderingFile(file: string) {
      pendingFiles.add(pathKey(path.resolve(file)));
    },
    async discard(file: string) {
      const local = localExportPath(directory, file);
      if (!local || pathKey(local) !== pathKey(path.resolve(file))) return;
      const key = pathKey(local);
      const parent = path.dirname(local);
      if (!pendingFiles.has(key) && !pendingDirectories.has(pathKey(parent)))
        return;
      await unlink(local).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      pendingFiles.delete(key);
      pendingDirectories.delete(pathKey(parent));
      if (parent !== directory)
        await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT")
            throw error;
        });
    },
    prune(): Promise<void> {
      const operation = queued.then(async () => {
        const retained = new Set(
          (await input.retainedPaths()).flatMap((value) => {
            const local = localExportPath(directory, value);
            return local ? [pathKey(local)] : [];
          }),
        );
        // Persisted exports release their reservation. Concurrent uncommitted
        // renders stay protected until their own successful persistence.
        for (const file of retained) {
          pendingDirectories.delete(path.dirname(file));
          pendingFiles.delete(file);
        }
        const root = await lstat(directory).catch(() => null);
        if (!root?.isDirectory() || root.isSymbolicLink()) return;
        const visit = async (folder: string): Promise<void> => {
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name);
            if (entry.isSymbolicLink() || pendingDirectories.has(pathKey(file)))
              continue;
            if (entry.isDirectory()) {
              await visit(file);
              await rmdir(file).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT")
                  throw error;
              });
            } else if (
              entry.isFile() &&
              /\.(pdf|html)$/iu.test(entry.name) &&
              !/(?:^|-)cover-letter\.(pdf|html)$/iu.test(entry.name) &&
              !retained.has(pathKey(file)) &&
              !pendingFiles.has(pathKey(file))
            ) {
              await unlink(file).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              });
            }
          }
        };
        await visit(directory);
      });
      queued = operation.catch(() => undefined);
      return operation;
    },
  };
}
