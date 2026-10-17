import { JobPostingSchema } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import { createSearchCatalogTools } from "./job-search-catalog-tools";

const jobs = Array.from({ length: 60 }, (_, id) =>
  JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: String(id),
    canonicalUrl: `https://jobs.example.test/${id}`,
    title: `Engineer ${id}`,
    company: "Example",
    location: "Remote",
    workMode: ["remote"],
    discoveryMethod: "public_api",
    discoveredAt: "2026-09-20T10:00:00Z",
    applyPath: "unknown",
    easyApplyEligible: false,
    salaryText: null,
    summary: null,
    postedAt: id === 40 ? "2026-09-19T10:00:00Z" : null,
    description: "x".repeat(25_000),
    keySkills: [],
  }),
);
function harness() {
  const keep = vi.fn(() => true);
  const checkpoint = vi.fn(() => Promise.resolve());
  const onInspect = vi.fn();
  const tools = createSearchCatalogTools({ jobs, keep, checkpoint, onInspect });
  const call = (name: string, args: unknown, signal?: AbortSignal) =>
    tools
      .find((tool) => tool.definition.function.name === name)!
      .execute(JSON.stringify(args), {
        step: 1,
        ...(signal ? { signal } : {}),
      });
  return { call, keep, checkpoint, onInspect };
}

describe("public feed catalog tools", () => {
  test("only new catalog rows and description chunks count as progress", async () => {
    const { call } = harness();
    const expectProgress = async (
      name: string,
      args: unknown,
      progress: boolean,
    ) => {
      expect(await call(name, args)).toMatchObject({ kind: "ok", progress });
    };
    await expectProgress("list_catalog_jobs", {}, true);
    await expectProgress("list_catalog_jobs", {}, false);
    await expectProgress("list_catalog_jobs", { offset: 25 }, true);
    await expectProgress("list_catalog_jobs", { offset: 100 }, false);
    await expectProgress("read_catalog_job", { id: 0 }, true);
    await expectProgress("read_catalog_job", { id: 0 }, false);
    await expectProgress("read_catalog_job", { id: 0, offset: 12_000 }, true);
    await expectProgress("read_catalog_job", { id: 0, offset: 12_000 }, false);
    await expectProgress("read_catalog_job", { id: 0, offset: 30_000 }, false);
  });
  test("pages large catalogs, exposes dates honestly and reads bounded details", async () => {
    const { call } = harness();
    const first = await call("list_catalog_jobs", { sort: "recent" });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    const page = JSON.parse(first.content) as {
      total: number;
      nextOffset: number;
      jobs: { id: number; postedAt: string | null }[];
    };
    expect(page.total).toBe(60);
    expect(page.jobs).toHaveLength(25);
    expect(page.nextOffset).toBe(25);
    expect(page.jobs[0]?.id).toBe(40);
    expect(page.jobs[1]?.postedAt).toBeNull();
    const last = await call("list_catalog_jobs", { offset: 50 });
    if (last.kind !== "ok") throw new Error("Expected page");
    const lastPage = JSON.parse(last.content) as {
      nextOffset: number | null;
      jobs: unknown[];
    };
    expect(lastPage.nextOffset).toBeNull();
    expect(lastPage.jobs).toHaveLength(10);
    const detail = await call("read_catalog_job", { id: 40 });
    if (detail.kind !== "ok") throw new Error("Expected details");
    const parsed = JSON.parse(detail.content) as {
      description: string;
      nextOffset: number;
    };
    expect(parsed.description).toHaveLength(12_000);
    expect(parsed.nextOffset).toBe(12_000);
  });

  test("rejects invented, unread and malformed selections atomically", async () => {
    const { call, keep, checkpoint } = harness();
    for (const ids of [
      [0],
      [-1],
      [0.5],
      [900],
      ["0"],
      null,
      Array(101).fill(0),
    ]) {
      await call("save_catalog_jobs", { ids });
    }
    expect(keep).not.toHaveBeenCalled();
    await call("list_catalog_jobs", {});
    await call("save_catalog_jobs", { ids: [0, 900] });
    expect(keep).not.toHaveBeenCalled();
    await call("save_catalog_jobs", { ids: [0, 0, 1] });
    expect(keep).toHaveBeenCalledTimes(2);
    expect(keep).toHaveBeenCalledWith(jobs[0]);
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  test("cancellation prevents catalog writes", async () => {
    const { call, keep } = harness();
    await call("list_catalog_jobs", {});
    const controller = new AbortController();
    controller.abort();
    await expect(
      call("save_catalog_jobs", { ids: [0] }, controller.signal),
    ).rejects.toThrow();
    expect(keep).not.toHaveBeenCalled();
  });
});

test("records every read and preserves the model's catalog rejection reason", async () => {
  const { call, keep, onInspect } = harness();
  await call("list_catalog_jobs", {});
  expect(onInspect).toHaveBeenCalledTimes(25);
  await call("save_catalog_jobs", {
    ids: [0],
    rejected: [
      { id: 1, category: "role", reason: "Outside your requested roles." },
    ],
  });
  expect(keep).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceJobId: "1",
      searchRejection: {
        category: "role",
        reason: "Outside your requested roles.",
      },
    }),
  );
});
