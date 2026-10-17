import { createHash } from "node:crypto";

import {
  ApprovedApplicationAnswerSnapshotSchema,
  serializeApprovedApplicationAnswerSnapshotForDigest,
  type ApprovedApplicationAnswerSnapshot,
  type ApprovedApplicationAnswerSnapshotContent,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
} from "./index";
import { createSeed } from "./test-fixtures";
import {
  createTempRepository,
  type FileRepository,
} from "./file-repository.test-support";

function createSnapshot(
  id: string,
  answer: string,
  revision = 1,
): ApprovedApplicationAnswerSnapshot {
  const content: ApprovedApplicationAnswerSnapshotContent = {
    schemaVersion: 1,
    profileId: "candidate_1",
    entries: [
      {
        id: "profile:workAuthorization",
        kind: "work_authorization",
        label: "Work authorization",
        question: "Are you authorized to work in the selected countries?",
        answer,
        roleFamilies: [],
        proofEntryIds: [],
      },
    ],
  };
  const digest = createHash("sha256")
    .update(
      serializeApprovedApplicationAnswerSnapshotForDigest(content),
      "utf8",
    )
    .digest("hex");
  return ApprovedApplicationAnswerSnapshotSchema.parse({
    ...content,
    id,
    revision,
    digest,
    sourceProfileRevision: 1,
    approvedAt: "2026-08-28T10:00:00.000Z",
  });
}

describe("application answer snapshot repository", () => {
  test("appends immutable revisions with transaction-current CAS and dedupes content", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const first = createSnapshot("answer_snapshot_1", "Yes");

    await expect(
      repository.getLatestApplicationAnswerSnapshot("candidate_1"),
    ).resolves.toBeNull();
    await expect(
      repository.commitApplicationAnswerSnapshot({
        snapshot: first,
        expectedLatestRevision: null,
      }),
    ).resolves.toEqual({ status: "created", snapshot: first });

    await expect(
      repository.commitApplicationAnswerSnapshot({
        snapshot: createSnapshot("answer_snapshot_duplicate", "Yes", 99),
        expectedLatestRevision: 1,
      }),
    ).resolves.toEqual({ status: "duplicate", snapshot: first });

    const second = createSnapshot("answer_snapshot_2", "No", 1);
    await expect(
      repository.commitApplicationAnswerSnapshot({
        snapshot: second,
        expectedLatestRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "created", snapshot: { revision: 2 } });

    await expect(
      repository.commitApplicationAnswerSnapshot({
        snapshot: createSnapshot("answer_snapshot_3", "Maybe"),
        expectedLatestRevision: 1,
      }),
    ).resolves.toMatchObject({
      status: "stale",
      current: { id: "answer_snapshot_2", revision: 2 },
    });

    await expect(
      repository.commitApplicationAnswerSnapshot({
        snapshot: createSnapshot("answer_snapshot_1", "Maybe"),
        expectedLatestRevision: 2,
      }),
    ).resolves.toMatchObject({
      status: "conflict",
      current: { id: "answer_snapshot_1", revision: 1 },
    });

    await expect(
      repository.listApplicationAnswerSnapshots({ profileId: "candidate_1" }),
    ).resolves.toHaveLength(2);
    await expect(
      repository.commitApplicationAnswerSnapshot({
        snapshot: { ...second, digest: "f".repeat(64) },
        expectedLatestRevision: 2,
      }),
    ).rejects.toThrow("digest");

    await repository.reset(createSeed());
    await expect(
      repository.getLatestApplicationAnswerSnapshot("candidate_1"),
    ).resolves.toBeNull();
    await repository.close();
  });

  test("persists, reopens, and resets the append-only collection in SQLite", async () => {
    const temp = await createTempRepository("nestor-answer-snapshot-");
    let repository: FileRepository | null = null;
    let reopened: FileRepository | null = null;
    try {
      repository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed: createSeed(),
      });
      const first = createSnapshot("answer_snapshot_file_1", "Yes");
      await expect(
        repository.commitApplicationAnswerSnapshot({
          snapshot: first,
          expectedLatestRevision: null,
        }),
      ).resolves.toMatchObject({
        status: "created",
        snapshot: { revision: 1 },
      });
      await repository.close();
      repository = null;

      reopened = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed: createSeed(),
      });
      await expect(
        reopened.getLatestApplicationAnswerSnapshot("candidate_1"),
      ).resolves.toEqual(first);
      const second = createSnapshot("answer_snapshot_file_2", "No");
      await expect(
        reopened.commitApplicationAnswerSnapshot({
          snapshot: second,
          expectedLatestRevision: 1,
        }),
      ).resolves.toMatchObject({
        status: "created",
        snapshot: { revision: 2 },
      });

      await reopened.reset(createSeed());
      await expect(reopened.listApplicationAnswerSnapshots()).resolves.toEqual(
        [],
      );
    } finally {
      await repository?.close();
      await reopened?.close();
      await temp.cleanup();
    }
  });
});
