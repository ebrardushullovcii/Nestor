import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import {
  readPreparedDiscoveryFingerprints,
  DISCOVERY_FINGERPRINT_FIELDS,
  writeDiscoveryPreparation,
  type DiscoveryListingFingerprints,
} from "@nestor/contracts";
import {
  createSavedJob,
  createTempRepository,
} from "./file-repository.test-support";
import { createInMemoryJobFinderRepository } from "./in-memory-repository";
import { createSeed } from "./test-fixtures";

const fingerprint: DiscoveryListingFingerprints = {
  version: 1,
  card: "card-a",
  detail: "detail-a",
  material: "material-a",
};
for (const storage of ["file", "memory"] as const)
  test(`${storage}: fingerprints follow the job transaction and batch reads omit bodies`, async () => {
    const temp =
      storage === "file"
        ? await createTempRepository("nestor-fingerprints-")
        : null;
    let repo = temp
      ? await temp.createRepository()
      : createInMemoryJobFinderRepository(createSeed());
    try {
      const job = createSavedJob({ id: "prepared" });
      expect(
        writeDiscoveryPreparation(job, {
          fingerprints: { owner: job, value: fingerprint },
        }),
      ).toBe(true);
      Object.freeze(job);
      await repo.commitSavedJobDelta({ upserts: [job] });
      expect(
        await repo.readSavedJobDiscoveryFingerprints([
          job.id,
          "missing",
          job.id,
        ]),
      ).toEqual(new Map([[job.id, fingerprint]]));
      await expect(
        repo.commitSavedJobDelta({
          upserts: [createSavedJob({ id: "rolled-back" })],
          updateDiscoveryState() {
            throw new Error("abort");
          },
        }),
      ).rejects.toThrow("abort");
      expect(
        await repo.readSavedJobDiscoveryFingerprints([job.id, "rolled-back"]),
      ).toEqual(new Map([[job.id, fingerprint]]));
      if (temp) {
        await repo.close();
        repo = await temp.createRepository();
        const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        try {
          expect(
            await repo.readSavedJobDiscoveryFingerprints([job.id, "missing"]),
          ).toEqual(new Map([[job.id, fingerprint]]));
          expect(
            prepare.mock.calls.filter(([sql]) =>
              sql.includes(
                "SELECT job_id, value FROM saved_job_discovery_fingerprints",
              ),
            ),
          ).toHaveLength(1);
        } finally {
          prepare.mockRestore();
        }
      }
      const changed = {
        ...job,
        description: "A changed listing needs fresh fingerprints.",
      };
      expect(readPreparedDiscoveryFingerprints(changed)).toBeNull();
      await repo.commitSavedJobDelta({ upserts: [changed] });
      expect(await repo.readSavedJobDiscoveryFingerprints([job.id])).toEqual(
        new Map(),
      );
    } finally {
      await repo.close();
      await temp?.cleanup();
    }
  });

test("carried preparation survives a spread but never JSON or structuredClone", () => {
  const job = createSavedJob();
  writeDiscoveryPreparation(job, {
    fingerprints: { owner: job, value: fingerprint },
  });
  Object.freeze(job);
  expect(readPreparedDiscoveryFingerprints(job)).toEqual(fingerprint);
  expect(
    readPreparedDiscoveryFingerprints({ ...job, status: "approved" }),
  ).toEqual(fingerprint);
  expect(
    readPreparedDiscoveryFingerprints({ ...job, title: "A different title" }),
  ).toBeNull();
  expect(
    readPreparedDiscoveryFingerprints(
      JSON.parse(JSON.stringify(job)) as object,
    ),
  ).toBeNull();
  expect(readPreparedDiscoveryFingerprints(structuredClone(job))).toBeNull();
});

test("mutable owners cannot bypass exact-input checks", () => {
  const job = createSavedJob();
  writeDiscoveryPreparation(job, {
    fingerprints: { owner: job, value: fingerprint },
  });
  expect(readPreparedDiscoveryFingerprints(job)).toBeNull();
  const basis = structuredClone(
    Object.fromEntries(
      DISCOVERY_FINGERPRINT_FIELDS.map((field) => [
        field,
        Reflect.get(job, field),
      ]),
    ),
  );
  writeDiscoveryPreparation(job, {
    fingerprints: { basis, value: fingerprint },
  });
  expect(readPreparedDiscoveryFingerprints(job)).toEqual(fingerprint);
  job.title = "Edited in place";
  expect(readPreparedDiscoveryFingerprints(job)).toBeNull();
});
