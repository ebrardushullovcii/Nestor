import { openJobStore } from "@nestor/db/job-store";
import { JOB_COMMANDS, type JobCommandOutputs } from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { createJobCommandRunner } from "../job-commands";
import { assistantCommandTools } from "./command-tools";
import { connectAssistantMcp } from "./mcp";
import { buildAssistantToolCatalog } from "./tools";
import { toConversationTool, type AssistantToolContext } from "./tool-kit";

function context(): AssistantToolContext {
  return {
    session: { assertCurrent: vi.fn(), signal: new AbortController().signal },
  } as unknown as AssistantToolContext;
}

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


it("preserves command fields named status and complete through the chat wrapper and MCP", async () => {
  const catalog = {
    save_status: {
      effect: "local_write" as const,
      description: "Save this status.",
      input: z.object({ status: z.enum(["interview"]), complete: z.boolean() }).strict(),
    },
  };
  const run = vi.fn((_name: "save_status", input: { status: "interview"; complete: boolean }) => Promise.resolve(input));
  const commands = assistantCommandTools<typeof catalog, { save_status: { status: "interview"; complete: boolean } }>(catalog, run, { group: "tracking" });
  const ctx = context();
  ctx.session.now = () => "2026-10-25T12:00:00.000Z";
  const mcp = await connectAssistantMcp(commands, ctx);
  try {
    const tool = toConversationTool(mcp.tools[0]!, ctx, { parts: [], activity: [], endTurn: null, touched: [] });
    const result = await tool.execute(JSON.stringify({ status: "interview", complete: true }), { step: 1 });
    expect(result).toMatchObject({ kind: "ok", status: "done" });
    expect(run).toHaveBeenCalledWith("save_status", { status: "interview", complete: true });
  } finally { await mcp.close(); }
});
