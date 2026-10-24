import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ResumeExportArtifactSchema } from "@nestor/contracts";
import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
} from "./index";
import { retainedResumeExportPaths } from "./resume-export-retention";
import { createSeed } from "./test-fixtures";
import { cleanupTempDirectoryWithRetry } from "./file-repository.test-support";

const artifact = (id: string, day: number, extra = {}) =>
  ResumeExportArtifactSchema.parse({
    id,
    draftId: "draft",
    jobId: "job",
    format: "pdf",
    filePath: `/managed/${id}.pdf`,
    templateId: "classic_ats",
    exportedAt: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`,
    ...extra,
  });

test("keeps current formats, approved files and application references by path, id or checksum", () => {
  const exports = [
    artifact("old", 1),
    artifact("approved", 2, { isApproved: true }),
    artifact("sent", 3),
    artifact("prepared", 4),
    artifact("checksum", 5, { sha256: "a".repeat(64) }),
    artifact("current-html", 6, {
      format: "html",
      filePath: "/managed/current.html",
    }),
    artifact("current", 7),
  ];
  const paths = retainedResumeExportPaths({
    assets: [{ storagePath: "/managed/tailored.pdf" }],
    exports,
    references: [
      "/managed/sent.pdf",
      "prepared",
      "a".repeat(64),
      "/managed/historical-application.pdf",
    ],
  });
  expect(paths.sort()).toEqual(
    [
      "/managed/approved.pdf",
      "/managed/checksum.pdf",
      "/managed/current.html",
      "/managed/current.pdf",
      "/managed/historical-application.pdf",
      "/managed/prepared.pdf",
      "/managed/sent.pdf",
      "/managed/tailored.pdf",
    ].sort(),
  );
});

test("SQLite and memory retain an older export referenced only by a parked form", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resume-retention-db-"));
  const seed = createSeed();
  seed.resumeExportArtifacts = [
    artifact("unused", 1),
    artifact("prepared", 2),
    artifact("current", 3),
  ];
  seed.preparedApplicationForms = [
    {
      id: "result",
      label: "Synthetic application",
      savedAt: "2026-10-24T00:00:00.000Z",
      snapshot: null,
      reason: "unsupported_form",
      attachments: [
        {
          kind: "resume_export",
          id: "prepared",
          name: "resume.pdf",
          sha256: "a".repeat(64),
        },
      ],
    },
  ];
  const memory = createInMemoryJobFinderRepository(seed);
  const file = await createFileJobFinderRepository({
    filePath: path.join(root, "workspace.sqlite"),
    seed,
  });
  try {
    expect([...(await file.listRetainedResumeExportPaths())].sort()).toEqual([
      "/managed/current.pdf",
      "/managed/prepared.pdf",
    ]);
    expect([...(await memory.listRetainedResumeExportPaths())].sort()).toEqual(
      [...(await file.listRetainedResumeExportPaths())].sort(),
    );
  } finally {
    await file.close();
    await memory.close();
    await cleanupTempDirectoryWithRetry(root);
  }
});
