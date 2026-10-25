import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
vi.mock("../job-finder/start-apply-batch", () => ({}));
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

import {
  ResumeExportArtifactSummarySchema,
} from "@nestor/contracts";
import type { JobFinderWorkspaceService } from "@nestor/job-finder";
import { getJobFinderRepositoryForWorkspaceService } from "../job-finder/create-workspace-service";
import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import { getJobFinderWorkspaceService } from "../job-finder/workspace-service";
import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { createAssistantBrowserPort } from "./assistant-browser-port";
import { createAssistantHostPorts } from "./assistant-ports";

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.mocked(getJobFinderRepositoryForWorkspaceService).mockReturnValue(null);
});

async function approvedResume() {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  directory = await mkdtemp(path.resolve(".tmp/approved-resume-"));
  const filePath = path.join(directory, "approved.pdf");
  const bytes = Buffer.from("Synthetic approved resume PDF");
  await writeFile(filePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const approvedAt = "2026-10-01T10:00:00.000Z";
  const exported = ResumeExportArtifactSummarySchema.parse({
    id: "export_approved",
    draftId: "draft_1",
    jobId: "job_1",
    isApproved: true,
    filePath,
    sha256,
    format: "pdf",
    templateId: "classic_ats",
    exportedAt: approvedAt,
  });
  const draft = {
    id: "draft_1",
    jobId: "job_1",
    status: "approved",
    approvedAt,
    approvedExportId: exported.id,
  };
  const exports = [
    exported,
    {
      ...exported,
      id: "newer_unapproved",
      isApproved: false,
      sha256: "b".repeat(64),
      exportedAt: "2026-10-01T11:00:00.000Z",
    },
  ];
  const getResumeWorkspace = vi.fn(() => Promise.resolve({ draft, exports }));
  const getWorkspaceSnapshot = vi.fn(() => {
    throw new Error("Canonical reads are forbidden for assistant documents");
  });
  const getWorkspaceProjection = vi.fn(() =>
    Promise.resolve({
      profile: { baseResume: {} },
      resumeDrafts: [draft],
      resumeExportArtifacts: exports,
      reviewQueue: [
        {
          jobId: "job_1",
          title: "Engineer",
          company: "Cedar",
          resumeReview: {
            status: "approved",
            approvedAt,
            approvedFilePath: filePath,
          },
        },
      ],
    }),
  );
  const service = {
    getWorkspaceSnapshot,
    getWorkspaceProjection,
    getResumeWorkspace,
  } as unknown as JobFinderWorkspaceService;
  vi.mocked(getJobFinderWorkspaceService).mockResolvedValue(service);
  return {
    ports: createAssistantHostPorts({ browserHost: "external" }),
    filePath,
    bytes,
    sha256,
    exported,
    getResumeWorkspace,
    getWorkspaceSnapshot,
    getWorkspaceProjection,
  };
}

describe("assistant approved resume files", () => {
  async function thousandApprovedResumes() {
    const fixture = await approvedResume();
    const approvedAt = "2026-10-01T10:00:00.000Z";
    const exports = Array.from({ length: 1_000 }, (_, index) => ({
      ...fixture.exported,
      id: `export_${index}`,
      draftId: `draft_${index}`,
      jobId: `job_${index}`,
    }));
    // Shared synthetic bytes keep this a metadata/lookup test, without
    // creating a thousand files or hiding unselected reads behind failures.
    const service = {
      getWorkspaceSnapshot: fixture.getWorkspaceSnapshot,
      getWorkspaceProjection: () =>
        Promise.resolve({
          profile: {
            baseResume: {
              id: "original",
              storagePath: fixture.filePath,
              sha256: fixture.sha256,
              fileName: "original.pdf",
              uploadedAt: approvedAt,
            },
          },
          resumeDrafts: exports.map((artifact) => ({
            id: artifact.draftId,
            jobId: artifact.jobId,
            status: "approved",
            approvedAt,
            approvedExportId: artifact.id,
          })),
          resumeExportArtifacts: exports,
          reviewQueue: exports.map((artifact) => ({
            jobId: artifact.jobId,
            title: "Engineer",
            company: "Cedar",
            resumeReview: {
              status: "approved",
              approvedAt,
              approvedFilePath: fixture.filePath,
            },
          })),
        }),
    } as unknown as JobFinderWorkspaceService;
    vi.mocked(getJobFinderWorkspaceService).mockResolvedValue(service);
    return fixture;
  }

  it("lists 1,000 approved resumes using metadata without reading file contents", async () => {
    const { ports, sha256, bytes, getWorkspaceSnapshot } =
      await thousandApprovedResumes();
    const documents = await ports.listDocuments();
    expect(documents).toHaveLength(1_001);
    expect(documents[0]).toMatchObject({
      id: "original_resume",
      byteSize: bytes.length,
      sha256,
    });
    expect(documents.at(-1)).toMatchObject({
      id: "approved_resume_job_999",
      byteSize: bytes.length,
      sha256,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it.each(["original_resume", "approved_resume_job_999"])(
    "reads only the requested file when resolving %s among 1,000 approved jobs",
    async (documentId) => {
      const { ports, filePath, bytes } = await thousandApprovedResumes();
      const file = await ports.loadDocumentFile(documentId);
      expect(file.bytes).toEqual(Uint8Array.from(bytes));
      expect(readFile).toHaveBeenCalledExactlyOnceWith(filePath);
      expect(stat).toHaveBeenCalledTimes(1);
    },
  );

  it("uses the approved export's persisted digest and refuses changed disk bytes", async () => {
    const { ports, filePath, bytes, sha256, getResumeWorkspace } =
      await approvedResume();
    expect(
      (await ports.listDocuments()).find(
        (asset) => asset.id === "approved_resume_job_1",
      )?.sha256,
    ).toBe(sha256);
    expect(getResumeWorkspace).not.toHaveBeenCalled();
    expect(
      (await ports.loadDocumentFile("approved_resume_job_1")).bytes,
    ).toEqual(Uint8Array.from(bytes));
    await writeFile(filePath, "Changed, unapproved synthetic resume");
    expect(
      (await ports.listDocuments()).find(
        (asset) => asset.id === "approved_resume_job_1",
      )?.sha256,
    ).toBe(sha256);
    await expect(
      ports.loadDocumentFile("approved_resume_job_1"),
    ).rejects.toThrow(/changed/);
    expect(getResumeWorkspace).not.toHaveBeenCalled();
  });

  it("refuses an approved export without a saved digest", async () => {
    const { ports, exported } = await approvedResume();
    exported.sha256 = null;
    await expect(
      ports.loadDocumentFile("approved_resume_job_1"),
    ).rejects.toThrow();
  });
});

describe("assistant interactive workspace reads", () => {


  it("reads the original resume text from the stored profile without projecting the workspace", async () => {
    const profile = createEmptyJobFinderRepositoryState().profile;
    profile.baseResume.textContent = "Synthetic original resume text.";
    const getProfile = vi.fn().mockResolvedValue(profile);
    vi.mocked(getJobFinderRepositoryForWorkspaceService).mockReturnValue({
      getProfile,
    } as unknown as NonNullable<
      ReturnType<typeof getJobFinderRepositoryForWorkspaceService>
    >);
    const getWorkspaceSnapshot = vi.fn();
    const getWorkspaceProjection = vi.fn();
    vi.mocked(getJobFinderWorkspaceService).mockResolvedValue({
      getWorkspaceSnapshot,
      getWorkspaceProjection,
    } as unknown as JobFinderWorkspaceService);
    const ports = createAssistantHostPorts({ browserHost: "external" });
    await expect(ports.readDocumentText("original_resume")).resolves.toBe(
      profile.baseResume.textContent,
    );
    expect(getProfile).toHaveBeenCalledTimes(1);
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(getWorkspaceProjection).not.toHaveBeenCalled();
  });

  it("gives the browser lease the full main projection rather than a renderer row or canonical snapshot", async () => {
    const view = {
      applyJobResults: [
        {
          id: "prepared-result",
          applicationRecordId: "application",
          state: "awaiting_review",
        },
      ],
    };
    const getWorkspaceProjection = vi.fn().mockResolvedValue(view);
    const getWorkspaceSnapshot = vi.fn();
    vi.mocked(getJobFinderWorkspaceService).mockResolvedValue({
      getWorkspaceSnapshot,
      getWorkspaceProjection,
    } as unknown as JobFinderWorkspaceService);
    createAssistantHostPorts({ browserHost: "embedded" });
    const readWorkspace = vi
      .mocked(createAssistantBrowserPort)
      .mock.calls.at(-1)![1];
    await expect(readWorkspace()).resolves.toBe(view);
    expect(getWorkspaceProjection).toHaveBeenCalledTimes(1);
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
  });
});

it("R3-169 minimizes Browser before app navigation without closing or reloading tabs", async () => {
  const command = vi.fn(() => Promise.resolve());
  vi.mocked(getEmbeddedBrowser).mockReturnValue({
    command,
  } as unknown as ReturnType<typeof getEmbeddedBrowser>);
  const ports = createAssistantHostPorts({ browserHost: "embedded" });
  await ports.prepareAppNavigation?.();
  expect(command).toHaveBeenCalledExactlyOnceWith({ type: "minimize" });
});
