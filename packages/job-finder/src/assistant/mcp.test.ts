import {
  openJobStore,
  createJobSitesStore,
  createSourceAccessStore,
} from "@nestor/db/job-store";
import { createApplicationStore } from "@nestor/db/applications";
import { createNeedsYouCommandRunner } from "../applications/needs-you-commands";
import {
  JOB_COMMANDS,
  AssistantChangeReceiptSchema,
  SavedFormAnswersPageSchema,
  type JobCommandOutputs,
} from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { createJobCommandRunner } from "../job-commands";
import { assistantCommandTools } from "./command-tools";
import { connectAssistantMcp } from "./mcp";
import { buildAssistantToolCatalog } from "./tools";
import { toConversationTool, type AssistantToolContext } from "./tool-kit";
import {
  needsYouCommandTools,
  type RunNeedsYouCommand,
} from "./needs-you-commands";

it("creates and reads the real Needs you answer library through MCP", async () => {
  const store = openJobStore(":memory:");
  const applications = createApplicationStore(store);
  const run = createNeedsYouCommandRunner(() => applications, {
    retry: () => Promise.resolve(),
    open: () => Promise.resolve(false),
    check: () => Promise.resolve(false),
  });
  const ctx = context();
  ctx.session.assertPersonAnswerAuthority = () => Promise.resolve();
  ctx.session.recordChange = vi.fn((input) =>
    Promise.resolve({
      receipt: AssistantChangeReceiptSchema.parse({
        id: "receipt",
        conversationId: "chat",
        ...input,
        createdAt: new Date().toISOString(),
      }),
      part: { type: "text", text: "Saved answer changed" },
    }),
  );
  const mcp = await connectAssistantMcp(needsYouCommandTools(run), ctx);
  try {
    for (const [prompt, answer] of [
      ["Years of analysis experience", "5"],
      ["Years of coordination experience", "14"],
    ] as const)
      await mcp.tools
        .find((tool) => tool.name === "create_form_answer")!
        .execute({ prompt, answer }, ctx);
    const listed = await mcp.tools
      .find((tool) => tool.name === "list_form_answers")!
      .execute({}, ctx);
    const saved = SavedFormAnswersPageSchema.parse(listed.data);
    expect(saved.total).toBe(2);
    expect(saved.rows.map((row) => [row.prompt, row.preview])).toEqual(
      expect.arrayContaining([
        ["Years of analysis experience", "5"],
        ["Years of coordination experience", "14"],
      ]),
    );
    await mcp.tools
      .find((tool) => tool.name === "upsert_form_answer")!
      .execute(
        {
          key: "notice_period",
          kind: "notice_period",
          prompt: "My notice period",
          answer: "Two weeks",
        },
        ctx,
      );
    const byKey = await mcp.tools
      .find((tool) => tool.name === "get_form_answer_by_key")!
      .execute({ key: "notice_period" }, ctx);
    expect(byKey.data).toMatchObject({
      key: "notice_period",
      kind: "notice_period",
      answer: "Two weeks",
    });
    const notice = applications.needsYou.getAnswerByKey({
      key: "notice_period",
    })!;
    const edit = await mcp.tools
      .find((tool) => tool.name === "save_form_answer")!
      .execute({ id: notice.id, answer: "Four weeks" }, ctx);
    const editChange = edit.data as { undoId: number };
    expect(applications.needsYou.savedAnswer(notice.id)?.answer).toBe(
      "Four weeks",
    );
    const forgot = await mcp.tools
      .find((tool) => tool.name === "forget_form_answers")!
      .execute({ ids: [notice.id] }, ctx);
    const forgetChange = forgot.data as { undoId: number };
    expect(applications.needsYou.savedAnswer(notice.id)).toBeNull();
    await run("undo_form_answer_change", { undoId: forgetChange.undoId });
    expect(applications.needsYou.savedAnswer(notice.id)?.answer).toBe(
      "Four weeks",
    );
    await run("undo_form_answer_change", { undoId: editChange.undoId });
    expect(applications.needsYou.savedAnswer(notice.id)?.answer).toBe(
      "Two weeks",
    );
    const earlier = await run("save_form_answer", {
      id: notice.id,
      answer: "Three weeks",
    });
    await run("save_form_answer", { id: notice.id, answer: "Five weeks" });
    expect(
      await run("undo_form_answer_change", { undoId: earlier.undoId! }),
    ).toEqual({ changed: 0, skipped: 1 });
    expect(applications.needsYou.savedAnswer(notice.id)?.answer).toBe(
      "Five weeks",
    );
    expect(
      applications.needsYou.answersForQuestions(
        1,
        [
          {
            key: "field",
            prompt: "Years of analysis experience",
            reusePrompt: true,
          },
        ],
        "https://jobs.example.test",
      )[0]?.answer,
    ).toBe("5");
  } finally {
    await mcp.close();
    store.close();
  }
});

