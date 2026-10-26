import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EditableSourceInstructionArtifact,
  ProfileSetupReviewActionOptions,
  ProfileSetupState,
  ProfileWorkflowCommand,
  ProfileWorkflowResult,
  ProfileWorkflowState,
  ResumeImportProgressEvent,
  ResumeTimelineRepairAction,
  SourceInstructionArtifact,
} from "@nestor/contracts";
import { describeFailure } from "@renderer/features/job-finder/lib/describe-failure";

type PendingKey =
  | "import"
  | "analyze"
  | "setup"
  | `review:${string}`
  | `site:${string}`
  | `instruction:${string}`;

const REVIEW_ACTION_MESSAGES = {
  confirm: "Imported suggestion confirmed.",
  dismiss: "Review item dismissed for now.",
  clear_value: "Current value cleared and the review item was resolved.",
} as const;

/**
 * Guided setup, resume import and site checks for Profile and setup. Reads
 * the small setup and import state from the store, follows later changes,
 * and reports each step's outcome as one sentence.
 */
export function useProfileWorkflow(
  options: { siteInstructions?: boolean } = {},
) {
  const [state, setState] = useState<ProfileWorkflowState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<PendingKey>>(new Set());
  const [importProgress, setImportProgress] =
    useState<ResumeImportProgressEvent | null>(null);
  const [siteInstructions, setSiteInstructions] = useState<
    readonly SourceInstructionArtifact[]
  >([]);
  const live = useRef(true);
  const reads = useRef(0);

  const apply = useCallback((result: ProfileWorkflowResult) => {
    if (!live.current) return;
    setState(result.state);
    if (result.siteInstructions) setSiteInstructions(result.siteInstructions);
  }, []);

  const refresh = useCallback(async () => {
    const read = ++reads.current;
    try {
      const result = await window.nestor.profileWorkflow.run({ type: "read" });
      if (read === reads.current) apply(result);
      if (live.current) setError(null);
    } catch (reason: unknown) {
      if (live.current && read === reads.current)
        setError(
          describeFailure(reason, { action: "load your setup" }).userMessage,
        );
    }
  }, [apply]);

  useEffect(() => {
    live.current = true;
    void refresh();
    const off = window.nestor.jobs.onChange((change) => {
      if (change.cause === "profile" || change.cause === "profile_activity")
        void refresh();
    });
    return () => {
      live.current = false;
      reads.current++;
      off();
    };
  }, [refresh]);

  const wantsInstructions = options.siteInstructions === true;
  useEffect(() => {
    if (!wantsInstructions) return;
    void window.nestor.profileWorkflow
      .run({ type: "list_site_instructions" })
      .then(apply, () => undefined);
  }, [apply, wantsInstructions]);

  /** Runs one step; resolves to its result, or null when it failed. */
  const run = useCallback(
    async (
      key: PendingKey,
      step: () => Promise<ProfileWorkflowResult>,
      describe: {
        action: string;
        done?: (result: ProfileWorkflowResult) => string | null;
      },
    ): Promise<ProfileWorkflowResult | null> => {
      setPending((current) => new Set(current).add(key));
      try {
        // A step that finishes reads its own fresh state; a read started
        // before it must not land after it.
        reads.current++;
        const result = await step();
        apply(result);
        if (live.current)
          setMessage(describe.done ? describe.done(result) : result.message);
        return result;
      } catch (reason: unknown) {
        if (live.current)
          setMessage(
            describeFailure(reason, { action: describe.action }).userMessage,
          );
        return null;
      } finally {
        if (live.current)
          setPending((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
      }
    },
    [apply],
  );

  const command = (input: ProfileWorkflowCommand) => () =>
    window.nestor.profileWorkflow.run(input);

  return {
    state,
    error,
    message,
    setMessage,
    importProgress,
    siteInstructions,
    refresh,
    isPending: (key: PendingKey) => pending.has(key),
    importResume: (importOptions?: { retryInterrupted?: boolean }) =>
      run(
        "import",
        async () => {
          setImportProgress(null);
          try {
            return await window.nestor.profileWorkflow.importResume(
              (progress) => {
                if (live.current) setImportProgress(progress);
              },
              importOptions,
            );
          } finally {
            if (live.current) setImportProgress(null);
          }
        },
        { action: "import your resume" },
      ),
    cancelImportResume: (stopProcessing?: boolean) =>
      window.nestor.profileWorkflow.cancelImportResume(stopProcessing),
    analyzeResume: () =>
      run("analyze", command({ type: "analyze_resume" }), {
        action: "read your resume again",
      }),
    applyReviewAction: (
      reviewItemId: string,
      action: "confirm" | "dismiss" | "clear_value",
      actionOptions?: ProfileSetupReviewActionOptions,
    ) =>
      run(
        `review:${reviewItemId}`,
        command({
          type: "apply_review_action",
          input: {
            reviewItemId,
            action,
            ...(actionOptions ? { options: actionOptions } : {}),
          },
        }),
        {
          action: "update this suggestion",
          done: () =>
            action === "confirm" && actionOptions?.selectedConflictChoiceId
              ? "Imported comparison choice confirmed."
              : REVIEW_ACTION_MESSAGES[action],
        },
      ),
    applyTimelineRepair: async (
      runId: string,
      proposalId: string,
      action: ResumeTimelineRepairAction,
    ) => {
      await run(
        "setup",
        command({
          type: "apply_timeline_repair",
          input: { runId, proposalId, action },
        }),
        { action: "update your work history dates" },
      );
    },
    saveSetupState: (setupState: ProfileSetupState) =>
      run("setup", command({ type: "save_setup_state", state: setupState }), {
        action: "save your setup progress",
      }),
    checkSite: (targetId: string) =>
      run(
        `site:${targetId}`,
        () =>
          window.nestor.profileWorkflow.checkSite(targetId, (progress) => {
            if (live.current) setMessage(progress.message);
          }),
        { action: "check this source" },
      ),
    saveSiteInstructions: (
      targetId: string,
      artifact: EditableSourceInstructionArtifact,
    ) =>
      run(
        `instruction:${targetId}`,
        command({
          type: "save_site_instructions",
          input: { targetId, artifact },
        }),
        { action: "save this guidance", done: () => "Saved guidance updated." },
      ),
  };
}

export type ProfileWorkflow = ReturnType<typeof useProfileWorkflow>;
