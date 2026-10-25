import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { createFileJobFinderRepository } from "./file-repository";
import { readLaunchContext } from "./launch-context";
import { createSeed } from "./test-fixtures";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nestor-launch-context-"));
  dirs.push(dir);
  return path.join(dir, "job-finder-workspace.sqlite");
}

test("a first launch has no workspace yet, so nothing is known", () => {
  expect(readLaunchContext(tempFile())).toEqual({
    settings: null,
    profileSetupState: null,
  });
});

test("an existing workspace gives its settings and guided-setup state", async () => {
  const filePath = tempFile();
  const seed = createSeed();
  const repository = await createFileJobFinderRepository({ filePath, seed });
  await repository.close();

  const context = readLaunchContext(filePath);
  expect(context.settings?.appearanceTheme).toBe(seed.settings.appearanceTheme);
  expect(context.profileSetupState?.status).toBe(seed.profileSetupState.status);
});
