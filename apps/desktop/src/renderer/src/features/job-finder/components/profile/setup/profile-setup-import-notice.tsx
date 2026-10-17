import { ResumeImportProgress } from "../resume-import-progress";
import { useState } from "react";
import { X } from "lucide-react";
import {
  isInterruptedResumeImportRun,
  canRetrySavedResumeImport,
  RESUME_IMPORT_INTERRUPTED_MESSAGE,
  type CandidateProfile,
  type ResumeImportRun,
  type ResumeImportProgressEvent,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { getResumeImportStageFallbackNotes } from "../profile-resume-panel";
import { getResumeImportStageFallbackSummary } from "../resume-import-quality-note";

const NOTICE_DISMISSED_STORAGE_KEY_PREFIX =
  "nestor.profile-setup-import-notice-dismissed-v1:";

function readNoticeDismissed(key: string): boolean {
  try {
    return (
      localStorage.getItem(`${NOTICE_DISMISSED_STORAGE_KEY_PREFIX}${key}`) ===
      "1"
    );
  } catch {
    return false;
  }
}

function persistNoticeDismissed(key: string) {
  try {
    localStorage.setItem(`${NOTICE_DISMISSED_STORAGE_KEY_PREFIX}${key}`, "1");
  } catch {
    // The in-memory dismissal still holds for this visit.
  }
}

/** True when the latest import was cut off by the app closing. */
export function isInterruptedResumeImport(
  run: ResumeImportRun | null | undefined,
): boolean {
  // Typed, not a sentence compare: a run saved before the wording changed
  // is still recognised by its `failureKind`.
  return isInterruptedResumeImportRun(run ?? null);
}

export type ProfileSetupImportNoticeModel =
  | {
      kind: "interrupted" | "failed";
      key: string;
      message: string;
      actionLabel: string;
    }
  | {
      kind: "read_without_ai";
      key: string;
      message: string;
      actionLabel: string;
    };

/**
 * What the last import left for the person to know, whichever step setup
 * opened on. An import that stopped mid-way, or one the AI never read, used
 * to say so only on the Import step, which setup skips after an import, so
 * both looked like a clean result.
 */
export function buildProfileSetupImportNotice(input: {
  latestResumeImportRun: ResumeImportRun | null;
  profile: CandidateProfile;
}): ProfileSetupImportNoticeModel | null {
  const run = input.latestResumeImportRun;
  if (run && isInterruptedResumeImport(run)) {
    return {
      kind: "interrupted",
      key: `interrupted:${run.id}`,
      message: RESUME_IMPORT_INTERRUPTED_MESSAGE,
      actionLabel: `Import ${run.sourceResumeFileName} again`,
    };
  }
  if (run?.status === "failed") {
    return {
      kind: "failed",
      key: `failed:${run.id}`,
      message:
        run.errorMessage ??
        "The resume could not be read. Try again or continue manually.",
      actionLabel: canRetrySavedResumeImport(run)
        ? `Try ${run.sourceResumeFileName} again`
        : "Choose another file",
    };
  }
  const summary = getResumeImportStageFallbackSummary(run);
  if (!run || !summary) {
    return null;
  }
  const note =
    getResumeImportStageFallbackNotes(
      input.profile.baseResume.analysisWarnings,
    )[0] ?? `${summary.hint}.`;
  return {
    kind: "read_without_ai",
    key: `read_without_ai:${run.id}`,
    message: note,
    actionLabel: "Read it again",
  };
}

export function ProfileSetupImportNotice(props: {
  latestResumeImportRun: ResumeImportRun | null;
  profile: CandidateProfile;
  isImportResumePending: boolean;
  resumeImportProgress?: ResumeImportProgressEvent | null;
  isAnalyzeProfilePending: boolean;
  importDisabledReason: string | null;
  onImportResume?: (() => void) | undefined;
  onRetryInterruptedImport?: (() => void) | undefined;
  onAnalyzeProfileFromResume?: (() => void) | undefined;
}) {
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const notice = buildProfileSetupImportNotice({
    latestResumeImportRun: props.latestResumeImportRun,
    profile: props.profile,
  });
  if (props.isImportResumePending)
    return (
      <ResumeImportProgress
        isPending={true}
        progress={props.resumeImportProgress ?? null}
      />
    );
  if (
    !notice ||
    props.isImportResumePending ||
    dismissedKeys.has(notice.key) ||
    readNoticeDismissed(notice.key)
  ) {
    return null;
  }
  const onAction =
    notice.kind !== "read_without_ai"
      ? canRetrySavedResumeImport(props.latestResumeImportRun)
        ? props.onRetryInterruptedImport
        : props.onImportResume
      : props.onAnalyzeProfileFromResume;

  return (
    <div
      className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-4 py-3 text-sm leading-6 text-(--warning-text)"
      data-profile-setup-import-notice={notice.kind}
      role="status"
    >
      <p className="min-w-0 flex-1 basis-80">{notice.message}</p>
      <div className="flex shrink-0 items-center gap-2">
        {onAction ? (
          <Button
            disabled={Boolean(props.importDisabledReason)}
            onClick={onAction}
            pending={
              notice.kind !== "read_without_ai"
                ? props.isImportResumePending
                : props.isAnalyzeProfilePending
            }
            size="compact"
            type="button"
            variant="outline"
          >
            {notice.actionLabel}
          </Button>
        ) : null}
        <Button
          aria-label="Dismiss this notice"
          onClick={() => {
            persistNoticeDismissed(notice.key);
            setDismissedKeys((current) => new Set([...current, notice.key]));
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
