import { useState } from "react";
import type { ApplicationOutcome, RecordOutcomeInput } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";

export const outcomeRecordingOptions: ReadonlyArray<{
  outcome: ApplicationOutcome;
  label: string;
  hint: string | null;
}> = [
  {
    outcome: "application_completed",
    label: "Completed",
    hint: "The application was filled out and finished.",
  },
  {
    outcome: "abandoned",
    label: "Abandoned",
    hint: "You stopped before finishing this application.",
  },
  {
    outcome: "applied",
    label: "Applied (manual record)",
    hint: "Records that you applied. It never claims a browser submission happened.",
  },
  {
    outcome: "employer_response",
    label: "Employer response",
    hint: "The employer contacted you.",
  },
  {
    outcome: "assessment",
    label: "Assessment",
    hint: "You were sent or completed an assessment.",
  },
  {
    outcome: "interview",
    label: "Interview",
    hint: "An interview happened or was scheduled.",
  },
  {
    outcome: "offer",
    label: "Offer",
    hint: "An offer was made.",
  },
  {
    outcome: "rejected",
    label: "Rejected",
    hint: "The employer declined this application.",
  },
  {
    outcome: "withdrawn",
    label: "Withdrawn",
    hint: "You withdrew this application.",
  },
  {
    outcome: "no_response",
    label: "No response",
    hint: "The employer has not responded.",
  },
];

const fieldClassName =
  "h-11 w-full rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]";

/**
 * User-controlled outcome recording for one application. It only ever emits a
 * `RecordOutcomeInput` for the shell's `recordOutcome` action — it never
 * touches apply runs, approvals, or the browser, and recording "applied"
 * never fabricates submission evidence.
 */
export function ApplicationsOutcomeRecorder(props: {
  isPending: boolean;
  jobId: string;
  campaignId: string | null;
  applicationRecordId: string;
  onRecordOutcome: (input: RecordOutcomeInput) => Promise<void>;
  resumeStrategyId: string | null;
}) {
  const [outcome, setOutcome] = useState<ApplicationOutcome | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectedOption = outcome
    ? (outcomeRecordingOptions.find((option) => option.outcome === outcome) ??
      null)
    : null;

  const handleSubmit = () => {
    if (!outcome) return;
    setError(null);
    void props
      .onRecordOutcome({
        jobId: props.jobId,
        campaignId: props.campaignId,
        applicationRecordId: props.applicationRecordId,
        outcome,
        resumeStrategyId: props.resumeStrategyId,
        note: note.trim() ? note.trim() : null,
      })
      .then(() => {
        setOutcome("");
        setNote("");
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "The outcome could not be recorded.",
        );
      });
  };

  return (
    <div className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) p-4">
      <div>
        <p className="label-mono-xs">Outcome</p>
        <h4 className="mt-1 font-semibold text-foreground">
          Record what happened
        </h4>
        <p className="mt-1 text-sm leading-6 text-foreground-soft">
          Your local outcome log and Analytics update only from what you record
          here. Nothing contacts the employer or submits an application.
        </p>
      </div>

      {error ? (
        <p
          className="rounded-(--radius-field) border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          Outcome
          <select
            className={fieldClassName}
            disabled={props.isPending}
            onChange={(event) => {
              setOutcome(event.target.value as ApplicationOutcome | "");
              setError(null);
            }}
            value={outcome}
          >
            <option value="">Choose an outcome</option>
            {outcomeRecordingOptions.map((option) => (
              <option key={option.outcome} value={option.outcome}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          Note (optional)
          <input
            className={fieldClassName}
            disabled={props.isPending}
            maxLength={2_000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Recruiter feedback, follow-up date, ..."
            value={note}
          />
        </label>
      </div>

      {selectedOption?.hint ? (
        <p className="text-(length:--text-small) leading-5 text-muted-foreground">
          {selectedOption.hint}
        </p>
      ) : null}
      {outcome === "applied" ? (
        <p className="text-(length:--text-small) leading-5 text-foreground-soft">
          Recording “Applied” is a manual outcome only. It does not claim that a
          browser submission happened and never triggers or fabricates
          submission evidence.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-(length:--text-small) leading-5 text-muted-foreground">
          {props.resumeStrategyId
            ? "The current resume strategy for this job will be attached."
            : "No resume strategy is attached to this application."}
        </p>
        <Button
          disabled={props.isPending || !outcome}
          onClick={handleSubmit}
          pending={props.isPending}
          size="sm"
          type="button"
          variant="secondary"
        >
          Record outcome
        </Button>
      </div>
    </div>
  );
}
