import { expect, test } from "vitest";
import type { PreparedApplicationForm } from "@nestor/contracts";
import { createTempRepository } from "./file-repository.test-support";
import { createInMemoryJobFinderRepository } from "./in-memory-repository";
import { createSeed } from "./test-fixtures";

const form: PreparedApplicationForm = {
  id: "result_prepared",
  label: "Remote · Engineer · Synthetic Co",
  savedAt: "2026-10-23T10:00:00.000Z",
  reason: null,
  attachments: [
    {
      kind: "resume_source",
      id: "resume_1",
      name: "synthetic.pdf",
      sha256: "b".repeat(64),
    },
  ],
  snapshot: {
    url: "https://jobs.example/apply/1",
    structure: "a".repeat(64),
    fields: [
      {
        type: "text",
        value: "Synthetic answer",
        checked: false,
        selected: [],
        files: [],
        disabled: false,
        readOnly: false,
      },
    ],
  },
};

test("saved form survives closing SQLite and canonical replacement; reset and deletion remove it", async () => {
  const h = await createTempRepository("nestor-prepared-form-");
  let repository = await h.createRepository();
  try {
    expect(await repository.getPreparedApplicationForm(form.id)).toBeNull();
    await repository.upsertPreparedApplicationForm(form);
    await repository.close();
    repository = await h.createRepository();
    expect(await repository.getPreparedApplicationForm(form.id)).toEqual(form);
    const canonical = await repository.exportState();
    expect(canonical.preparedApplicationForms).toEqual([form]);
    await repository.reset(canonical);
    expect(await repository.getPreparedApplicationForm(form.id)).toEqual(form);
    await repository.deletePreparedApplicationForm(form.id);
    expect(await repository.getPreparedApplicationForm(form.id)).toBeNull();
    await repository.upsertPreparedApplicationForm(form);
    await repository.reset(createSeed());
    expect(await repository.getPreparedApplicationForm(form.id)).toBeNull();
  } finally {
    await repository.close();
    await h.cleanup();
  }
});

test("in-memory repository has the same recovery/reset semantics and returns owned copies", async () => {
  const repository = createInMemoryJobFinderRepository(createSeed());
  await repository.upsertPreparedApplicationForm(form);
  const loaded = await repository.getPreparedApplicationForm(form.id);
  loaded!.label = "changed";
  expect(await repository.getPreparedApplicationForm(form.id)).toEqual(form);
  await repository.reset(createSeed());
  expect(await repository.getPreparedApplicationForm(form.id)).toBeNull();
});
