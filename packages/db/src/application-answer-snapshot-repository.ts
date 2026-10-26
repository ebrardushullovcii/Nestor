import { createHash } from "node:crypto";

import {
  ApprovedApplicationAnswerSnapshotContentSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  NonEmptyStringSchema,
  serializeApprovedApplicationAnswerSnapshotForDigest,
  type ApprovedApplicationAnswerSnapshot,
} from "@nestor/contracts";

import type { SendGuardStateStore } from "./application-authority-repository";
import type { SendGuardState } from "./application-authority-repository-types";
import type {
  ApplicationAnswerSnapshotCommitResult,
  ApplicationAnswerSnapshotRepository,
  CommitApplicationAnswerSnapshotInput,
} from "./application-answer-snapshot-repository-types";


function snapshotContent(
  snapshot: ApprovedApplicationAnswerSnapshot,
): Parameters<typeof serializeApprovedApplicationAnswerSnapshotForDigest>[0] {
  return {
    schemaVersion: snapshot.schemaVersion,
    profileId: snapshot.profileId,
    entries: snapshot.entries,
  };
}

function deriveSnapshotDigest(
  snapshot: ApprovedApplicationAnswerSnapshot,
): string {
  return createHash("sha256")
    .update(
      serializeApprovedApplicationAnswerSnapshotForDigest(
        snapshotContent(snapshot),
      ),
      "utf8",
    )
    .digest("hex");
}

function verifySnapshotDigest(
  snapshot: ApprovedApplicationAnswerSnapshot,
): void {
  const expectedDigest = deriveSnapshotDigest(snapshot);
  if (snapshot.digest !== expectedDigest) {
    throw new Error(
      "Approved application answer snapshot digest does not match its canonical content.",
    );
  }
}

function compareSnapshotContent(
  left: ApprovedApplicationAnswerSnapshot,
  right: ApprovedApplicationAnswerSnapshot,
): boolean {
  return (
    serializeApprovedApplicationAnswerSnapshotForDigest(
      snapshotContent(left),
    ) ===
    serializeApprovedApplicationAnswerSnapshotForDigest(snapshotContent(right))
  );
}

function latestSnapshotForProfile(
  state: SendGuardState,
  profileId: string,
): ApprovedApplicationAnswerSnapshot | null {
  const matching = (state.applicationAnswerSnapshots ?? []).filter(
    (snapshot) => snapshot.profileId === profileId,
  );
  if (matching.length === 0) {
    return null;
  }

  // A historical row is still part of the append-only chain. Fail closed if
  // any persisted content has been tampered with, even when a newer row would
  // otherwise be available.
  for (const snapshot of matching) {
    verifySnapshotDigest(snapshot);
  }

  const ordered = [...matching].sort(
    (left, right) =>
      right.revision - left.revision || left.id.localeCompare(right.id),
  );
  const latest = ordered[0];
  if (!latest) {
    return null;
  }
  if (
    ordered.some(
      (snapshot) =>
        snapshot.revision === latest.revision && snapshot.id !== latest.id,
    )
  ) {
    throw new Error(
      "Approved application answer snapshot revisions are ambiguous for this profile.",
    );
  }
  return latest;
}

function validateExpectedLatestRevision(revision: number | null): void {
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) {
    throw new TypeError(
      "Expected latest application answer snapshot revision must be null or a positive safe integer.",
    );
  }
}

function parseSnapshotCandidate(
  input: CommitApplicationAnswerSnapshotInput,
): ApprovedApplicationAnswerSnapshot {
  validateExpectedLatestRevision(input.expectedLatestRevision);
  const snapshot = ApprovedApplicationAnswerSnapshotSchema.parse(
    structuredClone(input.snapshot),
  );
  // Re-parse the content separately so the bytes hashed here cannot include
  // lifecycle metadata or an accidental future field.
  ApprovedApplicationAnswerSnapshotContentSchema.parse(
    snapshotContent(snapshot),
  );
  verifySnapshotDigest(snapshot);
  return snapshot;
}

export function createApplicationAnswerSnapshotRepositoryMethods(
  store: SendGuardStateStore,
): ApplicationAnswerSnapshotRepository {
  return {
    async listApplicationAnswerSnapshots(options) {
      await Promise.resolve();
      const id =
        options?.id === undefined
          ? undefined
          : NonEmptyStringSchema.parse(options.id);
      const profileId =
        options?.profileId === undefined
          ? undefined
          : NonEmptyStringSchema.parse(options.profileId);
      const snapshots = [...(store.read().applicationAnswerSnapshots ?? [])]
        .filter(
          (snapshot) =>
            (id === undefined || snapshot.id === id) &&
            (profileId === undefined || snapshot.profileId === profileId),
        )
        .sort(
          (left, right) =>
            left.profileId.localeCompare(right.profileId) ||
            right.revision - left.revision ||
            left.id.localeCompare(right.id),
        );
      for (const snapshot of snapshots) {
        verifySnapshotDigest(snapshot);
      }
      return structuredClone(snapshots);
    },

    async getApplicationAnswerSnapshot(id) {
      await Promise.resolve();
      const parsedId = NonEmptyStringSchema.parse(id);
      const snapshot =
        store
          .read()
          .applicationAnswerSnapshots?.find((value) => value.id === parsedId) ??
        null;
      if (snapshot) {
        verifySnapshotDigest(snapshot);
      }
      return structuredClone(snapshot);
    },

    async getLatestApplicationAnswerSnapshot(profileId) {
      await Promise.resolve();
      const parsedProfileId = NonEmptyStringSchema.parse(profileId);
      return structuredClone(
        latestSnapshotForProfile(store.read(), parsedProfileId),
      );
    },

    async commitApplicationAnswerSnapshot(input) {
      await Promise.resolve();
      const candidate = parseSnapshotCandidate(input);
      return structuredClone(
        store.mutate((state): ApplicationAnswerSnapshotCommitResult => {
          const latest = latestSnapshotForProfile(state, candidate.profileId);
          const expectedRevision = input.expectedLatestRevision;
          const currentRevision = latest?.revision ?? null;
          if (currentRevision !== expectedRevision) {
            return { status: "stale", current: latest };
          }

          if (latest && compareSnapshotContent(latest, candidate)) {
            return { status: "duplicate", snapshot: latest };
          }

          const existingWithCandidateId =
            state.applicationAnswerSnapshots?.find(
              (snapshot) => snapshot.id === candidate.id,
            ) ?? null;
          if (existingWithCandidateId) {
            return { status: "conflict", current: existingWithCandidateId };
          }

          const nextRevision = latest === null ? 1 : latest.revision + 1;
          if (!Number.isSafeInteger(nextRevision)) {
            throw new Error(
              "Approved application answer snapshot revision exhausted the safe integer range.",
            );
          }
          // Revision is assigned from transaction-current state. The caller's
          // candidate revision is metadata, never an authority to overwrite or
          // skip an existing revision.
          const snapshot = ApprovedApplicationAnswerSnapshotSchema.parse({
            ...candidate,
            revision: nextRevision,
          });
          (state.applicationAnswerSnapshots ??= []).push(snapshot);
          return { status: "created", snapshot };
        }),
      );
    },
  };
}
