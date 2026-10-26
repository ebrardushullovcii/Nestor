import {
  SourceDebugEvidenceRefSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  type SourceDebugEvidenceRef,
  type SourceDebugRunRecord,
  type SourceDebugWorkerAttempt,
} from "@nestor/contracts";

import type { JobFinderRepository } from "../repository-types";
import { createActivityControlStore } from "./activity-control";
import type { JobStore } from "./job-store";
import { createProfileWorkspace } from "./profile-workspace";
import { createSiteInstructionsStore } from "./site-instructions";

/**
 * Job Finder's profile work over the job store. A site check keeps its runs,
 * attempts and evidence only while the app runs; what it learned is saved as
 * site instructions.
 */
export function createJobFinderRepository(
  store: JobStore,
): JobFinderRepository {
  const profile = createProfileWorkspace(store);
  const instructions = createSiteInstructionsStore(store);
  const activity = createActivityControlStore(store);
  const runs = new Map<string, SourceDebugRunRecord>();
  const attempts = new Map<string, SourceDebugWorkerAttempt>();
  const evidence = new Map<string, SourceDebugEvidenceRef>();
  const listed = <T>(values: Map<string, T>) =>
    Promise.resolve(structuredClone([...values.values()]));
  return {
    ...profile.methods,
    listSourceInstructionArtifacts: () =>
      Promise.resolve().then(() => instructions.list()),
    upsertSourceInstructionArtifact: (artifact) =>
      Promise.resolve().then(() => instructions.upsert(artifact)),
    deleteSourceInstructionArtifactsForTarget: (targetId) =>
      Promise.resolve().then(() => instructions.deleteForSite(targetId)),
    getActivityControl: () => Promise.resolve().then(() => activity.read()),
    saveActivityControl: (control) =>
      Promise.resolve().then(() => activity.save(control)),
    listSourceDebugRuns: () => listed(runs),
    upsertSourceDebugRun: (run) =>
      Promise.resolve().then(() => {
        const value = SourceDebugRunRecordSchema.parse(structuredClone(run));
        runs.set(value.id, value);
      }),
    listSourceDebugAttempts: () => listed(attempts),
    upsertSourceDebugAttempt: (attempt) =>
      Promise.resolve().then(() => {
        const value = SourceDebugWorkerAttemptSchema.parse(
          structuredClone(attempt),
        );
        attempts.set(value.id, value);
      }),
    listSourceDebugEvidenceRefs: () => listed(evidence),
    upsertSourceDebugEvidenceRef: (ref) =>
      Promise.resolve().then(() => {
        const value = SourceDebugEvidenceRefSchema.parse(structuredClone(ref));
        evidence.set(value.id, value);
      }),
    upsertSourceDebugEvidenceRefs: (refs) =>
      Promise.resolve().then(() => {
        for (const ref of SourceDebugEvidenceRefSchema.array().parse(
          structuredClone([...refs]),
        ))
          evidence.set(ref.id, ref);
      }),
  };
}
