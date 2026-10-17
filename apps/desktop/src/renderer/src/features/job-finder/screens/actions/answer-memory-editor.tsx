import { useMemo, useState } from "react";
import type {
  ApplicationAttemptQuestion,
  CandidateProfile,
  ProjectGroupedManualAnswerCommand,
  UserActionRequest,
} from "@nestor/contracts";
import { Layers3, RotateCcw } from "lucide-react";

import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { resolveAnswerMemoryMatch } from "./answer-memory";

const matchStatusCopy = {
  exact: "Exact saved-question match. Review it before choosing to use it.",
  fuzzy: "Similar wording found. It will never be selected automatically.",
  no_match:
    "No saved answer matched. This draft remains one-use unless you explicitly save it.",
  conflict:
    "Conflicting exact answers exist. Use a one-time answer or resolve the conflict in Profile.",
  stale:
    "This saved answer references missing proof. Review it in Profile before reusing it.",
} as const;

/**
 * Deterministic caller-rooted group key for the reusable-answer project
 * command. The service derives every decision id from this key plus the
 * question-meaning cluster fingerprint, so re-projecting the same root
 * request with the same answer stays idempotent while any other collision is
 * refused instead of silently overwritten.
 */
export function deriveGroupedAnswerGroupKey(requestId: string): string {
  return `grouped-answer:${requestId}`;
}

export function AnswerMemoryEditor(props: {
  isPending: boolean;
  onProjectGrouped: (command: ProjectGroupedManualAnswerCommand) => void;
  onSubmit: (answer: string, saveForFuture: boolean) => void;
  profile: CandidateProfile;
  projectPending?: boolean;
  question: ApplicationAttemptQuestion;
  request: UserActionRequest;
}) {
  const match = useMemo(
    () => resolveAnswerMemoryMatch(props.profile, props.question.prompt),
    [props.profile, props.question.prompt],
  );
  const [draft, setDraft] = useState("");
  const trimmedDraft = draft.trim();
  const savedAnswer = match.candidate?.answer.trim() ?? null;
  const changedFromSaved = savedAnswer !== null && trimmedDraft !== savedAnswer;
  const canSaveForFuture =
    match.status !== "conflict" &&
    match.status !== "stale" &&
    !(match.status === "exact" && changedFromSaved);

  return (
    <section
      className="grid gap-4 rounded-md border border-border/70 bg-background/45 p-4"
      aria-label="Answer memory review"
    >
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="section">Answer memory</Badge>
          <Badge variant={match.confidence === "high" ? "status" : "outline"}>
            {match.confidence === "high"
              ? "High confidence"
              : match.confidence === "review"
                ? "Review required"
                : "No reusable match"}
          </Badge>
        </div>
        <p className="text-sm font-medium text-foreground">
          {props.question.prompt}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {matchStatusCopy[match.status]}
        </p>
      </div>

      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Where this came from</dt>
          <dd className="font-medium text-foreground">{match.provenance}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Prior question</dt>
          <dd className="font-medium text-foreground">
            {match.priorQuestion ?? "None"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Used for</dt>
          <dd className="font-medium text-foreground">{match.scope}</dd>
        </div>
      </dl>

      {match.candidate && match.status !== "conflict" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={props.isPending}
            onClick={() => setDraft(match.candidate?.answer ?? "")}
            size="compact"
            type="button"
            variant="secondary"
          >
            {match.status === "exact"
              ? "Use saved answer"
              : "Review similar answer"}
          </Button>
          <span className="self-center text-xs text-muted-foreground">
            Nothing is inserted until you choose this suggestion.
          </span>
        </div>
      ) : null}

      <div className="grid gap-2">
        <label
          className="text-xs font-medium text-foreground"
          htmlFor={`manual-answer-${props.request.id}`}
        >
          Answer draft
        </label>
        <Textarea
          id={`manual-answer-${props.request.id}`}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Draft the answer you will use for this application"
          rows={5}
          value={draft}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!trimmedDraft || props.isPending}
          onClick={() => props.onSubmit(trimmedDraft, false)}
          size="compact"
          type="button"
        >
          Use once
        </Button>
        <Button
          disabled={!trimmedDraft || props.isPending || !canSaveForFuture}
          onClick={() => props.onSubmit(trimmedDraft, true)}
          size="compact"
          type="button"
          variant="secondary"
        >
          Save for future & use
        </Button>
        <Button
          disabled={!trimmedDraft || props.isPending}
          onClick={() =>
            props.onProjectGrouped({
              groupKey: deriveGroupedAnswerGroupKey(props.request.id),
              requestId: props.request.id,
              expectedRequestRevision: props.request.revision,
              answer: { type: "text", value: trimmedDraft },
              saveScope: "reusable_profile",
            })
          }
          {...(props.projectPending === undefined
            ? {}
            : { pending: props.projectPending })}
          size="compact"
          type="button"
          variant="outline"
        >
          <Layers3 aria-hidden="true" /> Reuse for matching applications
        </Button>
        <Button
          disabled={!draft || props.isPending}
          onClick={() => setDraft("")}
          size="compact"
          type="button"
          variant="ghost"
        >
          <RotateCcw aria-hidden="true" /> Reset draft
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Use once records this answer only with this application. Save for future
        also adds an exact-question entry to Profile. Reuse for matching
        applications projects this draft as a reusable answer: the service only
        creates a group when 2+ exact compatible pending application questions
        exist, and nothing is submitted. Existing saved answers are never
        overwritten here.
      </p>
    </section>
  );
}
