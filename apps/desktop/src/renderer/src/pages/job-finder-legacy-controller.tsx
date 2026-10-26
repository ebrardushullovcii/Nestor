import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { useModalFocusTrap } from "@renderer/features/job-finder/components/profile/use-modal-focus-trap";
import { SourceCheckQueueRunner } from "@renderer/features/job-finder/lib/source-check-queue-runner";
import { JobFinderUnsavedChangesDialog } from "./job-finder-unsaved-changes-dialog";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import type { JobFinderPageContext } from "./job-finder-page-context";
import { publishLegacyControllerView } from "./legacy-controller-view";
import {
  type ApplyCopilotVisualCheckpointRequest,
  useJobFinderPageController,
} from "./use-job-finder-page-controller";

/**
 * The old whole-workspace controller, loaded as its own chunk once a screen
 * asks for the old workspace. It publishes what the page and shell read, and
 * renders the dialogs and the source-check runner it owns.
 */
export const JobFinderLegacyController = memo(
  function JobFinderLegacyController() {
    const {
      appearanceTheme,
      applyCopilotVisualCheckpointRequest,
      cancelApplyCopilotVisualCheckpointRequest,
      context,
      dismissSavedStatus,
      navigateFromShell,
      platform,
      resolveUnsavedChangesLeave,
      resolveUnsavedChangesStay,
      retryLastSave,
      saveState,
      resolveApplyCopilotVisualCheckpointRequest,
      unsavedChangesConfirmation,
      workspace,
      workspaceState,
    } = useJobFinderPageController(true);

    useLayoutEffect(() => {
      publishLegacyControllerView({
        appearanceTheme,
        context,
        dismissSavedStatus,
        navigateFromShell,
        platform,
        retryLastSave,
        saveState,
        workspace,
        workspaceState,
      });
    }, [
      appearanceTheme,
      context,
      dismissSavedStatus,
      navigateFromShell,
      platform,
      retryLastSave,
      saveState,
      workspace,
      workspaceState,
    ]);

    const latestContext = useRef(context);
    useLayoutEffect(() => {
      latestContext.current = context;
    }, [context]);
    const isSourceDebugPending = useCallback(
      (targetId: string) =>
        latestContext.current?.isPending(
          jobFinderPendingActions.sourceDebug(targetId),
        ) ?? false,
      [],
    );
    const onRunSourceDebug = useCallback<
      JobFinderPageContext["onRunSourceDebug"]
    >((...args) => latestContext.current?.onRunSourceDebug(...args), []);

    return (
      <>
        {workspace ? (
          <MemoizedSourceCheckQueueRunner
            isSourceDebugPending={isSourceDebugPending}
            onRunSourceDebug={onRunSourceDebug}
            recentSourceDebugRuns={workspace.recentSourceDebugRuns}
          />
        ) : null}
        <ApplyCopilotVisualCheckpointDialog
          onClose={cancelApplyCopilotVisualCheckpointRequest}
          onResolve={resolveApplyCopilotVisualCheckpointRequest}
          request={applyCopilotVisualCheckpointRequest}
        />
        <JobFinderUnsavedChangesDialog
          confirmation={unsavedChangesConfirmation}
          onLeaveWithoutSaving={resolveUnsavedChangesLeave}
          onStay={resolveUnsavedChangesStay}
        />
      </>
    );
  },
);

const MemoizedSourceCheckQueueRunner = memo(SourceCheckQueueRunner);

/**
 * The gate that runs before Job Finder opens a browser at a real employer's
 * application page. It used to be titled "Use visual checkpoints?" — a
 * sub-option — and both of its buttons proceeded, so the only way out was an
 * unlabelled header X. It is now framed around the commitment itself: it names
 * the job and employer, says a Job Finder browser window will open, states the
 * never-submits boundary as its own line, and offers a real Cancel.
 *
 * Visual checkpoints became an optional, unchecked checkbox rather than a fork,
 * so the safety property is unchanged and stronger: confirming without touching
 * anything resolves with checkpoints off, exactly as "Continue without" did, and
 * Escape, the scrim, Cancel and the header X all resolve through onClose, which
 * cancels the request. Nothing here submits an application.
 */
