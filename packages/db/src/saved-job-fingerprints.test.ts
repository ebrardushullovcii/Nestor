import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import {
  readPreparedDiscoveryFingerprints,
  readPreparedBodySalaryRange,
  readPreparedSavedJobIdentity,
  captureDiscoverySavedIdentityBasis,
  DISCOVERY_FINGERPRINT_FIELDS,
  writeDiscoveryPreparation,
  type DiscoveryListingFingerprints,
  type DiscoverySavedJobIdentity,
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
const identity: DiscoverySavedJobIdentity = {
  version: 1,
  local: { keys: ["opaque-local"], priorities: [40] },
  acrossSources: {
    keys: ["opaque-local", "opaque-shared"],
    priorities: [40, 60],
  },
  content: {
    digest: "opaque-digest",
    packed: new Uint8Array([0, 1, 128, 255]),
  },
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
          savedIdentity: { owner: job, value: identity },
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
      ).toEqual(new Map([[job.id, { ...fingerprint, identity }]]));
      const [canonical] = await repo.listSavedJobsByIds([job.id]);
      expect(readPreparedDiscoveryFingerprints(canonical!)).toEqual(
        fingerprint,
      );
      expect(readPreparedSavedJobIdentity(canonical!)).toEqual(identity);
      canonical!.title = "Changed in place";
      expect(readPreparedDiscoveryFingerprints(canonical!)).toBeNull();
      expect(readPreparedSavedJobIdentity(canonical!)).toBeNull();
      const [borrowed] = await repo.readSavedJobsProjection();
      const get = vi.spyOn(StatementSync.prototype, "get");
      try {
        expect(readPreparedDiscoveryFingerprints(borrowed!)).toEqual(
          fingerprint,
        );
        if (storage === "file")
          expect(readPreparedBodySalaryRange(borrowed!)).toBeNull();
        expect(readPreparedSavedJobIdentity(borrowed!)).toEqual(identity);
        expect(get).not.toHaveBeenCalled();
      } finally {
        get.mockRestore();
      }
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
      ).toEqual(new Map([[job.id, { ...fingerprint, identity }]]));
      if (temp) {
        await repo.close();
        repo = await temp.createRepository();
        const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        try {
          expect(
            await repo.readSavedJobDiscoveryFingerprints([job.id, "missing"]),
          ).toEqual(new Map([[job.id, { ...fingerprint, identity }]]));
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
      expect(readPreparedSavedJobIdentity(changed)).toBeNull();
      await repo.commitSavedJobDelta({ upserts: [changed] });
      expect(await repo.readSavedJobDiscoveryFingerprints([job.id])).toEqual(
        new Map(),
      );
      // A caller must not smuggle an unchecked saved identity through the
      // structurally compatible batch value used as listing fingerprints.
      const rerouted = createSavedJob({
        id: job.id,
        sourceJobId: "another-source-job",
      });
      const unverified = { ...fingerprint, identity };
      writeDiscoveryPreparation(rerouted, {
        fingerprints: {
          owner: rerouted,
          value: unverified,
        },
      });
      Object.freeze(rerouted);
      await repo.commitSavedJobDelta({ upserts: [rerouted] });
      expect(
        (await repo.readSavedJobDiscoveryFingerprints([job.id])).get(job.id),
      ).toEqual(fingerprint);
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

test("saved identity invalidates on route, alternate sighting, content or date edits", () => {
  const job = createSavedJob();
  writeDiscoveryPreparation(job, {
    savedIdentity: {
      basis: captureDiscoverySavedIdentityBasis(job),
      value: identity,
    },
  });
  expect(readPreparedSavedJobIdentity(job)).toEqual(identity);
  expect(readPreparedSavedJobIdentity({ ...job, status: "approved" })).toEqual(
    identity,
  );
  for (const changes of [
    { description: "changed" },
    { source: "another" },
    { canonicalUrl: "https://example.test/new" },
    { seniority: "senior" },
    { postedAtText: "today" },
    {
      provenance: [
        ...job.provenance,
        { ...job.provenance[0], listingUrl: "https://example.test/alternate" },
      ],
    },
  ])
    expect(readPreparedSavedJobIdentity({ ...job, ...changes })).toBeNull();
  job.title = "Changed in place";
  expect(readPreparedSavedJobIdentity(job)).toBeNull();
});

test("external row changes invalidate preparation and rollback keeps its old value", async () => {
  const temp = await createTempRepository("nestor-preparation-trigger-");
  const repo = await temp.createRepository();
  const other = new DatabaseSync(temp.filePath);
  try {
    const job = createSavedJob();
    writeDiscoveryPreparation(job, {
      fingerprints: { owner: job, value: fingerprint },
      savedIdentity: { owner: job, value: identity },
    });
    Object.freeze(job);
    await repo.commitSavedJobDelta({ upserts: [job] });
    other.exec("BEGIN");
    other
      .prepare(
        "UPDATE saved_jobs SET value = json_set(value, '$.title', 'Changed') WHERE id = ?",
      )
      .run(job.id);
    other.exec("ROLLBACK");
    expect(
      (await repo.readSavedJobDiscoveryFingerprints([job.id])).get(job.id)
        ?.identity,
    ).toEqual(identity);
    other
      .prepare(
        "UPDATE saved_jobs SET value = json_set(value, '$.title', 'Changed') WHERE id = ?",
      )
      .run(job.id);
    expect(await repo.readSavedJobDiscoveryFingerprints([job.id])).toEqual(
      new Map(),
    );
  } finally {
    other.close();
    await repo.close();
    await temp.cleanup();
  }
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
