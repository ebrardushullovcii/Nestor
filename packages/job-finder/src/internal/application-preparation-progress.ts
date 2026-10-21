import type { ApplicationPreparationProgress } from "@nestor/browser-runtime";
import { ApplyJobResultSchema } from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

/**
 * Turns an agent/tool note into a safe sentence for durable UI state.
 *
 * Tool notes may include a field label or the value written to it. Those
 * details belong in the final review card, not in a progress banner or log.
 */
export function describeApplicationPreparationProgress(note: string): string {
  // The run names the form's own step ("form step 2 of 5: ...") so a long
  // form shows how far along it is. Only the two numbers are kept.
  const onStep = /^form step (\d{1,3}) of (\d{1,3}): ([\s\S]*)$/u.exec(note);
  if (onStep) {
    const label = describeApplicationPreparationProgress(onStep[3] ?? "");
    return `Step ${onStep[1]} of ${onStep[2]}: ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  }
  if (note === "reading the application form") {
    return "Opening the application form";
  }
  if (note === "asking the assistant what to do next") {
    return "Thinking about the next form step";
  }
  // The loop gives a slow or failed step back to the model and carries on.
  if (/ → took too long$/u.test(note)) {
    return "The page is slow to respond; looking again";
  }
  if (/ → (?:browser|tool) failure/u.test(note)) {
    return "A form step needs another approach";
  }
  if (note.startsWith("fill_fields")) return "Filling in form fields";
  if (note.startsWith("observe")) return "Reading the application form";
  if (note.startsWith("type ")) return "Filling a text field";
  if (note.startsWith("select ")) return "Choosing a form option";
  if (note.startsWith("set_checkbox")) return "Setting a form choice";
  if (note.startsWith("upload")) return "Attaching an approved document";
  if (note.startsWith("finished")) return "Finishing the review checkpoint";
  // The loop asks again on its own after a slow or failed answer; these say
  // so instead of sounding like the application failed.
  if (note.includes("time limit") || note.includes("unanswered assistant")) {
    return "The assistant is slow to answer; asking again";
  }
  if (note.includes("temporary service failure")) {
    return "The AI service had a brief problem; asking again";
  }
  if (note.includes("failure")) return "A form step needs another approach";
  return "Working through the application form";
}

const ACTIVE_PREPARATION_STATES = new Set([
  "planned",
  "question_capture",
  "filling",
]);

/**
 * Keeps the Applications screen truthful during a long form run.
 *
 * A compare-and-swap prevents a late progress event from replacing a final
 * outcome written by cancellation, review, or submission handling.
 */
export async function persistApplicationPreparationProgress(input: {
  repository: Pick<
    JobFinderRepository,
    "listApplyJobResults" | "compareAndSwapApplyJobResult"
  >;
  resultId: string;
  runId: string;
  jobId: string;
  progress: ApplicationPreparationProgress;
  now?: () => Date;
}): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = (
      await input.repository.listApplyJobResults({
        runId: input.runId,
        jobId: input.jobId,
      })
    ).find((result) => result.id === input.resultId);

    if (!current || !ACTIVE_PREPARATION_STATES.has(current.state)) return;

    const now = (input.now ?? (() => new Date()))().toISOString();
    const next = ApplyJobResultSchema.parse({
      ...current,
      state: "filling",
      summary: "Filling in application",
      detail: describeApplicationPreparationProgress(input.progress.note),
      updatedAt: now,
      completedAt: null,
    });
    if (
      await input.repository.compareAndSwapApplyJobResult({
        expected: current,
        result: next,
      })
    ) {
      return;
    }
  }
}

/** Written on an application waiting for a free tab in the Job Finder browser. */
export const WAITING_FOR_BROWSER_TAB_SUMMARY = "Waiting for a free browser tab";

/**
 * Says on the application that it is waiting for a tab, instead of failing
 * it after 20 seconds with "close tabs you no longer need".
 */
export async function persistApplicationWaitingForBrowserTab(input: {
  repository: Pick<
    JobFinderRepository,
    "listApplyJobResults" | "compareAndSwapApplyJobResult"
  >;
  resultId: string;
  runId: string;
  jobId: string;
}): Promise<void> {
  const current = (
    await input.repository.listApplyJobResults({
      runId: input.runId,
      jobId: input.jobId,
    })
  ).find((result) => result.id === input.resultId);
  if (!current || !ACTIVE_PREPARATION_STATES.has(current.state)) return;
  await input.repository.compareAndSwapApplyJobResult({
    expected: current,
    result: ApplyJobResultSchema.parse({
      ...current,
      summary: WAITING_FOR_BROWSER_TAB_SUMMARY,
      detail:
        "Browser tab limit reached. Close finished tabs to continue. Prepared, unsent forms stay open.",
      updatedAt: new Date().toISOString(),
      completedAt: null,
    }),
  });
}