export function ApplyCopilotVisualCheckpointDialog(props: {
  onClose: () => void;
  /**
   * Returns a refusal sentence when the start could not begin. The dialog then
   * stays open and says so: pressing "Apply" and watching the
   * dialog close with nothing else happening is the defect this return value
   * exists to prevent.
   */
  onResolve: (
    visualCheckpointsEnabled: boolean,
  ) => string | null | void | Promise<string | null | void>;
  request: ApplyCopilotVisualCheckpointRequest | null;
}) {
  const dialogTitleId = useId();
  const descriptionId = useId();
  const boundaryId = useId();
  const checkpointsId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const [visualCheckpointsEnabled, setVisualCheckpointsEnabled] =
    useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const open = props.request !== null;
  useModalFocusTrap(open, dialogRef, props.onClose);

  // Every open starts from the privacy-preserving default; consent is per run
  // and is never carried over from a previous preparation.
  useEffect(() => {
    if (open) {
      setVisualCheckpointsEnabled(false);
      setRefusal(null);
      setStarting(false);
    }
  }, [open, props.request]);

  // Declared after the shared trap so it runs second on open. Confirming
  // resolves with checkpoints off unless the user ticks the box, so initial
  // focus on the confirm action cannot enable screenshot sharing by accident.
  useEffect(() => {
    if (!open) {
      return;
    }
    confirmRef.current?.focus();
  }, [open]);

  if (!open) {
    return null;
  }

  // Identity and the honest statement of what will happen both come from the
  // request, so this shell renders whatever the caller supplies rather than
  // owning that copy.
  const jobIdentityLine = (props.request?.subject ?? "").trim() || null;
  const commitmentDescription = (props.request?.description ?? "").trim();
  // Safety backstop, not copy ownership: the caller's description carries the
  // never-submits boundary, and this shell states it itself if that sentence
  // is ever missing, so the gate can never appear without it.
  const describesSubmitBoundary = /submit|sending the application/i.test(
    commitmentDescription,
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-(--modal-scrim) px-4 py-6 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        aria-describedby={
          describesSubmitBoundary
            ? descriptionId
            : `${descriptionId} ${boundaryId}`
        }
        aria-labelledby={dialogTitleId}
        aria-modal="true"
        className="surface-panel-shell grid max-h-[calc(100dvh-3rem)] w-full max-w-lg gap-5 overflow-y-auto rounded-(--radius-field) border border-(--surface-panel-border) p-5 shadow-(--modal-shadow)"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-2">
            <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
              Apply
            </p>
            {/* The heading is the identity: which application this gate is
                actually about. Group 6 supplies the subject line. */}
            <h2
              className="text-(--text-headline)"
              data-apply-checkpoint-dialog-job
              id={dialogTitleId}
            >
              {jobIdentityLine ?? "Prepare this application"}
            </h2>
          </div>
          {/* One close-affordance shape across every Job Finder dialog. */}
          <Button
            aria-label="Close"
            className="shrink-0"
            onClick={props.onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <div className="grid gap-3">
          <p
            className="text-(length:--text-item) leading-6 text-foreground-soft"
            id={descriptionId}
          >
            {commitmentDescription}
          </p>
          {describesSubmitBoundary ? null : (
            <p
              className="rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) px-3 py-2 text-(length:--text-item) font-medium leading-6 text-foreground"
              data-apply-checkpoint-dialog-boundary
              id={boundaryId}
            >
              Job Finder never submits the application. You review everything
              and send it yourself.
            </p>
          )}
        </div>
        {/* Checkpoints are an option on this commitment, not a second way to
            confirm it. Unchecked by default; confirming without touching it
            behaves exactly as the old "Continue without" choice. */}
        <label
          className="flex items-start gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-3"
          htmlFor={checkpointsId}
        >
          <input
            checked={visualCheckpointsEnabled}
            className="mt-1 size-4 shrink-0 accent-(--primary)"
            id={checkpointsId}
            onChange={(event) =>
              setVisualCheckpointsEnabled(event.target.checked)
            }
            type="checkbox"
          />
          <span className="grid gap-1">
            <span className="text-(length:--text-item) font-medium text-foreground">
              Take temporary screenshots while it works
            </span>
            <span className="text-(length:--text-small) leading-5 text-foreground-soft">
              Optional. Screenshots of the application page help Job Finder
              notice a stuck or misfilled form, and are deleted after the run.
            </span>
          </span>
        </label>
        {refusal ? (
          <p
            className="rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-item) leading-6 text-foreground"
            data-apply-checkpoint-dialog-refusal
            role="alert"
          >
            {refusal}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <Button onClick={props.onClose} type="button" variant="secondary">
            {refusal ? "Close" : "Cancel"}
          </Button>
          {refusal ? null : (
            <Button
              disabled={starting}
              onClick={() => {
                setStarting(true);
                void Promise.resolve(
                  props.onResolve(visualCheckpointsEnabled),
                ).then(
                  (message) => {
                    const sentence =
                      typeof message === "string" ? message.trim() : "";
                    setStarting(false);
                    if (sentence) {
                      setRefusal(sentence);
                    }
                  },
                  () => {
                    setStarting(false);
                    setRefusal(
                      "Job Finder could not start this preparation. Nothing was opened and nothing was sent.",
                    );
                  },
                );
              }}
              pending={starting}
              ref={confirmRef}
              type="button"
              variant="primary"
            >
              Apply
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