it("checks the person's answer before a Needs you MCP write", async () => {
  const run = vi.fn((name: string) => {
    if (name === "get_need")
      return Promise.resolve({
        task: {
          id: 1,
          kind: "question",
          prompt: "Years of analysis experience",
        },
        applications: [],
        draft: null,
      });
    if (name === "answer_need")
      return Promise.resolve({ resolved: true, queued: 2 });
    throw new Error("Unexpected command");
  });
  const authority = vi.fn(
    (): Promise<void> =>
      Promise.reject(new Error("The person did not approve zero years.")),
  );
  const ctx = context();
  ctx.session.assertPersonAnswerAuthority = authority;
  const mcp = await connectAssistantMcp(
    needsYouCommandTools(run as unknown as RunNeedsYouCommand),
    ctx,
  );
  try {
    const answer = mcp.tools.find((tool) => tool.name === "answer_need")!;
    await expect(
      answer.execute({ id: 1, answer: "0", remember: true }, ctx),
    ).rejects.toThrow("did not approve");
    expect(run.mock.calls.map((call) => call[0])).toEqual(["get_need"]);
    authority.mockImplementation(() => Promise.resolve());
    const saved = await answer.execute(
      { id: 1, answer: "0", remember: true },
      ctx,
    );
    expect(saved.data).toEqual({ resolved: true, queued: 2 });
    expect(authority).toHaveBeenCalledWith({
      answers: [{ question: "Years of analysis experience", answer: "0" }],
      saveForFuture: true,
    });
    expect(run.mock.calls.map((call) => call[0])).toEqual([
      "get_need",
      "get_need",
      "answer_need",
    ]);
  } finally {
    await mcp.close();
  }
});

function context(): AssistantToolContext {
  return {
    session: { assertCurrent: vi.fn(), signal: new AbortController().signal },
  } as unknown as AssistantToolContext;
}

it("reads a source sign-in item and retries its site without completing it early", async () => {
  const store = openJobStore(":memory:");
  try {
    const sites = createJobSitesStore(store);
    sites.add({ text: "http://127.0.0.1:47950/gated/" });
    const site = sites.list({}).rows[0]!;
    const access = createSourceAccessStore(store);
    const id = access.request(site.id, "Sign in to view jobs")!;
    const retry = vi.fn(() => Promise.resolve());
    const run = createNeedsYouCommandRunner(
      () => createApplicationStore(store),
      {
        open: () => Promise.resolve(true),
        check: () => Promise.resolve(false),
        retry,
      },
    );
    expect((await run("get_need", { id }))?.task.source).toMatchObject({
      id: site.id,
      url: site.url,
    });
    expect(await run("retry_need", { id })).toBe(true);
    expect(retry).toHaveBeenCalledWith(site.id);
    expect(access.pending(site.id)).toBe(true);
    access.complete(site.id);
    expect(await run("retry_need", { id })).toBe(false);
    expect(retry).toHaveBeenCalledTimes(1);
  } finally {
    store.close();
  }
});

it("lists, shortlists and undoes real stored jobs over MCP using the screen commands", async () => {
  const store = openJobStore(":memory:");
  store.saveFoundJobs({
    searchId: null,
    jobs: [
      {
        title: "Designer",
        company: "Acme",
        location: "Remote",
        workModes: [],
        url: "http://127.0.0.1:47950/job/1",
        applyUrl: null,
        sourceId: "replica",
        sourceLabel: "Replica",
        sourceJobId: "1",
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: null,
        employmentType: null,
        summary: null,
        description: "Design software.",
      },
    ],
  });
  const run = createJobCommandRunner({ store });
  const definitions = assistantCommandTools<
    typeof JOB_COMMANDS,
    JobCommandOutputs
  >(JOB_COMMANDS, run, {
    group: "jobs",
  });
  const ctx = context();
  const mcp = await connectAssistantMcp(definitions, ctx);
  const call = async (name: string, input: unknown) => {
    const tool = mcp.tools.find((tool) => tool.name === name)!;
    return tool.execute(input, ctx);
  };
  try {
    const found = await call("list_jobs", { stage: "found" });
    const page = z
      .object({ rows: z.array(z.object({ id: z.number() })) })
      .parse(found.data);
    const moved = await call("move_jobs", {
      selection: { ids: [page.rows[0]!.id] },
      to: "shortlisted",
    });
    expect((await run("list_jobs", { stage: "shortlisted" })).total).toBe(1);
    const move = z.object({ moveId: z.number() }).parse(moved.data);
    await call("undo_move", move);
    expect((await run("list_jobs", { stage: "found" })).total).toBe(1);
    await expect(
      call("move_jobs", { selection: { ids: ["old-id"] }, to: "shortlisted" }),
    ).rejects.toThrow();
    expect((await run("list_jobs", { stage: "found" })).total).toBe(1);
  } finally {
    await mcp.close();
    store.close();
  }
});

