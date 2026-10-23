import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  BrowserSessionRuntime,
  PreparedApplicationFormStore,
} from "@nestor/browser-runtime";
import type {
  ApplicationPageReopenProgress,
  ApplicationPageState,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import type { CandidateAssetLibrary } from "./candidate-asset-library";

export function createPreparedApplicationFormStore(
  repository: JobFinderRepository,
  assets: Pick<CandidateAssetLibrary, "resolveForApplication">,
): PreparedApplicationFormStore {
  return {
    get: (key) => repository.getPreparedApplicationForm(key),
    save: (form) => repository.upsertPreparedApplicationForm(form),
    delete: (key) => repository.deletePreparedApplicationForm(key),
    async loadAttachment(file) {
      let bytes: Uint8Array;
      if (file.kind === "candidate_asset") {
        const resolved = await assets.resolveForApplication(file.id);
        if (resolved.asset.sha256 !== file.sha256)
          throw new Error("Attachment changed");
        bytes = await resolved.loadVerifiedBytes();
      } else if (file.kind === "resume_source") {
        const profile = await repository.getProfile();
        if (
          profile.baseResume?.id !== file.id ||
          !profile.baseResume.storagePath ||
          profile.baseResume.sha256 !== file.sha256
        )
          throw new Error("Resume unavailable");
        bytes = await readFile(profile.baseResume.storagePath);
      } else {
        const exports = await repository.listResumeExportArtifacts();
        const artifact = exports.find((candidate) => candidate.id === file.id);
        if (!artifact || artifact.sha256 !== file.sha256)
          throw new Error("Resume unavailable");
        bytes = await readFile(artifact.filePath);
      }
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error("Attachment changed");
      return bytes;
    },
  };
}

/** Read-only availability checks never recreate a page or run preparation. */
export function createApplicationPageAccess(
  repository: JobFinderRepository,
  runtime: BrowserSessionRuntime,
) {
  async function target(resultId: string) {
    const [result] = await repository.listApplyJobResults({ id: resultId });
    if (
      !result ||
      !["awaiting_review", "blocked"].includes(result.state) ||
      result.blockerReason === "submission_outcome_uncertain" ||
      result.privacyReceipt?.finalSubmitOccurred ||
      ["submitted", "outcome_uncertain"].includes(
        result.privacyReceipt?.submissionOutcome?.outcome ?? "",
      )
    )
      return null;
    const [job] = await repository.listSavedJobsByIds([result.jobId]);
    if (!job || job.status === "archived") return null;
    return job;
  }
  const unavailable = async (
    resultId: string,
  ): Promise<ApplicationPageState> => {
    const saved = await repository.getPreparedApplicationForm(resultId);
    return {
      resultId,
      state: "needs_preparing",
      reason: saved?.reason ?? "application_finished",
    };
  };
  return {
    async getStates(
      resultIds: readonly string[],
    ): Promise<ApplicationPageState[]> {
      return Promise.all(
        resultIds.map(async (resultId) => {
          const job = await target(resultId);
          return job && runtime.getApplicationPageState
            ? runtime.getApplicationPageState(job.source, resultId)
            : unavailable(resultId);
        }),
      );
    },
    async reopen(
      resultId: string,
      onProgress: (progress: ApplicationPageReopenProgress) => void,
    ): Promise<ApplicationPageState> {
      const job = await target(resultId);
      if (!job || !runtime.reopenApplicationPage) {
        onProgress({ resultId, phase: "needs_preparing" });
        return unavailable(resultId);
      }
      // Deliberately no call to preparation, continuation, authority or send.
      return runtime.reopenApplicationPage(job.source, resultId, onProgress);
    },
  };
}
