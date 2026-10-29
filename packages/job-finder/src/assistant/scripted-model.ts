import type {
  AgentLoopMessage,
  AgentLoopToolCall,
  ConversationModel,
} from "@nestor/agent-runtime";
import { AssistantJobListPageSchema } from "@nestor/contracts";

/**
 * A deterministic stand-in for the sidebar's model, used when no live AI is
 * configured for tests and by the eval lane's regression runs. It handles a
 * fixed set of phrasings with real tool calls so the whole path (tools,
 * receipts, grants, background runs, events) runs without a network. It is
 * never offered as a product model.
 */

interface Step {
  content?: string;
  toolCalls?: AgentLoopToolCall[];
}

let callCounter = 0;

function call(name: string, args: Record<string, unknown>): AgentLoopToolCall {
  callCounter += 1;
  return {
    id: `scripted_call_${callCounter}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function shortlist(ids: readonly number[]): AgentLoopToolCall {
  return call("move_jobs", { selection: { ids }, to: "shortlisted" });
}

function stripContext(text: string): string {
  return text.replace(/<context>[\s\S]*?<\/context>/gu, "").trim();
}

function lastPersonText(messages: readonly AgentLoopMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && !message.content.startsWith("[Summary of")) {
      return stripContext(message.content).replace(
        /^\[New message from the person while you were working\]\s*/u,
        "",
      );
    }
  }
  return "";
}

function lastContextBlock(messages: readonly AgentLoopMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      const match = /<context>([\s\S]*?)<\/context>/u.exec(message.content);
      if (match) return match[1] ?? "";
    }
  }
  return "";
}

/** Tool results since the person's last message, newest last. */
function toolResultsThisTurn(messages: readonly AgentLoopMessage[]): {
  name: string;
  content: string;
}[] {
  const names = new Map<string, string>();
  const results: { name: string; content: string }[] = [];
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  messages.forEach((message, index) => {
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        names.set(toolCall.id, toolCall.function.name);
      }
    }
    if (message.role === "tool" && index > lastUser) {
      results.push({
        name: names.get(message.toolCallId) ?? "",
        content: message.content,
      });
    }
  });
  return results;
}

function jsonOf(content: string): Record<string, unknown> | null {
  const line = content.split("\n").slice(1).join("\n");
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function findLast(
  messages: readonly AgentLoopMessage[],
  pattern: RegExp,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(messages[index]!.content);
    if (match?.[1]) return match[1];
  }
  return null;
}

function contextResultSet(
  context: string,
  which: "Rows the person ticked" | "Whole filtered set" | "Rows painted",
): string | null {
  const pattern = new RegExp(`${which}[^:]*: result set (\\S+) `, "u");
  return pattern.exec(context)?.[1] ?? null;
}

function plan(messages: readonly AgentLoopMessage[]): Step {
  const text = lastPersonText(messages);
  const lower = text.toLowerCase();
  const results = toolResultsThisTurn(messages);
  const last = results.at(-1);
  const context = lastContextBlock(messages);

  if (/Has a resume been written for my shortlisted/iu.test(text)) {
    if (!last)
      return {
        toolCalls: [call("list_jobs", { stage: "shortlisted", limit: 10 })],
      };
    const data = AssistantJobListPageSchema.safeParse(jsonOf(last.content));
    return {
      content:
        data.success &&
        data.data.rows.some((row) => row.resumeStatus === "to_review")
          ? "Your resume draft is ready to review."
          : "No resume has been written yet.",
    };
  }
  if (/show my shortlisted jobs/iu.test(text)) {
    if (!last)
      return {
        toolCalls: [call("list_jobs", { stage: "shortlisted", limit: 10 })],
      };
    return { content: "Here are your shortlisted jobs." };
  }

  // Job Finder's own note about a finished run.
  if (/^\[Job Finder, not the person\]/u.test(text)) {
    if (
      results.length === 0 &&
      /checklist/iu.test(text) &&
      /search/iu.test(text)
    ) {
      return { toolCalls: [call("list_jobs", { stage: "found", limit: 5 })] };
    }
    return {
      content: text
        .replace(/^\[Job Finder, not the person\]\s*/u, "")
        .split("\n")[0]!
        .slice(0, 400),
    };
  }

  if (/^Copy my headline so I can paste it\.?$/iu.test(text)) {
    if (!last)
      return { toolCalls: [call("read_profile", { section: "basics" })] };
    if (results.length === 1) {
      const data = jsonOf(last.content);
      const basics = (data?.basics ?? {}) as Record<string, unknown>;
      return {
        toolCalls: [
          call("action_write_clipboard_text", {
            text: typeof basics.headline === "string" ? basics.headline : "",
          }),
        ],
      };
    }
    return { content: "Your headline was copied." };
  }
  let match =
    /(?:change|set|update) my headline to\s+["“]?(.+?)["”]?\.?$/iu.exec(text);
  if (match) {
    if (!last) {
      return {
        toolCalls: [
          call("edit_profile", {
            summary: "Change the headline",
            operations: [
              {
                operation: "replace_identity_fields",
                value: { headline: match[1] },
              },
            ],
            status: "Changing your headline",
          }),
        ],
      };
    }
    return { content: `Done. Your headline is now "${match[1]}".` };
  }

  match = /(?:change|set|update) my summary to\s+["“]?(.+?)["”]?\.?$/iu.exec(
    text,
  );
  if (match) {
    if (!last) {
      return {
        toolCalls: [
          call("edit_profile", {
            summary: "Change the summary",
            operations: [
              {
                operation: "replace_professional_summary_fields",
                value: { fullSummary: match[1] },
              },
            ],
          }),
        ],
      };
    }
    return { content: "Done. I updated your summary." };
  }

  match = /add\s+(.+?)\s+to my (?:skills|target roles)/iu.exec(text);
  if (match) {
    const field = /target roles/iu.test(text) ? "targetRoles" : "skills";
    if (!last)
      return { toolCalls: [call("read_profile", { section: "basics" })] };
    if (last.name === "read_profile") {
      const data = jsonOf(last.content);
      const basics = (data?.basics ?? {}) as Record<string, unknown>;
      const current = Array.isArray(basics[field])
        ? (basics[field] as string[])
        : [];
      return {
        toolCalls: [
          call("edit_profile", {
            summary: `Add ${match[1]} to ${field === "skills" ? "skills" : "target roles"}`,
            operations: [
              {
                operation: "replace_profile_list_fields",
                value: { [field]: [...current, match[1]] },
              },
            ],
          }),
        ],
      };
    }
    return { content: `Added ${match[1]}.` };
  }

  if (/\bundo\b/iu.test(lower)) {
    const receiptId = findLast(messages, /"receiptId":"([^"]+)"/u);
    if (!last) {
      if (!receiptId)
        return {
          content: "There is no change of mine to undo in this conversation.",
        };
      return { toolCalls: [call("undo_change", { receiptId })] };
    }
    return {
      content: last.content
        .split("\n")[0]!
        .replace(/^Error \([^)]+\):\s*/u, ""),
    };
  }

  if (/what(?:'s| is) my headline/iu.test(text)) {
    if (!last)
      return { toolCalls: [call("read_profile", { section: "basics" })] };
    const data = jsonOf(last.content);
    const basics = (data?.basics ?? {}) as Record<string, unknown>;
    return {
      content: `Your headline is "${typeof basics.headline === "string" ? basics.headline : "not set"}".`,
    };
  }

  match = /(?:find|search for|look for)\s+(.+?)(?:\s+jobs?)?\.?$/iu.exec(text);
  if (match && !/apply/iu.test(text)) {
    if (!last) {
      return {
        toolCalls: [call("start_search", { note: match[1] })],
      };
    }
    return {
      content: last.content.startsWith("Error")
        ? last.content.split("\n")[0]!
        : "I started the search. I will tell you what it finds when it ends.",
    };
  }

  match = /shortlist (?:the )?(?:top|first|best) (\d+)/iu.exec(text);
  if (match) {
    const count = Number(match[1]);
    if (!last)
      return {
        toolCalls: [call("list_jobs", { stage: "found", limit: count })],
      };
    if (last.name === "list_jobs") {
      const data = jsonOf(last.content);
      const ids = ((data?.rows as { id: number }[] | undefined) ?? [])
        .map((job) => job.id)
        .slice(0, count);
      if (ids.length === 0)
        return { content: "There are no found jobs to shortlist yet." };
      return { toolCalls: [shortlist(ids)] };
    }
    return { content: last.content.split("\n")[0]! };
  }

  if (/shortlist (?:these|this|them|it|the ones i ticked)/iu.test(text)) {
    const resultSet =
      contextResultSet(context, "Rows the person ticked") ??
      contextResultSet(context, "Whole filtered set");
    const focused = /Open job: (\S+)/u.exec(context)?.[1];
    if (!last) {
      if (resultSet)
        return {
          toolCalls: [
            call("read_result", { resultSetId: resultSet, limit: 50 }),
          ],
        };
      if (focused) return { toolCalls: [shortlist([Number(focused)])] };
      return { content: "Which jobs? Select them on Find jobs first." };
    }
    if (last.name === "read_result") {
      const data = jsonOf(last.content);
      const ids = ((data?.items as { id: string }[] | undefined) ?? []).map(
        (item) => Number(item.id),
      );
      return { toolCalls: [shortlist(ids)] };
    }
    return { content: last.content.split("\n")[0]! };
  }

  if (/\bapply\b/iu.test(lower)) {
    const send =
      /\bsend\b/iu.test(lower) &&
      !/i'?ll send|i will send|don'?t send/iu.test(lower);
    const prepareOnly =
      /i'?ll send|i will send|prepare (?:only|them)|don'?t send/iu.test(lower);
    const resultSet =
      contextResultSet(context, "Rows the person ticked") ??
      contextResultSet(context, "Whole filtered set");
    const focused = /Open job: (\S+)/u.exec(context)?.[1];
    if (!last) {
      return {
        toolCalls: [
          call("record_instruction", {
            action: send
              ? "prepare_and_send"
              : prepareOnly
                ? "prepare"
                : "apply_saved_mode",
            ...(resultSet
              ? { resultSetId: resultSet }
              : { jobIds: focused ? [focused] : [] }),
            quote: text.slice(0, 500),
          }),
        ],
      };
    }
    if (last.name === "record_instruction") {
      const data = jsonOf(last.content);
      const jobIds = (data?.jobIds as string[] | undefined) ?? [];
      if (jobIds.length === 0) return { content: last.content.split("\n")[0]! };
      return {
        toolCalls: [
          call("apply_to_jobs", { selection: { ids: jobIds.map(Number) } }),
        ],
      };
    }
    return { content: last.content.split("\n")[0]! };
  }

  if (
    /shorten|make (?:this|it) shorter|tighten/iu.test(lower) &&
    /Resume studio for job (\S+)/u.test(context)
  ) {
    const jobId = /Resume studio for job (\S+):/u.exec(context)?.[1];
    const bullets = /bullets ([^,\s]+)/u.exec(context)?.[1];
    const section = /section (\S+?)[,\s]/u.exec(context)?.[1];
    const selectedText = /text "([^"]+)"/u.exec(context)?.[1];
    if (!last) return { toolCalls: [call("read_resume", { jobId })] };
    if (last.name === "read_resume" && bullets && section && selectedText) {
      const data = jsonOf(last.content);
      const draft = (data?.draft ?? {}) as {
        revision?: string;
        sections?: {
          id: string;
          entries: { id: string; bullets: { id: string }[] }[];
        }[];
      };
      const entryId = draft.sections
        ?.find((candidate) => candidate.id === section)
        ?.entries.find((entry) =>
          entry.bullets.some((bullet) => bullet.id === bullets),
        )?.id;
      const shorter = selectedText.split(/[,.;]/u)[0]!.trim();
      return {
        toolCalls: [
          call("edit_resume", {
            jobId,
            revision: draft.revision,
            summary: "Shorten the selected bullet",
            edits: [
              {
                operation: "update_bullet",
                sectionId: section,
                ...(entryId ? { entryId } : {}),
                bulletId: bullets,
                text: shorter.length > 10 ? shorter : selectedText.slice(0, 80),
              },
            ],
          }),
        ],
      };
    }
    return { content: last.content.split("\n")[0]! };
  }

  if (/what(?:'s| is) blocking|needs me|needs you/iu.test(lower)) {
    if (!last) return { toolCalls: [call("list_needs_you", {})] };
    return { content: last.content.split("\n")[0]! };
  }

  if (
    /where (?:do|does) .*stand|summary of my search|how am i doing/iu.test(
      lower,
    )
  ) {
    if (!last) return { toolCalls: [call("get_workspace_summary", {})] };
    return { content: last.content.split("\n")[0]! };
  }

  return {
    content:
      "I can change your profile, work on resumes, find and shortlist jobs, and prepare or send applications. The live AI is switched off in this test build, so I only follow a few fixed phrasings.",
  };
}

export function createScriptedAssistantModel(
  options: {
    /** Simulated time per model call, to exercise progress and Stop. */
    delayMs?: number;
  } = {},
): ConversationModel {
  return {
    async chatWithTools(messages, _tools, callOptions) {
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          callOptions?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }
      callOptions?.signal?.throwIfAborted();
      const step = plan(messages);
      callOptions?.onStreamEvent?.({ type: "attempt_started", attempt: 0 });
      if (step.content) {
        for (const chunk of step.content.match(/.{1,24}/gsu) ?? []) {
          callOptions?.onStreamEvent?.({ type: "text_delta", text: chunk });
        }
      }
      return {
        ...(step.content ? { content: step.content } : {}),
        ...(step.toolCalls ? { toolCalls: step.toolCalls } : {}),
        usage: {
          inputTokens: Math.ceil(
            messages.reduce((sum, message) => sum + message.content.length, 0) /
              3.6,
          ),
          outputTokens: Math.ceil((step.content?.length ?? 40) / 3.6),
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        finishReason: step.toolCalls ? "tool_calls" : "stop",
      };
    },
  };
}
