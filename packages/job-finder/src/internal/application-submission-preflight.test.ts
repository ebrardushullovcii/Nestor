import { createHash } from "node:crypto";

import {
  SubmissionIdempotencyRecordSchema,
  SubmissionPreflightRecordSchema,
  type SubmissionPreflightRecord,
} from "@nestor/contracts";
import type { SubmissionPreflightCommitResult } from "@nestor/db";
import { describe, expect, test } from "vitest";

import {
  buildSubmissionPreflightRecord,
  commitSubmissionPreflight,
  type CreateSubmissionPreflightInput,
  type SubmissionPreflightCoordinatorRepository,
} from "./application-submission-preflight";

const NOW = "2026-08-28T10:00:00.000Z";
const RESUME_BYTES = new Uint8Array([11, 22, 33, 44, 55]);
const RESUME_SHA256 = createHash("sha256").update(RESUME_BYTES).digest("hex");
const ANSWER_DIGEST = "b".repeat(64);
const POLICY_DIGEST = "c".repeat(64);
const OBSERVATION_DIGEST = "d".repeat(64);
const CONTROL_DIGEST = "e".repeat(64);

const BASE_INPUT: Omit<CreateSubmissionPreflightInput, "repository"> = {
  id: "preflight_1",
  idempotencyKey: "submission_once_1",
  lineage: {
    runId: "run_1",
    jobId: "job_1",
    resultId: "result_1",
    applicationRecordId: "application_1",
    campaignId: "campaign_1",
  },
  authorityEnvelopeId: "authority_1",
  authorityRevision: 3,
  decisionPolicy: {
    version: 1,
    revision: 4,
    digest: POLICY_DIGEST,
  },
  origin: "HTTPS://JOBS.EXAMPLE.COM:443/apply?source=job-finder#form",
  formObservation: {
    id: "observation_1",
    revision: 8,
    digest: OBSERVATION_DIGEST,
  },
  resumeBytes: RESUME_BYTES,
  answers: { revision: 2, digest: ANSWER_DIGEST },
  finalControl: { signature: CONTROL_DIGEST, ref: "final-control-0" },
  capacity: { remainingRunCapacity: 2, remainingDailyCapacity: 7 },
  createdAt: NOW,
};

function createInput(
  overrides: Partial<Omit<CreateSubmissionPreflightInput, "repository">> = {},
): Omit<CreateSubmissionPreflightInput, "repository"> {
  return { ...BASE_INPUT, ...overrides };
}

function createIdempotencyRecord(preflight: SubmissionPreflightRecord) {
  return SubmissionIdempotencyRecordSchema.parse({
    id: `submission_idempotency_${preflight.id}`,
    idempotencyKey: preflight.idempotencyKey,
    preflightId: preflight.id,
    authorityEnvelopeId: preflight.authorityEnvelopeId,
    authorityRevision: preflight.authorityRevision,
    runId: preflight.runId,
    jobId: preflight.jobId,
    resultId: preflight.resultId,
    applicationRecordId: preflight.applicationRecordId,
    status: "available",
    revision: 1,
    createdAt: preflight.createdAt,
    updatedAt: preflight.createdAt,
    armedAt: null,
    outcomeId: null,
    outcome: null,
    revokedAt: null,
  });
}

function createRecordingRepository(
  result: (
    preflight: SubmissionPreflightRecord,
  ) => SubmissionPreflightCommitResult,
): {
  repository: SubmissionPreflightCoordinatorRepository;
  received: SubmissionPreflightRecord[];
} {
  const received: SubmissionPreflightRecord[] = [];
  const repository: SubmissionPreflightCoordinatorRepository = {
    commitSubmissionPreflight: (preflight) => {
      received.push(preflight);
      return Promise.resolve(result(preflight));
    },
  };
  return { repository, received };
}

