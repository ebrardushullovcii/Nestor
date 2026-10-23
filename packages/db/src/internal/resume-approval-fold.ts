import type { DatabaseSync } from "node:sqlite";
import type { ResumeDraft, TailoredAsset } from "@nestor/contracts";
import { runImmediateTransaction } from "../file-repository-support";
import {
  resumeDraftValueSql,
  tailoredAssetValueSql,
} from "./resume-approval-state";

export type ResumeStateFold =
  | {
      table: "resume_drafts";
      id: string;
      patch: Pick<
        ResumeDraft,
        | "status"
        | "staleReason"
        | "approvedAt"
        | "approvedExportId"
        | "updatedAt"
      >;
    }
  | {
      table: "tailored_assets";
      id: string;
      patch: Pick<TailoredAsset, "storagePath" | "updatedAt">;
    };

/** Fold approval metadata without parsing or replacing cached document bodies. */
export function createResumeApprovalFolder(
  database: DatabaseSync,
  prepareDisplayFold: (fold: ResumeStateFold) => () => void = () => () => {},
  draftHasApproval: (id: string) => boolean | undefined = () => undefined,
) {
  const nextDraft = database.prepare(
    "SELECT draft_id, stale_reason, updated_at FROM resume_draft_approval_state LIMIT 1",
  );
  const nextAsset = database.prepare(
    "SELECT asset_id, updated_at FROM tailored_asset_file_state LIMIT 1",
  );
  const writeDraft = database.prepare(`UPDATE resume_drafts SET
    value = ${resumeDraftValueSql}, updated_at = ? WHERE id = ?`);
  const writeAsset = database.prepare(`UPDATE tailored_assets SET
    value = ${tailoredAssetValueSql} WHERE id = ?`);
  const pendingDrafts = database.prepare(
    "SELECT draft_id, stale_reason, updated_at FROM resume_draft_approval_state",
  );
  const readDraftApproval = database.prepare(`SELECT
    json_extract(value, '$.status') = 'approved'
      OR json_extract(value, '$.approvedAt') IS NOT NULL
      OR json_extract(value, '$.approvedExportId') IS NOT NULL AS approved
    FROM resume_drafts WHERE id = ?`);
  const changedAssets = database.prepare(`SELECT a.asset_id, a.updated_at
    FROM tailored_asset_file_state a JOIN tailored_assets t ON t.id = a.asset_id
    WHERE json_extract(t.value, '$.storagePath') IS NOT NULL`);
  let running: Promise<void> | null = null;
  let failure: Error | null = null;

  function foldOne(): boolean {
    let publish = () => {};
    const folded = runImmediateTransaction(database, () => {
      const draft = nextDraft.get();
      if (draft) {
        const id = String(draft.draft_id);
        publish = prepareDisplayFold({
          table: "resume_drafts",
          id,
          patch: {
            status: "stale",
            staleReason: String(draft.stale_reason),
            approvedAt: null,
            approvedExportId: null,
            updatedAt: String(draft.updated_at),
          },
        });
        writeDraft.run(draft.updated_at!, id);
        return true;
      }
      const asset = nextAsset.get();
      if (!asset) return false;
      const id = String(asset.asset_id);
      publish = prepareDisplayFold({
        table: "tailored_assets",
        id,
        patch: { storagePath: null, updatedAt: String(asset.updated_at) },
      });
      writeAsset.run(id);
      return true;
    });
    // Only publish after COMMIT: failed writes must leave cached bodies alone.
    if (folded) publish();
    return folded;
  }

  function schedule(): void {
    if (running) return;
    failure = null;
    running = (async () => {
      // One row per turn bounds the slice even for unusually large documents.
      // Start on the next turn so the profile save can acknowledge its commit.
      await new Promise<void>((resolve) => setImmediate(resolve));
      while (foldOne()) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })()
      .catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error));
        console.warn(
          "[JobFinderRepository] Resume approval fold failed.",
          error,
        );
      })
      .finally(() => {
        running = null;
      });
  }

  return {
    schedule,
    /** Run inside the Profile transaction; publish caches only after its commit. */
    foldApprovalChanges(this: void): () => void {
      const publish: (() => void)[] = [];
      for (const draft of pendingDrafts.all()) {
        const id = String(draft.draft_id);
        const approved =
          draftHasApproval(id) ??
          Number(readDraftApproval.get(id)?.approved) === 1;
        if (!approved) continue;
        publish.push(
          prepareDisplayFold({
            table: "resume_drafts",
            id,
            patch: {
              status: "stale",
              staleReason: String(draft.stale_reason),
              approvedAt: null,
              approvedExportId: null,
              updatedAt: String(draft.updated_at),
            },
          }),
        );
        writeDraft.run(draft.updated_at!, id);
      }
      for (const asset of changedAssets.all()) {
        const id = String(asset.asset_id);
        publish.push(
          prepareDisplayFold({
            table: "tailored_assets",
            id,
            patch: { storagePath: null, updatedAt: String(asset.updated_at) },
          }),
        );
        writeAsset.run(id);
      }
      return () => {
        for (const apply of publish) apply();
      };
    },
    async flush(): Promise<void> {
      schedule();
      await running;
      if (failure) throw failure;
    },
  };
}
