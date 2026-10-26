import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
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

test("a first launch has no workspace yet", () => {
  expect(readLaunchContext(tempFile())).toEqual({
    workspace: "none",
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
  expect(context.workspace).toBe("read");
  expect(context.settings?.appearanceTheme).toBe(seed.settings.appearanceTheme);
  expect(context.profileSetupState?.status).toBe(seed.profileSetupState.status);
});

test("a corrupt setup row is unreadable, not a first launch", async () => {
  const filePath = tempFile();
  const repository = await createFileJobFinderRepository({
    filePath,
    seed: createSeed(),
  });
  await repository.close();
  const database = new DatabaseSync(filePath);
  database
    .prepare(
      "UPDATE singleton_state SET value = '{\"status\":42}' WHERE key = 'profile_setup_state'",
    )
    .run();
  database.close();

  expect(readLaunchContext(filePath)).toEqual({
    workspace: "unreadable",
    settings: null,
    profileSetupState: null,
  });
});

test("a file that is not a database is unreadable", () => {
  const filePath = tempFile();
  writeFileSync(filePath, "not a database");
  expect(readLaunchContext(filePath).workspace).toBe("unreadable");
});