describe("application submission preflight coordinator", () => {
  test("derives the resume digest from a byte snapshot and deep-freezes the record", () => {
    const bytes = new Uint8Array(RESUME_BYTES);
    const record = buildSubmissionPreflightRecord(
      createInput({ resumeBytes: bytes }),
    );

    bytes[0] = 255;

    expect(record.resumeSha256).toBe(RESUME_SHA256);
    expect(record.origin).toBe("https://jobs.example.com");
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.answers)).toBe(true);
    expect(Object.isFrozen(record.formObservation)).toBe(true);
    expect(Object.isFrozen(record.finalControl)).toBe(true);
  });

  test("commits the exact schema-valid payload and preserves created truth", async () => {
    const { repository, received } = createRecordingRepository((preflight) => ({
      status: "created",
      preflight,
      idempotency: createIdempotencyRecord(preflight),
    }));

    const result = await commitSubmissionPreflight({
      ...createInput(),
      repository,
    });

    expect(result.status).toBe("created");
    const [record] = received;
    expect(record).toBeDefined();
    if (!record) return;

    expect(record).toMatchObject({
      id: "preflight_1",
      idempotencyKey: "submission_once_1",
      runId: "run_1",
      jobId: "job_1",
      resultId: "result_1",
      applicationRecordId: "application_1",
      campaignId: "campaign_1",
      origin: "https://jobs.example.com",
      authorityEnvelopeId: "authority_1",
      authorityRevision: 3,
      resumeSha256: RESUME_SHA256,
      remainingRunCapacityBefore: 2,
      remainingDailyCapacityBefore: 7,
    });
    expect(SubmissionPreflightRecordSchema.safeParse(record).success).toBe(
      true,
    );
  });

  test("passes duplicate and conflict outcomes through without reinterpretation", async () => {
    const duplicateRepository = createRecordingRepository((preflight) => ({
      status: "duplicate",
      preflight,
      idempotency: createIdempotencyRecord(preflight),
    }));
    const duplicate = await commitSubmissionPreflight({
      ...createInput(),
      repository: duplicateRepository.repository,
    });
    expect(duplicate.status).toBe("duplicate");

    const conflictRepository = createRecordingRepository((preflight) => ({
      status: "conflict",
      current: preflight,
    }));
    const conflict = await commitSubmissionPreflight({
      ...createInput(),
      repository: conflictRepository.repository,
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") {
      expect(conflict.current?.idempotencyKey).toBe("submission_once_1");
    }
  });

  test.each([
    "not-a-url",
    "ftp://jobs.example.com/apply",
    "file:///tmp/application",
    "https://user:password@jobs.example.com/apply",
    "https://jobs.example.com:bad-port/apply",
  ])("rejects an unsafe origin: %s", (origin) => {
    expect(() =>
      buildSubmissionPreflightRecord(createInput({ origin })),
    ).toThrow();
  });

  test("rejects non-byte resume input before persistence", () => {
    expect(() =>
      buildSubmissionPreflightRecord(
        createInput({
          resumeBytes: "forged-digest-input" as unknown as Uint8Array,
        }),
      ),
    ).toThrow("resumeBytes must be a Uint8Array");
  });

  test("rejects invalid capacity, lineage, and identity facts through schemas", () => {
    expect(() =>
      buildSubmissionPreflightRecord(
        createInput({
          capacity: { remainingRunCapacity: -1, remainingDailyCapacity: 1 },
        }),
      ),
    ).toThrow();
    expect(() =>
      buildSubmissionPreflightRecord(
        createInput({
          capacity: { remainingRunCapacity: 1.5, remainingDailyCapacity: 1 },
        }),
      ),
    ).toThrow();
    expect(() =>
      buildSubmissionPreflightRecord(
        createInput({
          lineage: { ...BASE_INPUT.lineage, runId: "" },
        }),
      ),
    ).toThrow();
    expect(() =>
      buildSubmissionPreflightRecord(
        createInput({
          answers: { revision: 0, digest: ANSWER_DIGEST },
        }),
      ),
    ).toThrow();
    expect(() =>
      buildSubmissionPreflightRecord(
        createInput({
          formObservation: {
            ...BASE_INPUT.formObservation,
            digest: "not-a-sha256",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      buildSubmissionPreflightRecord(
        createInput({
          finalControl: { signature: "bad", ref: "final-control-0" },
        }),
      ),
    ).toThrow();
  });
});
