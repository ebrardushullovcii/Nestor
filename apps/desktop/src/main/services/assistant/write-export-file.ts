import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes an export into `directory` without replacing an existing file:
 * "tracker.csv" becomes "tracker (2).csv" and so on. The assistant exports
 * from chat, where no save dialog can be answered, so it saves to a known
 * folder and reports the path.
 */
export async function writeExportFile(input: {
  directory: string;
  fileName: string;
  content: string;
}): Promise<string> {
  await mkdir(input.directory, { recursive: true });
  const extension = path.extname(input.fileName);
  const stem = path.basename(input.fileName, extension);
  for (let attempt = 1; attempt < 1_000; attempt += 1) {
    const candidate = path.join(
      input.directory,
      attempt === 1 ? input.fileName : `${stem} (${attempt})${extension}`,
    );
    try {
      await access(candidate);
    } catch {
      await writeFile(candidate, input.content, {
        encoding: "utf8",
        flag: "wx",
      });
      return candidate;
    }
  }
  throw new Error("Could not find a free file name for the export.");
}
