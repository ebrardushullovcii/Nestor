import type {
  ResumeCommandName,
  ResumeCommandInput,
  ResumeCommandOutput,
  StoredResume,
  ResumeChangeResult,
} from "@nestor/contracts";
import { diffValues } from "./change-diff";
import { AssistantToolError, type AssistantToolContext } from "./tool-kit";

/** Keep the edit revision ahead of content; provenance repeated on every bullet is not an edit input. */
export function resumeResultData(value: StoredResume) {
  const content = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(content);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .filter(
            ([key]) =>
              key !== "sourceRefs" && key !== "lastGeneratedContentHash",
          )
          .map(([key, item]) => [key, content(item)]),
      );
    return input;
  };
  const { draft, ...metadata } = value;
  return { ...metadata, draft: content(draft) };
}

/** The editor publishes this when sending a message or pressing an Undo card. */
export function guardResumeEditor(
  jobId: number,
  { session }: Pick<AssistantToolContext, "session">,
): void {
  const editor = session.context?.editor;
  if (
    editor?.editor === "resume" &&
    editor.jobId === String(jobId) &&
    editor.hasUnsavedEdits
  )
    throw new AssistantToolError(
      "conflict",
      "The resume editor has unsaved typing. Save those edits before changing or undoing this resume; the typing was kept.",
    );
}

export function resumeCommandReceipts(
  run: <K extends ResumeCommandName>(
    name: K,
    input: ResumeCommandInput<K>,
  ) => Promise<ResumeCommandOutput<K>>,
) {
  const previous = new WeakMap<object, StoredResume | null>();
  return {
    async before(
      this: void,
      input: { jobId: number },
      context: AssistantToolContext,
    ) {
      guardResumeEditor(input.jobId, context);
      previous.set(
        input,
        (await run("get_resume", { jobId: input.jobId })).resume,
      );
    },
    async result(
      value: ResumeChangeResult,
      input: { jobId: number },
      context: AssistantToolContext,
      action: "edit" | "approve",
    ) {
      const before = previous.get(input);
      previous.delete(input);
      const summary =
        action === "approve"
          ? "Approved the saved resume."
          : "Saved the resume edit.";
      if (!value.undoId)
        return {
          summary: "This resume already matches the request.",
          data: resumeResultData(value),
        };
      const entries =
        action === "edit"
          ? diffValues(before?.draft ?? null, value.draft, {
              labelFor: (path) => {
                const ids = path
                  .filter((part) => part.startsWith("#id:"))
                  .map((part) => part.slice(4));
                const section = before?.draft?.sections.find(
                  (row) => row.id === ids[0],
                );
                const entry = section?.entries.find((row) => row.id === ids[1]);
                const field =
                  path.at(-1)?.replace(/([a-z])([A-Z])/gu, "$1 $2") ??
                  "content";
                return (
                  section
                    ? [section.label, entry?.title, field]
                        .filter(Boolean)
                        .join(" › ")
                    : `Resume ${field}`
                ).slice(0, 160);
              },
            })
          : [];
      if (action === "approve" || before?.approvedAt !== value.approvedAt)
        entries.push({
          path: ["approval"],
          kind: "set",
          index: null,
          label: "Resume approval",
          before: before?.approvedAt ? "Approved" : "Needs approval",
          after: value.approvedAt ? "Approved" : "Needs approval",
        });
      const { part } = await context.session.recordChange({
        target: "app_command",
        targetId: String(input.jobId),
        summary,
        undoCommand: {
          name: "undo_resume_change",
          input: { jobId: input.jobId, changeId: value.undoId },
        },
        entries: entries.slice(0, 60),
      });
      return { summary, data: resumeResultData(value), parts: [part] };
    },
  };
}
