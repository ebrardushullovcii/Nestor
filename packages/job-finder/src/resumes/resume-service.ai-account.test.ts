import {
  AI_ACCESS_MESSAGES,
  createDeterministicJobFinderAiClient,
  ModelRequestHttpError,
  type AiAccessStatus,
} from "@nestor/ai-providers";
import {
  NESTOR_REQUEST_REJECTED_MESSAGE,
  type FoundJob,
} from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiAccessWatch } from "../internal/ai-access-watch";
import { createSeed } from "../test-fixtures";
import { createResumeService } from "./resume-service";

function found(n: number): FoundJob {
  return {
    title: `Senior Product Designer ${n}`,
    company: `Signal Systems ${n}`,
    location: "Remote",
    workModes: ["remote"],
    url: `https://board.example.test/jobs/${n}`,
    applyUrl: null,
    sourceId: "board",
    sourceLabel: "Example Board",
    sourceJobId: String(n),
    facts: { fullListingRead: true },
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description:
      "Own the design system across web and mobile. Partner with engineering on React components, run research, lead accessibility reviews and mentor designers. ".repeat(
        3,
      ),
  };
}

/** The AI account as the scripted provider leaves it, driven by the test. */
function scriptedAccess() {
  let status: AiAccessStatus = "unknown";
  const changes = new Set<(status: AiAccessStatus) => void>();
  const rechecks: Array<() => boolean> = [];
  const watch: AiAccessWatch = {
    status: () => status,
    onChange: (listener) => {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    onRefused: () => () => undefined,
    onRecheck: (recheck) => {
      rechecks.push(recheck);
      return () => rechecks.splice(rechecks.indexOf(recheck), 1);
    },
    letCallsThrough: vi.fn(),
  };
  return {
    watch,
    set(next: AiAccessStatus) {
      status = next;
      for (const listener of changes) listener(next);
    },
    recheck: () => rechecks.some((recheck) => recheck()),
  };
}

/** What the provider said when the account ran out of credit (synthetic link). */
const outOfCredit = () =>
  new Error("The AI could not write this resume.", {
    cause: new ModelRequestHttpError(
      "Insufficient balance. Top up at https://model.example.test/console/account-test/billing?credits=1.",
      402,
      null,
    ),
  });

const stores: JobStore[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const store of stores.splice(0)) store.close();
});

function setup(input: {
  store?: JobStore;
  writes: Array<"refused" | "busy" | "invalid" | "ok">;
  access: ReturnType<typeof scriptedAccess>;
  jobs?: number;
}) {
  const store = input.store ?? openJobStore(":memory:");
  if (!input.store) stores.push(store);
  const seed = createSeed();
  const base = createDeterministicJobFinderAiClient();
  const writes = [...input.writes];
  const createResumeDraft = vi.fn(
    (request: Parameters<typeof base.createResumeDraft>[0]) => {
      const next = writes.shift() ?? "ok";
      if (next === "refused") return Promise.reject(outOfCredit());
      if (next === "invalid")
        return Promise.reject(
          new Error("The AI could not write this resume.", {
            cause: new ModelRequestHttpError(
              "Request schema rejected",
              422,
              null,
            ),
          }),
        );
      if (next === "busy")
        return Promise.reject(
          new Error("The AI could not write this resume.", {
            cause: new ModelRequestHttpError("Overloaded", 503, null),
          }),
        );
      return base.createResumeDraft(request);
    },
  );
  const service = createResumeService({
    store,
    aiClient: { ...base, createResumeDraft },
    aiAccess: input.access.watch,
    documentManager: {
      listResumeTemplates: () => [],
      renderResumeArtifact: vi.fn() as never,
      renderResumePreview: vi.fn(),
    },
    readInputs: () =>
      Promise.resolve({
        profile: seed.profile,
        searchPreferences: seed.searchPreferences,
        settings: seed.settings,
      }),
  });
  stops.push(() => service.stop());
  const ids = input.store
    ? []
    : store.saveFoundJobs({
        searchId: null,
        jobs: Array.from({ length: input.jobs ?? 1 }, (_, n) => found(n + 1)),
      }).added;
  service.start();
  return { store, service, ids, createResumeDraft };
}