it("discovers a newly registered command without another Assistant schema or tool list", async () => {
  const catalog = {
    test_count: {
      effect: "read" as const,
      description: "Read the count.",
      input: z.object({ count: z.number().int() }).strict(),
    },
  };
  const run = vi.fn((_name: "test_count", input: { count: number }) =>
    Promise.resolve({
      value: input.count,
    }),
  );
  const commands = assistantCommandTools<
    typeof catalog,
    { test_count: { value: number } }
  >(catalog, run, {
    group: "jobs",
  });
  const ctx = context();
  const mcp = await connectAssistantMcp(commands, ctx);
  const loaded: string[] = [];
  try {
    const tools = buildAssistantToolCatalog({
      mode: "grouped",
      browserAvailable: false,
      commands: mcp.tools,
      onLoadToolNames: (names) => loaded.push(...names),
    });
    const load = tools.find((tool) => tool.name === "load_tools")!;
    await load.execute({ groups: ["jobs"] }, ctx);
    expect(loaded).toContain("test_count");
    const tool = mcp.tools.find((tool) => tool.name === "test_count")!;
    expect(tool.description).toBe(catalog.test_count.description);
    expect(tool.parameters.required).toEqual(["count"]);
    expect(await tool.execute({ count: 4 }, ctx)).toMatchObject({
      data: { value: 4 },
    });
    expect(run).toHaveBeenCalledWith("test_count", { count: 4 });
    ctx.session.assertCurrent = () => {
      throw new Error("Stopped");
    };
    await expect(tool.execute({ count: 5 }, ctx)).rejects.toThrow("Stopped");
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    await mcp.close();
  }
});

it("accepts activity status on strict store commands without passing it to the command", async () => {
  const run = vi.fn((_name: "read", input: { id: number }) =>
    Promise.resolve(input),
  );
  const commands = assistantCommandTools(
    {
      read: {
        effect: "read",
        description: "Read",
        input: z.object({ id: z.number() }).strict(),
      },
    },
    run,
    { group: "workspace" },
  );
  const ctx = context();
  ctx.session.now = () => "2026-10-25T12:00:00.000Z";
  const mcp = await connectAssistantMcp(commands, ctx);
  try {
    const tool = toConversationTool(mcp.tools[0]!, ctx, {
      parts: [],
      activity: [],
      endTurn: null,
      touched: [],
    });
    expect(
      await tool.execute(
        JSON.stringify({ id: 1, status: "Reading the current record" }),
        { step: 1 },
      ),
    ).toMatchObject({ status: "done" });
    expect(run).toHaveBeenCalledWith("read", { id: 1 });
  } finally {
    await mcp.close();
  }
});

it("preserves command fields named status and complete through the chat wrapper and MCP", async () => {
  const catalog = {
    save_status: {
      effect: "local_write" as const,
      description: "Save this status.",
      input: z
        .object({ status: z.enum(["interview"]), complete: z.boolean() })
        .strict(),
    },
  };
  const run = vi.fn(
    (_name: "save_status", input: { status: "interview"; complete: boolean }) =>
      Promise.resolve(input),
  );
  const commands = assistantCommandTools<
    typeof catalog,
    { save_status: { status: "interview"; complete: boolean } }
  >(catalog, run, { group: "tracking" });
  const ctx = context();
  ctx.session.now = () => "2026-10-25T12:00:00.000Z";
  const mcp = await connectAssistantMcp(commands, ctx);
  try {
    const tool = toConversationTool(mcp.tools[0]!, ctx, {
      parts: [],
      activity: [],
      endTurn: null,
      touched: [],
    });
    const result = await tool.execute(
      JSON.stringify({ status: "interview", complete: true }),
      { step: 1 },
    );
    expect(result).toMatchObject({ kind: "ok", status: "done" });
    expect(run).toHaveBeenCalledWith("save_status", {
      status: "interview",
      complete: true,
    });
  } finally {
    await mcp.close();
  }
});
