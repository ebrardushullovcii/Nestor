import type { ApprovedApplicationAnswerSnapshot } from "@nestor/contracts";

/**
 * Result of appending one approved answer snapshot revision.
 *
 * A snapshot is immutable after insertion. `duplicate` returns the current
 * latest row when its canonical content is identical; `stale` never mutates
 * the collection and returns the transaction-current latest row.
 */
export type ApplicationAnswerSnapshotCommitResult =
  | {
      status: "created";
      snapshot: ApprovedApplicationAnswerSnapshot;
    }
  | {
      status: "duplicate";
      snapshot: ApprovedApplicationAnswerSnapshot;
    }
  | {
      status: "stale";
      current: ApprovedApplicationAnswerSnapshot | null;
    }
  | {
      status: "conflict";
      current: ApprovedApplicationAnswerSnapshot;
    };

export interface CommitApplicationAnswerSnapshotInput {
  /** Candidate assembled by the trusted main-process approval boundary. */
  snapshot: ApprovedApplicationAnswerSnapshot;
  /** Latest revision observed by the caller, or null when no row existed. */
  expectedLatestRevision: number | null;
}

export interface ApplicationAnswerSnapshotQuery {
  id?: string;
  profileId?: string;
}

export interface ApplicationAnswerSnapshotRepository {
  listApplicationAnswerSnapshots(
    options?: ApplicationAnswerSnapshotQuery,
  ): Promise<readonly ApprovedApplicationAnswerSnapshot[]>;
  getApplicationAnswerSnapshot(
    id: string,
  ): Promise<ApprovedApplicationAnswerSnapshot | null>;
  getLatestApplicationAnswerSnapshot(
    profileId: string,
  ): Promise<ApprovedApplicationAnswerSnapshot | null>;
  /**
   * Verifies the candidate digest and appends only a new immutable revision.
   * The expected latest revision is checked inside the same repository
   * transaction as the insert.
   */
  commitApplicationAnswerSnapshot(
    input: CommitApplicationAnswerSnapshotInput,
  ): Promise<ApplicationAnswerSnapshotCommitResult>;
}
