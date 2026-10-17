import { useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type {
  SourceDebugRunDetails,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { ProfileSourceDebugReviewModalContent } from "./profile-source-debug-review-modal-content";
import { useModalFocusTrap } from "./use-modal-focus-trap";

export function ProfileSourceDebugReviewModal(props: {
  details: SourceDebugRunDetails | null;
  errorMessage: string | null;
  isSourceDebugPending: boolean;
  isVerifyPending: (instructionId: string) => boolean;
  loading: boolean;
  onClose: () => void;
  onLoadRun: (runId: string) => void;
  onRerun: () => void;
  onVerify: (instructionId: string) => void;
  open: boolean;
  recentRuns: readonly SourceDebugRunRecord[];
  selectedRunId: string | null;
  targetLabel: string;
}) {
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const recentRunsLabelId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const selectedRun = useMemo(
    () =>
      props.recentRuns.find((run) => run.id === props.selectedRunId) ??
      props.recentRuns[0] ??
      null,
    [props.recentRuns, props.selectedRunId],
  );
  // Initial focus stays on the labelled container so screen readers announce
  // the dialog heading and description; focusing "Check again" first would
  // skip that context entirely. Trap, Escape, and focus restore are unchanged.
  useModalFocusTrap(props.open, dialogRef, props.onClose, {
    initialFocus: "dialog",
  });

  if (!props.open) {
    return null;
  }

  const artifact = props.details?.instructionArtifact ?? null;
  const details = props.details;

  return createPortal(
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-(--modal-scrim) px-4 py-6 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        aria-describedby={dialogDescriptionId}
        aria-labelledby={dialogTitleId}
        aria-modal="true"
        className="surface-panel-shell mx-auto flex min-h-0 max-h-[min(88vh,960px)] w-full max-w-6xl flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) shadow-(--modal-shadow)"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-(--surface-panel-border) px-5 py-4">
          <div className="grid gap-1">
            <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
              Source guidance
            </p>
            <h2
              className="text-[1.2rem] font-semibold tracking-[-0.02em] text-(--text-headline)"
              id={dialogTitleId}
            >
              {props.targetLabel}
            </h2>
            <p
              className="text-[0.9rem] leading-6 text-foreground-soft"
              id={dialogDescriptionId}
            >
              Review what the latest source check found before relying on this
              source in search.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              pending={props.isSourceDebugPending}
              onClick={props.onRerun}
              type="button"
              variant="secondary"
            >
              Check again
            </Button>
            <Button
              aria-label="Close"
              className="size-10"
              onClick={props.onClose}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <ProfileSourceDebugReviewModalContent
          artifact={artifact}
          details={details}
          errorMessage={props.errorMessage}
          isVerifyPending={props.isVerifyPending}
          loading={props.loading}
          onLoadRun={props.onLoadRun}
          onVerify={props.onVerify}
          recentRuns={props.recentRuns}
          recentRunsLabelId={recentRunsLabelId}
          selectedRunId={selectedRun?.id ?? null}
        />
      </div>
    </div>,
    document.body,
  );
}
