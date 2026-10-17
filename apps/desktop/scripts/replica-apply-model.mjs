import assert from "node:assert/strict";
import { createServer } from "node:http";

// A scripted model for browser mechanics checks, never a production fallback.
// It asks the real answer resolver for values and uses the real apply tools.
export function decideReplicaAction(messages) {
  const last = messages.at(-1);
  const calls = messages.flatMap((message) => message.tool_calls ?? []);
  const previous = calls.find((call) => call.id === last?.tool_call_id);
  if (
    previous?.function.name === "submit_application" &&
    last.content.includes("set to fill in only")
  )
    return {
      name: "finish",
      args: { reason: "The replica form is complete and ready for review." },
    };
  const seen = messages.findLast((message) =>
    /Page: http.*\n/u.test(message.content ?? ""),
  )?.content;
  if (!seen) return { name: "observe", args: {} };
  const page = seen.match(/Page: (\S+)/u)?.[1];
  assert.equal(new URL(page).hostname, "127.0.0.1");
  const fields = [...seen.matchAll(/^- (c\S+) \[([^\]]+)\] · (.+)$/gmu)].map(
    ([, ref, kind, detail]) => ({ ref, kind, detail }),
  );
  const buttons = [...seen.matchAll(/^- (a\S+): (.+)$/gmu)].map(
    ([, ref, label]) => ({ ref, label }),
  );
  if (
    buttons.some((entry) =>
      /(?:continue|Next).*\(disabled\)$/u.test(entry.label),
    )
  )
    return { name: "wait", args: { milliseconds: 300 } };
  const latestObservationIndex = messages.indexOf(
    messages.findLast((message) =>
      /Page: http.*\n/u.test(message.content ?? ""),
    ),
  );
  const skipped = new Set();
  for (const message of messages.slice(latestObservationIndex + 1)) {
    if (message.role !== "tool" || !message.content?.startsWith("Nothing"))
      continue;
    const call = calls.find((entry) => entry.id === message.tool_call_id);
    if (call?.function.name === "suggest_answer")
      skipped.add(JSON.parse(call.function.arguments).ref);
  }
  if (previous?.function.name === "suggest_answer") {
    const ref = JSON.parse(previous.function.arguments).ref;
    const field = fields.find((entry) => entry.ref === ref);
    const answer = last.content.match(/^"[\s\S]+?": ([\s\S]+) — from /u)?.[1];
    if (field && answer) {
      if (field.kind === "radio") {
        const question = field.detail
          .split(" · ")[0]
          .split(" — ")
          .slice(0, -1)
          .join(" — ");
        const choice = fields.find(
          (entry) =>
            entry.kind === "radio" &&
            entry.detail.split(" · ")[0].toLowerCase() ===
              `${question} — ${answer}`.toLowerCase(),
        );
        assert.ok(choice, `No radio choice matching ${answer}`);
        return {
          name: "set_checkbox",
          args: { ref: choice.ref, checked: true },
        };
      }
      if (field.kind === "checkbox")
        return {
          name: "set_checkbox",
          args: { ref, checked: !/^no$/iu.test(answer) },
        };
      if (field.kind === "select")
        return { name: "select", args: { ref, option: answer } };
      return { name: "type", args: { ref, text: answer } };
    }
  }
  const field = fields.find(
    (entry) =>
      entry.detail.includes(" · empty") &&
      !entry.detail.includes("cannot be edited") &&
      !skipped.has(entry.ref) &&
      !/Voluntary self-identification|Cover letter/iu.test(entry.detail),
  );
  if (field) {
    if (field.kind === "file") {
      const document = messages
        .map((message) => message.content ?? "")
        .join("\n")
        .match(
          /Files Job Finder already has for this application:\n- ([^:]+):/u,
        )?.[1];
      assert.ok(document, "The synthetic application must have a resume");
      return { name: "upload", args: { ref: field.ref, documentId: document } };
    }
    if (field.kind === "checkbox" && field.detail.includes("a declaration"))
      return { name: "set_checkbox", args: { ref: field.ref, checked: true } };
    return { name: "suggest_answer", args: { ref: field.ref } };
  }
  const facts = messages
    .map((message) => {
      try {
        return JSON.parse(message.content);
      } catch {
        return null;
      }
    })
    .find((value) => value?.savedApplicationFacts)?.savedApplicationFacts;
  const rows = new Set(
    fields.flatMap(
      (entry) => entry.detail.match(/Work experience (\d+)/iu)?.[1] ?? [],
    ),
  );
  const add = buttons.find((entry) => entry.label === "Add");
  if (add && rows.size < (facts?.experiences.length ?? 0))
    return { name: "click", args: { ref: add.ref } };
  const next = buttons.find((entry) =>
    /^(?:Save and continue|Next)$/u.test(entry.label),
  );
  // Review's Save button is optional; leave the final form for the person.
  const submit = buttons.find((entry) => /^Submit/u.test(entry.label));
  if (next && !submit) return { name: "click", args: { ref: next.ref } };
  if (submit) return { name: "submit_application", args: { ref: submit.ref } };
  return {
    name: "finish",
    args: {
      reason: "The replica needs the person to continue.",
      needsPerson: true,
    },
  };
}

export async function startReplicaModel() {
  let callId = 0;
  const turns = [];
  let beforeAction;
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      // Resume generation uses its deterministic fallback. No live provider.
      const isApply = input.tools?.some(
        (tool) => tool.function?.name === "suggest_answer",
      );
      const action = isApply ? decideReplicaAction(input.messages) : null;
      if (isApply) turns.push({ messages: input.messages, action });
      if (action) await beforeAction?.(input.messages, action);
      const message = action
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `replica_${++callId}`,
                type: "function",
                function: {
                  name: action.name,
                  arguments: JSON.stringify(action.args),
                },
              },
            ],
          }
        : { role: "assistant", content: "{}" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message, finish_reason: action ? "tool_calls" : "stop" }],
        }),
      );
    } catch (error) {
      console.error(`Scripted replica model: ${error.message}`);
      response.writeHead(500);
      response.end("Scripted model could not choose an action");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    turns,
    beforeAction(callback) {
      beforeAction = callback;
    },
    env: {
      NESTOR_AI_API_KEY: "synthetic-replica-only",
      NESTOR_AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      NESTOR_AI_MODEL: "scripted-replica-apply",
      NESTOR_AI_API_MODE: "chat_completions",
      NESTOR_AI_STREAMING: "0",
      NESTOR_AI_MAX_ATTEMPTS: "1",
      NESTOR_BROWSER_HOST: "embedded",
      NESTOR_ENABLE_TEST_API: "1",
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
