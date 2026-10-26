import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { createTempRepository } from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";
import { openJobStore } from "./job-store/job-store";
import { createActivityControlStore } from "./job-store/activity-control";
import type * as StateModule from "./internal/state";

const failWrite = vi.hoisted(() => ({ next: false }));
vi.mock("./internal/state", async (importOriginal) => {
  const actual = await importOriginal<typeof StateModule>();
  return {
    ...actual,
    writeState: (...args: Parameters<typeof actual.writeState>) => {
      if (failWrite.next) {
        failWrite.next = false;
        throw new Error("database is locked");
      }
      actual.writeState(...args);
    },
  };
});

afterEach(() => {
  failWrite.next = false;
});

test("a reset that fails part way leaves work paused; a finished one lowers it", async () => {
  const fixture = await createTempRepository("nestor-reset-pause-");
  const repository = await fixture.createRepository();
  const readPause = () => {
    const store = openJobStore(`${fixture.filePath}.jobs.sqlite`);
    try {
      return createActivityControlStore(store).read();
    } finally {
      store.close();
    }
  };
  try {
    expect(readPause().paused).toBe(false);
    failWrite.next = true;
    await expect(repository.reset(createSeed())).rejects.toThrow(
      "database is locked",
    );
    expect(readPause()).toMatchObject({
      paused: true,
      reason: expect.stringContaining(
        "Reset everything didn't finish",
      ) as string,
    });
    await repository.reset(createSeed());
    expect(readPause().paused).toBe(false);
  } finally {
    await repository.close();
    await fixture.cleanup();
  }
});

test("export reads the pause and instructions from the store, not retired old values", async () => {
  const fixture = await createTempRepository("nestor-export-retired-");
  const repository = await fixture.createRepository();
  try {
    const old = new DatabaseSync(fixture.filePath);
    try {
      old
        .prepare(
          "INSERT OR REPLACE INTO singleton_state(key,value) VALUES('activity_control','not json')",
        )
        .run();
      old
        .prepare(
          "INSERT INTO source_instruction_artifacts(id,value) VALUES('x','not json')",
        )
        .run();
    } finally {
      old.close();
    }
    await repository.saveActivityControl({
      paused: true,
      pausedAt: "2026-10-26T00:00:00.000Z",
      reason: null,
    });
    const exported = await repository.exportState();
    expect(exported.activityControl.paused).toBe(true);
    expect(exported.sourceInstructionArtifacts).toEqual([]);
  } finally {
    await repository.close();
    await fixture.cleanup();
  }
});