const waitFor = (assertion: () => void) =>
  vi.waitFor(assertion, { timeout: 5_000 });

describe("resumes when the AI account refuses calls", () => {
  it("keeps Nestor's rejected resume request queued until restart", async () => {
    const access = scriptedAccess();
    const { store, service, ids, createResumeDraft } = setup({
      access,
      writes: ["invalid", "ok"],
    });
    const [id] = ids as [number];
    store.moveJobs({ selection: { ids }, to: "shortlisted" });
    await waitFor(() =>
      expect(service.get(id).resume).toMatchObject({
        state: "queued",
        error: NESTOR_REQUEST_REJECTED_MESSAGE,
      }),
    );
    access.set("available");
    expect(access.recheck()).toBe(false);
    expect(createResumeDraft).toHaveBeenCalledOnce();
    service.stop();
    service.start();
    await waitFor(() =>
      expect(service.get(id).resume).toMatchObject({
        state: "ready",
        error: null,
      }),
    );
    expect(createResumeDraft).toHaveBeenCalledTimes(2);
  });
  it("says the account ran out of credit, waits without failing the queue, and writes the resume by itself once calls go through", async () => {
    const access = scriptedAccess();
    const { store, service, ids, createResumeDraft } = setup({
      access,
      writes: ["refused"],
      jobs: 2,
    });
    const [first, second] = ids as [number, number];
    store.moveJobs({ selection: { ids: [first] }, to: "shortlisted" });
    await waitFor(() =>
      expect(service.get(first).resume?.state).toBe("failed"),
    );
    expect(service.get(first).resume?.error).toBe(AI_ACCESS_MESSAGES.funding);

    // The transport reported the refusal: new writes wait in the queue.
    access.set("blocked");
    store.moveJobs({ selection: { ids: [second] }, to: "shortlisted" });
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(createResumeDraft).toHaveBeenCalledOnce();
    expect(service.get(second).resume?.state ?? "queued").toBe("queued");

    // Calls go through again: each waiting resume is written once.
    access.set("available");
    await waitFor(() => {
      expect(service.get(first).resume?.state).toBe("ready");
      expect(service.get(second).resume?.state).toBe("ready");
    });
    expect(createResumeDraft).toHaveBeenCalledTimes(3);
    access.set("available");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(createResumeDraft).toHaveBeenCalledTimes(3);
  });

  it("checks with one waiting resume while the account still refuses", async () => {
    const access = scriptedAccess();
    const { store, service, ids, createResumeDraft } = setup({
      access,
      writes: ["refused", "refused"],
      jobs: 1,
    });
    store.moveJobs({ selection: { ids }, to: "shortlisted" });
    await waitFor(() =>
      expect(service.get(ids[0]!).resume?.state).toBe("failed"),
    );
    access.set("blocked");
    expect(access.recheck()).toBe(true);
    await waitFor(() => expect(createResumeDraft).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(service.get(ids[0]!).resume?.error).toBe(
        AI_ACCESS_MESSAGES.funding,
      ),
    );
  });

  it("keeps an ordinary outage a retry: the resume is never failed or handed to the person", async () => {
    const access = scriptedAccess();
    const { store, service, ids } = setup({ access, writes: ["busy"] });
    store.moveJobs({ selection: { ids }, to: "shortlisted" });
    await waitFor(() =>
      expect(service.get(ids[0]!).resume?.state).toBe("queued"),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(service.get(ids[0]!).resume?.state).not.toBe("failed");
    expect(service.get(ids[0]!).resume?.error ?? null).toBeNull();
  });

  it("writes a resume an earlier run left failed for the account at the next start", async () => {
    const store = openJobStore(":memory:");
    stores.push(store);
    const [id] = store.saveFoundJobs({
      searchId: null,
      jobs: [found(9)],
    }).added as [number];
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    // How the earlier version recorded the refusal.
    store
      .sql(
        `INSERT INTO resumes (job_id, level, state, updated_at, error)
         VALUES (?, 'tailored', 'failed', ?, ?)`,
      )
      .run(
        id,
        Date.now(),
        "The AI service is unavailable right now. Nothing was changed. Try again after the service is restored.",
      );
    const access = scriptedAccess();
    const { service } = setup({ store, access, writes: ["ok"] });
    await waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
  });
});
