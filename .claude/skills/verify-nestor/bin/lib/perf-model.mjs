// A scripted OpenAI-compatible model for `perf --load`: browser load does not
// depend on what a model says, so searches and Apply run on the replica sites
// without a real model call. Never a production fallback.
import { createServer } from "node:http";

import { decideApplyAction } from "./perf-apply-policy.mjs";

const toolCall = (id, name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: `perf_${id}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

// The search's JSON questions, told apart by what they send
// (packages/browser-agent/src/search/listing-engine.ts).
function answerJson(messages) {
  let data;
  try {
    data = JSON.parse(messages.findLast((m) => m.role === "user")?.content);
  } catch {
    return { kind: "other", content: "{}" };
  }
  if (Array.isArray(data?.titles))
    return {
      kind: "titles",
      content: JSON.stringify({
        keep: Object.fromEntries(data.titles.map(([index]) => [index, 1])),
      }),
    };
  if (Array.isArray(data?.listings) && data.person)
    return {
      kind: "fit",
      content: JSON.stringify({
        fits: data.listings.map((listing) => ({
          id: listing.id,
          s: 72,
          why: "Synthetic load run.",
          r: ["related", "Synthetic."],
          p: ["aligned", "Synthetic."],
          c: ["partial", "Synthetic."],
        })),
      }),
    };
  if (Array.isArray(data?.listings))
    return {
      kind: "listing",
      content: JSON.stringify({
        jobs: data.listings.map((listing) => ({
          id: listing.id,
          title: listing.title || "Synthetic role",
          company: listing.published?.company || "Synthetic Co",
          location: listing.published?.location || "Remote",
          workModes: [],
          sourceJobId: null,
          employmentType: null,
          seniority: null,
          salaryText: null,
          closed: false,
        })),
      }),
    };
  return { kind: "other", content: "{}" };
}

export async function startPerfModel() {
  let calls = 0;
  const counts = {};
  // The first few requests the script does not recognize, for --load's report.
  const unknown = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const tools = (input.tools ?? []).map((tool) => tool.function?.name);
      let message;
      let kind;
      if (tools.includes("fill_fields")) {
        kind = "apply";
        const action = decideApplyAction(input.messages);
        message = toolCall(++calls, action.name, action.args);
      } else if (tools.includes("report_question_kinds")) {
        // Apply's question check: every question plain, none gated.
        kind = "questions";
        let questions = [];
        try {
          questions = JSON.parse(
            input.messages.find((m) => m.role === "user")?.content ?? "[]",
          );
        } catch {
          questions = [];
        }
        const indexes = questions.map((question) => question.index);
        message = toolCall(++calls, "report_question_kinds", {
          tags: indexes.map((index) => ({
            index,
            kind: "other",
            country: null,
            sourceId: null,
            declarationPurpose: null,
          })),
          plainIndexes: indexes,
          flagged: [],
        });
      } else if (tools.includes("finish_task")) {
        // Background resume writing for the seeded shortlist ends at once.
        kind = "resume";
        message = toolCall(++calls, "finish_task", {
          summary: "Synthetic load run.",
        });
      } else if (tools.includes("finish")) {
        // Agent discovery and site checks end at once.
        kind = "agent";
        message = toolCall(++calls, "finish", {
          reason: "Synthetic load run: nothing more to read here.",
        });
      } else {
        const answer = answerJson(input.messages ?? []);
        kind = answer.kind;
        message = { role: "assistant", content: answer.content };
      }
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (kind === "other" && unknown.length < 3)
        unknown.push({
          system: input.messages?.[0]?.content?.slice(0, 160),
          user: input.messages?.at(-1)?.content?.slice(0, 160),
          tools,
        });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message,
              finish_reason: message.tool_calls ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      );
    } catch (error) {
      counts.error = (counts.error ?? 0) + 1;
      response.writeHead(500);
      response.end(`Scripted perf model: ${error.message}`);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    counts,
    unknown,
    env: {
      NESTOR_AI_API_KEY: "synthetic-replica-only",
      NESTOR_AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      NESTOR_AI_MODEL: "scripted-perf",
      NESTOR_AI_API_MODE: "chat_completions",
      NESTOR_AI_STREAMING: "0",
      NESTOR_AI_MAX_ATTEMPTS: "1",
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
