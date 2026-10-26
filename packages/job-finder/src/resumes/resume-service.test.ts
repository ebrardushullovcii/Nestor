import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FoundJob } from "@nestor/contracts";
import {
  createResumeStore,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
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
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(
  overrides: Partial<ResumeServiceDeps> = {},
  filePath = ":memory:",
) {
  const store: JobStore = openJobStore(filePath);
  const seed = createSeed();
  const renderResumeArtifact = vi.fn(() =>
    Promise.resolve({
      format: "pdf" as const,
      fileName: "resume.pdf",
      storagePath: "/exports/resume.pdf",
      sha256: "a".repeat(64),
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
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    service.stop();
    store.close();
  };
  cleanups.push(close);
  const [id] = store.saveFoundJobs({ searchId: null, jobs: [found(1)] }).added;
  service.start();
  return { store, service, id: id!, renderResumeArtifact, close };
}

const stageOf = (store: JobStore, id: number) => store.getJob(id)?.stage;

describe("resumes on the store", () => {
  it("edits one summary without reproducing or dropping the rest, with an exact Undo", async () => {
    const { store, service, id } = setup();
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    const before = service.get(id).resume!;
    const summary = before.draft!.sections.find(
      (section) => section.kind === "summary",
    )!;
    const edit = service.edit({
      jobId: id,
      expectedUpdatedAt: before.updatedAt,
      sections: [{ id: summary.id, fields: { text: "My exact summary." } }],
    });
    expect(edit.draft).toEqual({
      ...before.draft,
      sections: before.draft!.sections.map((section) =>
        section.id === summary.id
          ? { ...section, text: "My exact summary." }
          : section,
      ),
    });
    expect(service.undoChange(id, edit.undoId!).draft).toEqual(before.draft);
  });

  it("rejects partial full-draft saves and nonexistent edit targets without changing the resume", async () => {
    const { store, service, id } = setup();
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    const before = service.get(id).resume!;
    expect(() =>
      service.saveDraft(
        id,
        { ...before.draft!, sections: [] },
        before.updatedAt,
      ),
    ).toThrow("remove existing resume content");
    expect(() =>
      service.edit({
        jobId: id,
        expectedUpdatedAt: before.updatedAt,
        sections: [{ id: "missing", fields: { text: "No" } }],
      }),
    ).toThrow("no longer exists");
    expect(service.get(id).resume).toEqual(before);
  });
  it("keeps edit Undo and its previous approval, PDF and stage after reopening the store", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "resume-undo-"));
    cleanups.unshift(() => rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "jobs.sqlite");
    const { store, service, id, close } = setup({}, filePath);
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    const firstApproval = await service.approve(id);
    service.undoChange(id, firstApproval.undoId!);
    expect(store.getJob(id)?.stage).toBe("shortlisted");
    expect(service.get(id).resume?.approvedAt).toBeNull();
    await service.approve(id);
    const before = service.get(id).resume!;
    const edited = service.saveDraft(
      id,
      { ...before.draft!, targetPageCount: 3 },
      before.updatedAt,
    );
    expect(store.getJob(id)?.stage).toBe("shortlisted");
    expect(createResumeStore(store).pdfPathsInUse()).toContain(before.pdfPath);
    close();
    const reopened = openJobStore(filePath);
    cleanups.push(() => reopened.close());
    const restored = createResumeStore(reopened).undoChange(id, edited.undoId!);
    expect(restored).toMatchObject({
      draft: before.draft,
      approvedAt: before.approvedAt,
      pdfPath: before.pdfPath,
      pdfSha256: before.pdfSha256,
    });
    expect(reopened.getJob(id)?.stage).toBe("resume");
  });

  it("refuses an older edit Undo after another save or a later job move", async () => {
    const { store, service, id } = setup();
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    const before = service.get(id).resume!;
    const first = service.saveDraft(
      id,
      { ...before.draft!, targetPageCount: 1 },
      before.updatedAt,
    );
    const next = service.saveDraft(
      id,
      { ...before.draft!, targetPageCount: 3 },
      first.updatedAt,
    );
    expect(() => service.undoChange(id, first.undoId!)).toThrow(
      "changed since",
    );
    expect(service.get(id).resume?.draft?.targetPageCount).toBe(3);
    store.setStage([id], "applied");
    expect(() => service.undoChange(id, next.undoId!)).toThrow("changed since");
    expect(store.getJob(id)?.stage).toBe("applied");
  });

  it("does not approve a draft edited while its PDF is rendering", async () => {
    const { store, service, id, renderResumeArtifact } = setup();
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    const before = service.get(id).resume!;
    renderResumeArtifact.mockImplementationOnce(() => {
      service.saveDraft(
        id,
        { ...before.draft!, targetPageCount: 3 },
        before.updatedAt,
      );
      return Promise.resolve({
        format: "pdf",
        fileName: "resume.pdf",
        storagePath: "/exports/stale.pdf",
        sha256: "a".repeat(64),
        pageCount: 1,
        warnings: [],
      });
    });
    await expect(service.approve(id)).rejects.toThrow("changed since");
    expect(service.get(id).resume).toMatchObject({
      approvedAt: null,
      draft: { targetPageCount: 3 },
    });
    expect(store.getJob(id)?.stage).toBe("shortlisted");
  });
  it("keeps each level Undo bound to its own change after writing finishes", async () => {
    const { store, service, id } = setup();
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    const original = service.get(id).resume!.level;
    const first = service.setLevel(id, "aggressive");
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    expect(service.undoLevel(id, first.levelChangeId!)).toMatchObject({
      level: original,
    });
    const second = service.setLevel(id, "light");
    service.setLevel(id, "aggressive");
    expect(() => service.undoLevel(id, second.levelChangeId!)).toThrow(
      "changed since",
    );
    expect(service.get(id).resume?.level).toBe("aggressive");
  });

  it("keeps a later editor save when an older level change is undone", async () => {
    const { store, service, id } = setup();
    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    const changed = service.setLevel(id, "light");
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    const current = service.get(id).resume!;
    const { undoId: _undoId, ...saved } = service.saveDraft(
      id,
      current.draft!,
      current.updatedAt,
    );
    expect(_undoId).not.toBeNull();
    expect(() => service.undoLevel(id, changed.levelChangeId!)).toThrow(
      "changed since",
    );
    expect(service.get(id).resume).toEqual(saved);
  });

  it("writes a resume the moment a job is shortlisted, and approving it hands the job to Apply", async () => {
    const { store, service, id } = setup();
    expect(service.get(id).resume).toBeNull();

    store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    await vi.waitFor(() => expect(service.get(id).resume?.state).toBe("ready"));
    expect(service.get(id).resume?.draft?.sections.length).toBeGreaterThan(0);

    const approved = await service.approve(id);
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.pdfPath).toBe("/exports/resume.pdf");
    expect(approved.pdfSha256).toBe("a".repeat(64));
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
    expect(undone.pdfSha256).toBe("a".repeat(64));
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
