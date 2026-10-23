import { Button } from "@renderer/components/ui/button";
import type {
  ApplicationAttemptQuestion,
  UserActionCommandInput,
  UserActionRequest,
} from "@nestor/contracts";
import {
  QuestionAnswerForm,
  type QuestionAnswerDraft,
  createCommand,
  useMinutesSince,
} from "../actions/actions-screen";

/**
 * The question step an application is waiting on, answerable right where the
 * application is shown. Needs you lists the same step; answering in either
 * place moves the same request on, so a person never has to leave the
 * application to find the box.
 */
export interface ApplicationAnswerStep {
  request: UserActionRequest;
  draft?: QuestionAnswerDraft;
  draftRestored?: boolean;
  onDraftChange?: (draft: QuestionAnswerDraft) => void | Promise<void>;
  jobLocation?: string | undefined;
  questions: readonly ApplicationAttemptQuestion[];
  isPending: boolean;
  waitingForTurn?: boolean;
  /** The run was started in Send for me, so answering can lead to a send. */
  runSends?: boolean;
  onCommand: (command: UserActionCommandInput) => void | Promise<void>;
}

export function ApplicationAnswerStepCard(props: {
  step: ApplicationAnswerStep;
}) {
  const { request, questions, isPending, onCommand } = props.step;
  const elapsed = useMinutesSince(
    request.state === "verifying" ? request.updatedAt : null,
  );
  if (request.state === "verifying") {
    return (
      <p
        aria-live="polite"
        className="text-(length:--text-small) leading-6 text-foreground-soft"
        data-testid="application-answer-step-status"
        role="status"
      >
        {props.step.waitingForTurn
          ? "Waiting its turn"
          : "Inserting your answer"}{" "}
        ({elapsed === 0 ? "under a minute" : `${elapsed ?? 0} min`}). Job Finder
        will continue when it is in the form.
      </p>
    );
  }
  return (
    <div className="grid min-w-0 gap-2" data-testid="application-answer-step">
      <p className="text-(length:--text-small) leading-6 text-foreground">
        Answer here and Job Finder will continue.
      </p>
      <QuestionAnswerForm
        key={`${request.id}-${props.step.draftRestored ? "restored" : "current"}`}
        {...(props.step.draft ? { draft: props.step.draft } : {})}
        {...(props.step.onDraftChange
          ? { onDraftChange: props.step.onDraftChange }
          : {})}
        jobLocation={props.step.jobLocation}
        isPending={isPending}
        onAnswer={async (answers, saveForFuture, hiringCountry) => {
          const first = answers[0];
          if (!first) return;
          await onCommand({
            ...createCommand(request, "confirm_done"),
            action: "submit_manual_answer",
            answer: first.answer,
            ...(answers.length > 1 || questions.length > 1
              ? { answers: answers.map((entry) => ({ ...entry })) }
              : {}),
            saveForFuture,
            ...(hiringCountry ? { hiringCountry } : {}),
          });
        }}
        questions={questions}
        requestId={request.id}
        {...(props.step.runSends ? { submitLabel: "Answer and apply" } : {})}
      />
      <Button
        type="button"
        variant="ghost"
        pending={isPending}
        onClick={() => void onCommand(createCommand(request, "cancel"))}
      >
        Skip this job
      </Button>
      <p className="text-xs text-foreground-muted">
        Stops this application without sending it. Its history is kept, and you
        can try again later.
      </p>
    </div>
  );
}
