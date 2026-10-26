import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PreparedApplicationFormStore } from "@nestor/browser-runtime";
import type { JobFinderRepository } from "@nestor/db";
import { createPreparedFormsStore, type JobStore } from "@nestor/db/job-store";
import type { CandidateAssetLibrary } from "./candidate-asset-library";

/**
 * Filled forms Apply left for the person, kept in the job store so a page a
 * restart closed can be filled again. Each attached file is read back only
 * if its bytes still match what was attached.
 */
export function createPreparedApplicationFormStore(
  store: JobStore,
  repository: Pick<JobFinderRepository, "getProfile">,
  assets: Pick<CandidateAssetLibrary, "resolveForApplication">,
): PreparedApplicationFormStore {
  const forms = createPreparedFormsStore(store);
  return {
    get: (key) => Promise.resolve(forms.get(key)),
    save: (form) => Promise.resolve(forms.save(form)),
    delete: (key) => Promise.resolve(forms.delete(key)),
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
        // Applications attach their resume from the job store, never an
        // old export.
        throw new Error("Resume unavailable");
      }
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error("Attachment changed");
      return bytes;
    },
  };
}
