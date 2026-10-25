import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
import type { FoundJob } from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSeed } from "../workspace-service.test-fixtures";
import { createResumeService, type ResumeServiceDeps } from "./resume-service";

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
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description:
      "Own the design system across web and mobile. Partner with engineering on React components, run research, lead accessibility reviews and mentor designers. Figma, prototyping, design tokens and usability testing every week. ".repeat(
        3,
      ),
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(overrides: Partial<ResumeServiceDeps> = {}) {
  const store: JobStore = openJobStore(":memory:");
  const seed = createSeed();
  const renderResumeArtifact = vi.fn(() =>
    Promise.resolve({
      format: "pdf" as const,
      fileName: "resume.pdf",
      storagePath: "/exports/resume.pdf",
      pageCount: 1,
      warnings: [],
    }),
  );
  const service = createResumeService({
    store,
    aiClient: createDeterministicJobFinderAiClient(),
    documentManager: {
      listResumeTemplates: () => [],
      renderResumeArtifact: renderResumeArtifact as never,
      renderResumePreview: vi.fn(),
    },
    readInputs: () =>
      Promise.resolve({
        profile: seed.profile,
        searchPreferences: seed.searchPreferences,
        settings: seed.settings,
      }),
    fetchListingHtml: () => Promise.reject(new Error("offline")),
    ...overrides,
  });
  cleanups.push(() => {
    service.stop();
    store.close();
  });
  const [id] = store.saveFoundJobs({ searchId: null, jobs: [found(1)] }).added;
  service.start();
  return { store, service, id: id!, renderResumeArtifact };
}

const stageOf = (store: JobStore, id: number) => store.getJob(id)?.stage;

describe("resumes on the store", () => {
  it("writes a resume the moment a job is shortlisted, and approving it hands the job to Apply", async () => {
    const { store, service, id } = setup();
    expect(service.get(id).resume).toBeNull();

    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    expect(service.get(id).resume?.draft?.sections.length).toBeGreaterThan(0);

    const approved = await service.approve(id);
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.pdfPath).toBe("/exports/resume.pdf");
    expect(stageOf(store, id)).toBe("resume");
  });

  it("puts an approved resume back, approval included, when a level change is undone", async () => {
    const { store, service, id } = setup();
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    await service.approve(id);
    const level = service.get(id).resume!.level;

    const changed = service.setLevel(id, "aggressive");
    expect(changed.approvedAt).toBeNull();
    expect(changed.previousLevel).toBe(level);
    expect(stageOf(store, id)).toBe("shortlisted");

    const undone = service.undoLevel(id);
    expect(undone.level).toBe(level);
    expect(undone.approvedAt).not.toBeNull();
    expect(stageOf(store, id)).toBe("resume");
  });

  it("stops writing when the job is moved back to Find jobs, and writes again if it returns", async () => {
    const aiClient = createDeterministicJobFinderAiClient();
    let started = 0;
    const slowClient = {
      ...aiClient,
      createResumeDraft: (
        input: Parameters<typeof aiClient.createResumeDraft>[0],
      ) => {
        started += 1;
        return new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(new DOMException("Stopped", "AbortError")),
          );
        });
      },
    };
    const { store, service, id } = setup({ aiClient: slowClient as never });
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() =>
      expect(service.get(id).resume?.state).toBe("writing"),
    );

    store.moveJobs({ selection: { ids: [id] }, to: "found" });
    await vi.waitFor(() =>
      expect(service.get(id).resume?.state).toBe("queued"),
    );

    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(started).toBe(2));
  });

  it("says why a resume could not be written, and writes it again on request", async () => {
    const aiClient = createDeterministicJobFinderAiClient();
    let fail = true;
    const flaky = {
      ...aiClient,
      createResumeDraft: (
        input: Parameters<typeof aiClient.createResumeDraft>[0],
      ) =>
        fail
          ? Promise.reject(new Error("The model returned nothing."))
          : aiClient.createResumeDraft(input),
    };
    const { store, service, id } = setup({ aiClient: flaky as never });
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() =>
      expect(service.get(id).resume?.state).toBe("failed"),
    );
    expect(service.get(id).resume?.error).toContain(
      "The model returned nothing.",
    );

    fail = false;
    service.rewrite(id);
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
  });
});
