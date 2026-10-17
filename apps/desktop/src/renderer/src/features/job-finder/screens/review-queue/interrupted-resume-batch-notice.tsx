import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import type {
  ReviewQueueItem,
  ResumeBatchProviderBlock,
} from "@nestor/contracts";

const dismissedKey = "nestor.resume-batch.dismissed-notices";

export function InterruptedResumeBatchNotice({
  noticeId,
  stopped,
  providerBlock,
  jobIds,
  jobs,
  onContinue,
}: {
  noticeId: string;
  stopped: boolean;
  providerBlock?: ResumeBatchProviderBlock;
  jobIds: readonly string[];
  jobs: readonly ReviewQueueItem[];
  onContinue: () => void;
}) {
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(
        window.localStorage.getItem(dismissedKey) ?? "[]",
      );
      return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string").slice(-100)
        : [];
    } catch {
      return [];
    }
  });
  if (dismissed.includes(noticeId)) return null;
  return (
    <div
      className="mb-3 shrink-0 rounded-(--radius-field) border border-warning/30 px-4 py-3 text-sm"
      data-interrupted-resume-notice
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p role="status">
            {providerBlock
              ? `The resume batch is paused. ${providerBlock.message}`
              : stopped
                ? "The previous resume batch was stopped. Finished resumes were kept."
                : "The previous resume batch did not finish. Finished resumes were kept."}
          </p>
          <p className="mt-1 text-foreground-muted">
            {jobIds.length} unfinished{" "}
            {jobIds.length === 1 ? "resume is" : "resumes are"} saved in this
            batch.
          </p>
        </div>
        <Button
          aria-label="Dismiss resume batch notice"
          title="Dismiss notice"
          onClick={() => {
            const next = [...dismissed, noticeId].slice(-100);
            setDismissed(next);
            try {
              window.localStorage.setItem(dismissedKey, JSON.stringify(next));
            } catch {
              /* The current visit can still dismiss it. */
            }
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2">
        <Button onClick={onContinue} size="sm" type="button">
          Continue batch
        </Button>
        {jobs.length > 0 ? (
          <details className="min-w-0 flex-1 py-1">
            <summary className="w-fit cursor-pointer text-xs text-foreground-soft">
              View unfinished jobs ({jobs.length})
            </summary>
            <ul
              aria-label="Unfinished resume jobs"
              className="mt-2 max-h-36 space-y-1 overflow-y-auto overscroll-contain pr-3 text-xs text-foreground-muted"
            >
              {jobs.map((job) => (
                <li key={job.jobId}>
                  {job.title} at {job.company}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}
