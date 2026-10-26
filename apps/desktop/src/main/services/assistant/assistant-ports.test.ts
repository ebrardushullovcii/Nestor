import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    stat: vi.fn(actual.stat),
  };
});

vi.mock("electron", () => ({ app: {} }));
vi.mock("../../adapters/resume-document", () => ({
  extractResumeDocument: vi.fn(),
}));
vi.mock("../../routes/job-finder", () => ({}));
vi.mock("../browser/embedded-browser", () => ({ getEmbeddedBrowser: vi.fn() }));
vi.mock("../job-finder/candidate-asset-library-instance", () => ({
  getCandidateAssetLibrary: () => ({
    list: () => Promise.resolve({ assets: [] }),
    resolveForApplication: () => Promise.reject(new Error("Unknown document")),
  }),
}));
vi.mock("../job-finder/create-workspace-service", () => ({
  getJobFinderRepositoryForWorkspaceService: vi.fn(),
}));
vi.mock("../job-finder/import-resume", () => ({
  importResumeFromSourcePath: vi.fn(),
  isDesktopResumeImportActive: () => false,
}));
vi.mock("../job-finder/paths", () => ({
  getJobFinderUserDataDirectory: () => path.resolve(".tmp"),
}));
vi.mock("../job-finder/test-api", () => ({
  isDesktopTestApiEnabled: () => false,
}));
vi.mock("../job-finder/workspace-updates", () => ({
  publishJobFinderWorkspaceUpdate: vi.fn(),
}));
vi.mock("../job-finder/workspace-service", () => ({
  getJobFinderWorkspaceService: vi.fn(),
}));
vi.mock("./assistant-browser-port", () => ({
  createAssistantBrowserPort: vi.fn(),
}));

import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import { getJobFinderWorkspaceService } from "../job-finder/workspace-service";
import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { createAssistantBrowserPort } from "./assistant-browser-port";
import { createAssistantHostPorts } from "./assistant-ports";
import {
  readAssistantPersonalState,
  runAssistantReadCommand,
} from "./store-reads";

vi.mock("./store-reads", () => ({
  readAssistantPersonalState: vi.fn(),
  runAssistantReadCommand: vi.fn(),
}));
vi.mock("./app-commands", () => ({ assistantAppCommands: () => [] }));
vi.mock("../job-commands", () => ({ runJobCommand: vi.fn() }));

let directory: string | null = null;
afterEach(async () => {
  if (directory) {
    expect(directory.startsWith(path.resolve(".tmp") + path.sep)).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
  directory = null;
  vi.clearAllMocks();
});

async function approvedResume() {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  directory = await mkdtemp(path.resolve(".tmp/approved-resume-"));
  const filePath = path.join(directory, "approved.pdf");
  const bytes = Buffer.from("Synthetic approved resume PDF");
  await writeFile(filePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const initial = createEmptyJobFinderRepositoryState();
  initial.profile.baseResume = {
    ...initial.profile.baseResume,
    storagePath: filePath,
    sha256,
    fileName: "original.pdf",
    uploadedAt: "2026-10-01T10:00:00.000Z",
  };
  vi.mocked(readAssistantPersonalState).mockResolvedValue({
    profile: initial.profile,
    searchPreferences: initial.searchPreferences,
    settings: initial.settings,
    profileSetupState: initial.profileSetupState,
    activityControl: initial.activityControl,
    latestResumeImportRun: null,
    latestResumeImportReviewCandidates: [],
    latestResumeImportBundle: null,
    resumeImportActive: false,
    enabledSiteCount: 0,
    availableResumeTemplates: [],
    generatedAt: "2026-10-01T10:00:00.000Z",
  });
  const resume = {
    approvedAt: "2026-10-01T10:00:00.000Z",
    state: "ready",
    pdfPath: filePath,
    pdfSha256: sha256,
  };
  vi.mocked(runAssistantReadCommand).mockImplementation(((
    name: string,
    input: { jobId?: number },
  ) =>
    Promise.resolve(
      name === "list_shortlisted"
        ? {
            rows: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })),
            total: 1000,
          }
        : {
            job: { id: input.jobId, title: "Engineer", company: "Cedar" },
            resume,
          },
    )) as typeof runAssistantReadCommand);
  return {
    ports: createAssistantHostPorts({ browserHost: "external" }),
    filePath,
    bytes,
    sha256,
    resume,
    profile: initial.profile,
  };
}

describe("Assistant store-backed resume files", () => {
  it("lists every approved PDF's metadata, a page at a time, without reading file contents", async () => {
    const { ports } = await approvedResume();
    const documents = await ports.listDocuments();
    expect(documents).toHaveLength(51);
    expect(runAssistantReadCommand).toHaveBeenCalledWith("list_shortlisted", {
      stage: "resume",
      limit: 200,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(getJobFinderWorkspaceService).not.toHaveBeenCalled();
  });
  it.each(["original_resume", "approved_resume_1000"])(
    "resolves %s without scanning other approved jobs",
    async (documentId) => {
      const { ports, filePath, bytes } = await approvedResume();
      expect((await ports.loadDocumentFile(documentId)).bytes).toEqual(
        Uint8Array.from(bytes),
      );
      expect(readFile).toHaveBeenCalledExactlyOnceWith(filePath);
      expect(runAssistantReadCommand).not.toHaveBeenCalledWith(
        "list_shortlisted",
        expect.anything(),
      );
      if (documentId !== "original_resume")
        expect(runAssistantReadCommand).toHaveBeenCalledExactlyOnceWith(
          "get_resume",
          { jobId: 1000 },
        );
    },
  );
  it("uses the persisted approval digest and rejects changed bytes", async () => {
    const { ports, filePath, sha256 } = await approvedResume();
    await writeFile(filePath, "Changed and unapproved synthetic bytes");
    expect(
      (await ports.listDocuments()).find(
        (asset) => asset.id === "approved_resume_1",
      )?.sha256,
    ).toBe(sha256);
    await expect(ports.loadDocumentFile("approved_resume_1")).rejects.toThrow(
      /changed/,
    );
  });
  it("refuses an approved PDF without an approval digest", async () => {
    const { ports, resume } = await approvedResume();
    resume.pdfSha256 = "";
    await expect(ports.loadDocumentFile("approved_resume_1")).rejects.toThrow();
  });
  it("reads original text and exact browser work without a workspace runtime", async () => {
    const { ports, profile } = await approvedResume();
    profile.baseResume.textContent = "Synthetic text";
    expect(await ports.readDocumentText("original_resume")).toBe(
      "Synthetic text",
    );
    const expected = { application: { id: 7 } };
    vi.mocked(runAssistantReadCommand).mockResolvedValue(expected as never);
    createAssistantHostPorts({ browserHost: "embedded" });
    const read = vi.mocked(createAssistantBrowserPort).mock.calls.at(-1)![1];
    expect(await read(7)).toEqual(expected);
    expect(runAssistantReadCommand).toHaveBeenCalledWith(
      "get_application_details",
      { id: 7 },
    );
    expect(getJobFinderWorkspaceService).not.toHaveBeenCalled();
  });
});
it("minimizes Browser for navigation without closing tabs", async () => {
  const command = vi.fn(() => Promise.resolve());
  vi.mocked(getEmbeddedBrowser).mockReturnValue({
    command,
  } as unknown as ReturnType<typeof getEmbeddedBrowser>);
  await createAssistantHostPorts({
    browserHost: "embedded",
  }).prepareAppNavigation?.();
  expect(command).toHaveBeenCalledExactlyOnceWith({ type: "minimize" });
});
