import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationLetterGroundingError } from "@nestor/job-finder";
import { createResumeWorkspaceDemoState } from "../adapters/job-finder-demo-state";
import { CandidateAssetLibrary } from "../services/job-finder/candidate-asset-library";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  ApplicationDocumentRevisionSchema,
  ApplicationQuestionRecordSchema,
  ApplyJobResultSchema,
  ApplyRunDetailsSchema,
  ApplyRunSchema,
  type ApplicationDocumentRevision,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApplicationDocumentLibrary } from "../services/job-finder/application-document-library";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showSaveDialog: vi.fn() },
}));

vi.mock("../services/job-finder", () => ({
  getJobFinderWorkspaceService: vi.fn(),
}));
vi.mock("../services/job-finder/application-document-library-instance", () => ({
  getApplicationDocumentLibrary: vi.fn(),
}));

import { getJobFinderWorkspaceService } from "../services/job-finder";
import { getApplicationDocumentLibrary } from "../services/job-finder/application-document-library-instance";

import { registerApplicationDocumentRouteHandlers } from "./application-documents";

type RouteHandler = (
  event: IpcMainInvokeEvent,
  payload?: unknown,
) => Promise<unknown>;

const now = "2026-08-23T12:00:00.000Z";
const job = {
  id: "job-1",
  sourceJobId: "source-job-1",
  canonicalUrl: "https://jobs.example.com/job-1",
  title: "Staff Engineer",
  company: "Example",
};
const applicationA = { id: "application-a", jobId: job.id };
const applicationB = { id: "application-b", jobId: job.id };
const run = ApplyRunSchema.parse({
  id: "run-1",
  mode: "copilot",
  state: "paused_for_user_review",
  jobIds: [job.id],
  currentJobId: job.id,
  summary: "Questions captured",
  detail: "Preparation remains subject to review.",
  createdAt: now,
  updatedAt: now,
});
const resultB = ApplyJobResultSchema.parse({
  id: "result-b",
  runId: run.id,
  jobId: job.id,
  applicationRecordId: applicationB.id,
  state: "awaiting_review",
  summary: "Prepared",
  detail: "Final submission is not authorized.",
  startedAt: now,
  updatedAt: now,
});
const questionB = ApplicationQuestionRecordSchema.parse({
  id: "question-b",
  runId: run.id,
  jobId: job.id,
  applicationRecordId: applicationB.id,
  resultId: resultB.id,
  prompt: "Why are you interested in this role?",
  detectedAt: now,
});
const revision = ApplicationDocumentRevisionSchema.parse({
  id: "document-1",
  revision: 1,
  kind: "short_response",
  status: "proposed",
  createdAt: now,
  updatedAt: now,
  job: {
    jobId: job.id,
    applicationRecordId: applicationB.id,
    sourceJobId: job.sourceJobId,
    canonicalUrl: job.canonicalUrl,
    title: job.title,
    company: job.company,
    jobDigest: "a".repeat(64),
  },
  question: {
    runId: run.id,
    questionId: questionB.id,
    prompt: questionB.prompt,
  },
  content: "I am interested because my approved experience matches the role.",
  evidence: [
    {
      id: "profile.summary",
      source: "profile_summary",
      label: "Approved profile summary",
      text: "Experienced engineer.",
    },
  ],
  evidenceDigest: "b".repeat(64),
});

function createDetails(
  overrides: {
    run?: typeof run;
    result?: typeof resultB | null;
    question?: typeof questionB;
  } = {},
) {
  const selectedRun = overrides.run ?? run;
  const result = overrides.result === undefined ? resultB : overrides.result;
  const question = overrides.question ?? questionB;
  return ApplyRunDetailsSchema.parse({
    run: selectedRun,
    result,
    results: result ? [result] : [],
    questionRecords: [question],
  });
}

function register(
  details: ReturnType<typeof createDetails>,
  writeDocumentText?: () => Promise<string | null>,
  realLibrary?: ApplicationDocumentLibrary,
  refreshApprovedLetter?: (
    document: ApplicationDocumentRevision,
  ) => Promise<void>,
) {
  const handlers = new Map<string, RouteHandler>();
  const propose = vi
    .fn<ApplicationDocumentLibrary["propose"]>()
    .mockResolvedValue(revision);
  const getApplyRunDetails = vi.fn().mockResolvedValue(details);
  const ipcMain = {
    handle: vi.fn((channel: string, handler: RouteHandler) => {
      handlers.set(channel, handler);
    }),
  } as unknown as IpcMain;
  const snapshot = {
    profile: createResumeWorkspaceDemoState().profile,
    applyJobResults: details.result ? [details.result] : [],
    discoveryJobs: [
      { ...createResumeWorkspaceDemoState().savedJobs[0], ...job },
    ],
    applicationRecords: [applicationA, applicationB],
  } as unknown as JobFinderWorkspaceSnapshot;

  const getWorkspaceProjection = vi.fn(() => Promise.resolve(snapshot));
  const library =
    realLibrary ??
    ({
      propose,
      approve: vi.fn(() =>
        Promise.resolve(
          ApplicationDocumentRevisionSchema.parse({
            ...revision,
            status: "approved",
            approvedAt: now,
          }),
        ),
      ),
      list: vi.fn(() =>
        Promise.resolve({ documents: [], approvedRevisions: [] }),
      ),
    } as unknown as ApplicationDocumentLibrary);
  registerApplicationDocumentRouteHandlers(ipcMain, {
    library,
    getWorkspaceProjection,
    getApplyRunDetails,
    selectExportPath: () => Promise.resolve(null),
    ...(writeDocumentText ? { writeDocumentText } : {}),
    ...(refreshApprovedLetter ? { refreshApprovedLetter } : {}),
  });

  return {
    handler: handlers.get("job-finder:propose-application-document")!,
    listHandler: handlers.get("job-finder:list-application-documents")!,
    approveHandler: handlers.get("job-finder:approve-application-document")!,
    propose,
    getApplyRunDetails,
    getWorkspaceProjection,
    snapshot,
    library,
  };
}

const payload = {
  kind: "short_response",
  jobId: job.id,
  applicationRecordId: applicationB.id,
  question: { runId: run.id, questionId: questionB.id },
};

it("uses the main projection for selected document listing and proposal without a canonical read", async () => {
  const details = createDetails();
  details.result!.reviewCard = {
    siteLabel: "Synthetic",
    pageUrl: null,
    preparedAt: now,
    answers: [],
    attachments: [],
    letter: { text: "Selected application's letter.", groundedIn: ["profile"] },
    waitingOnYou: [],
  };
  const fixture = register(details);
  fixture.snapshot.applyJobResults.unshift({
    ...details.result!,
    id: "newer-sibling-result",
    applicationRecordId: applicationA.id,
    updatedAt: "2026-08-23T12:05:00.000Z",
    reviewCard: {
      ...details.result!.reviewCard,
      letter: {
        text: "Sibling application's letter.",
        groundedIn: ["profile"],
      },
    },
  });
  const getWorkspaceSnapshot = vi.fn(() => {
    throw new Error(
      "Canonical read is forbidden in interactive document routes",
    );
  });
  const writeApplicationDocumentText = vi
    .fn()
    .mockResolvedValue("Model draft.");
  vi.mocked(getJobFinderWorkspaceService).mockResolvedValue({
    getWorkspaceSnapshot,
    getWorkspaceProjection: fixture.getWorkspaceProjection,
    getApplyRunDetails: fixture.getApplyRunDetails,
    writeApplicationDocumentText,
  } as unknown as Awaited<ReturnType<typeof getJobFinderWorkspaceService>>);
  vi.mocked(getApplicationDocumentLibrary).mockReturnValue(fixture.library);
  const handlers = new Map<string, RouteHandler>();
  registerApplicationDocumentRouteHandlers({
    handle: (channel: string, handler: RouteHandler) =>
      handlers.set(channel, handler),
  } as unknown as IpcMain);
  const event = { sender: {} } as IpcMainInvokeEvent;

  await handlers.get("job-finder:list-application-documents")!(event, {
    jobId: job.id,
    applicationRecordId: applicationB.id,
  });
  expect(fixture.propose).toHaveBeenLastCalledWith(
    expect.objectContaining({
      writtenContent: "Selected application's letter.",
      grounding: {
        profile: fixture.snapshot.profile,
        job: fixture.snapshot.discoveryJobs[0],
        applicationRecord: applicationB,
        question: null,
      },
    }),
  );
  await handlers.get("job-finder:propose-application-document")!(
    event,
    payload,
  );
  expect(fixture.propose).toHaveBeenLastCalledWith(
    expect.objectContaining({
      writtenContent: "Model draft.",
      grounding: {
        profile: fixture.snapshot.profile,
        job: fixture.snapshot.discoveryJobs[0],
        applicationRecord: applicationB,
        question: questionB,
      },
    }),
  );
  expect(fixture.getWorkspaceProjection).toHaveBeenCalledTimes(2);
  expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
});

describe("application document proposal lineage", () => {
  it("forwards and accepts the exact application B lineage", async () => {
    const { handler, propose, getApplyRunDetails } = register(createDetails());

    await expect(
      handler({ sender: {} } as IpcMainInvokeEvent, payload),
    ).resolves.toEqual(revision);
    expect(getApplyRunDetails).toHaveBeenCalledWith(
      run.id,
      job.id,
      applicationB.id,
    );
    expect(propose).toHaveBeenCalledOnce();
    expect(propose.mock.calls[0]?.[0].grounding.applicationRecord).toEqual(
      applicationB,
    );
    expect(propose.mock.calls[0]?.[0].grounding.question).toEqual(questionB);
  });

  it.each([
    [
      "sibling application A",
      createDetails({
        result: { ...resultB, applicationRecordId: applicationA.id },
        question: { ...questionB, applicationRecordId: applicationA.id },
      }),
    ],
    ["wrong run", createDetails({ run: { ...run, id: "run-other" } })],
    [
      "wrong job",
      createDetails({
        result: { ...resultB, jobId: "job-other" },
      }),
    ],
    [
      "wrong result",
      createDetails({
        question: { ...questionB, resultId: "result-other" },
      }),
    ],
    [
      "wrong question",
      createDetails({ question: { ...questionB, id: "question-other" } }),
    ],
    [
      "legacy null result lineage",
      createDetails({ result: { ...resultB, applicationRecordId: null } }),
    ],
    [
      "legacy null question lineage",
      createDetails({ question: { ...questionB, applicationRecordId: null } }),
    ],
    ["missing result", createDetails({ result: null })],
  ])("rejects %s without proposing a document", async (_label, details) => {
    const { handler, propose } = register(details);

    await expect(
      handler({ sender: {} } as IpcMainInvokeEvent, payload),
    ).rejects.toThrow(/stale|another application/iu);
    expect(propose).not.toHaveBeenCalled();
  });
});

it("records the exact attached letter as an editable application-scoped draft during a handoff", async () => {
  const details = createDetails();
  details.result!.reviewCard = {
    siteLabel: "Synthetic",
    pageUrl: null,
    preparedAt: now,
    answers: [],
    attachments: [
      {
        label: "Cover letter v1",
        fileName: "letter.pdf",
        field: "Cover letter",
      },
    ],
    letter: {
      text: "Exact attached letter text.",
      groundedIn: ["your profile"],
    },
    waitingOnYou: ["Sponsorship"],
  };
  const { listHandler, propose } = register(details);
  await listHandler({ sender: {} } as IpcMainInvokeEvent, {
    jobId: job.id,
    applicationRecordId: applicationB.id,
  });
  expect(propose).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "cover_letter",
      writtenContent: "Exact attached letter text.",
    }),
  );
  const firstId = propose.mock.calls[0]![0].createDocumentId;
  expect(firstId?.startsWith(`attached_letter_${resultB.id}_`)).toBe(true);
  expect(propose.mock.calls[0]![0].grounding.applicationRecord).toEqual(
    applicationB,
  );
  details.result!.reviewCard.letter!.text = "Revised attached letter text.";
  await listHandler({ sender: {} } as IpcMainInvokeEvent, {
    jobId: job.id,
    applicationRecordId: applicationB.id,
  });
  expect(propose.mock.calls[1]![0].createDocumentId).not.toBe(firstId);
  expect(propose.mock.calls[1]![0].writtenContent).toBe(
    "Revised attached letter text.",
  );
});

it("does not keep an evidence fallback after checked document writing fails", async () => {
  const { handler, propose } = register(createDetails(), () =>
    Promise.resolve(null),
  );
  await expect(
    handler({ sender: {} } as IpcMainInvokeEvent, payload),
  ).rejects.toThrow("could not write and check this document");
  expect(propose).not.toHaveBeenCalled();
});

it("lists attached letters through the real library and preserves edits on repeated reads", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-letter-route-"),
  );
  try {
    const library = new ApplicationDocumentLibrary(
      path.join(temporaryDirectory, "documents"),
      new CandidateAssetLibrary(path.join(temporaryDirectory, "assets")),
    );
    const details = createDetails();
    details.result!.reviewCard = {
      siteLabel: "Synthetic",
      pageUrl: null,
      preparedAt: now,
      answers: [],
      attachments: [],
      letter: {
        text: "Exact attached letter text.",
        groundedIn: ["your profile"],
      },
      waitingOnYou: ["Authorization"],
    };
    const { listHandler, getWorkspaceProjection } = register(
      details,
      undefined,
      library,
    );
    const input = { jobId: job.id, applicationRecordId: applicationB.id };
    const event = { sender: {} } as IpcMainInvokeEvent;
    await listHandler(event, input);
    const first = (await library.list(input)).documents[0]!;
    expect(first.content).toBe("Exact attached letter text.");
    expect(first.status).toBe("proposed");
    await library.edit(first.id, first.revision, "Person's corrected letter.");
    await listHandler(event, input);
    const second = (await library.list(input)).documents;
    expect(second).toHaveLength(1);
    expect(second[0]!.content).toBe("Person's corrected letter.");
    expect(second[0]!.revision).toBe(2);
    getWorkspaceProjection.mockRejectedValueOnce(
      new Error("Snapshot is unavailable"),
    );
    await expect(listHandler(event, input)).resolves.toMatchObject({
      documents: [{ content: "Person's corrected letter." }],
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("does not keep another copy of a letter it already holds when a later run attaches it", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-letter-copies-"),
  );
  try {
    const library = new ApplicationDocumentLibrary(
      path.join(temporaryDirectory, "documents"),
      new CandidateAssetLibrary(path.join(temporaryDirectory, "assets")),
    );
    const details = createDetails();
    details.result!.reviewCard = {
      siteLabel: "Synthetic",
      pageUrl: null,
      preparedAt: now,
      answers: [],
      attachments: [],
      letter: {
        text: "Exact attached letter text.",
        groundedIn: ["your profile"],
      },
      waitingOnYou: [],
    };
    const { listHandler } = register(details, undefined, library);
    const input = { jobId: job.id, applicationRecordId: applicationB.id };
    const event = { sender: {} } as IpcMainInvokeEvent;
    await listHandler(event, input);
    const first = (await library.list(input)).documents[0]!;
    const approved = await library.approve(first.id, first.revision);
    await library.propose({
      kind: "cover_letter",
      grounding: {
        profile: createResumeWorkspaceDemoState().profile,
        job: { ...createResumeWorkspaceDemoState().savedJobs[0]!, ...job },
        applicationRecord: {
          ...createResumeWorkspaceDemoState().applicationRecords[0]!,
          ...applicationB,
        },
        question: null,
      },
      documentId: approved.id,
      expectedRevision: approved.revision,
      writtenContent: "A new draft of this letter.",
    });
    // The approved letter goes on the form again in a later run.
    details.result!.id = "result-c";
    await listHandler(event, input);
    const documents = (await library.list(input)).documents;
    expect(documents).toHaveLength(1);
    expect(documents[0]!.status).toBe("proposed");
    expect((await library.list(input)).approvedRevisions).toEqual([approved]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("keeps an unchecked letter draft and its reason through the real library", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-unchecked-letter-"),
  );
  try {
    const library = new ApplicationDocumentLibrary(
      path.join(temporaryDirectory, "documents"),
      new CandidateAssetLibrary(path.join(temporaryDirectory, "assets")),
    );
    const { handler } = register(
      createDetails(),
      () =>
        Promise.reject(
          new ApplicationLetterGroundingError(
            "Review the location conflict.",
            "Draft with proposed accommodation.",
          ),
        ),
      library,
    );
    await handler({ sender: {} } as IpcMainInvokeEvent, payload);
    const draft = (
      await library.list({
        jobId: job.id,
        applicationRecordId: applicationB.id,
      })
    ).documents[0]!;
    expect(draft.content).toBe("Draft with proposed accommodation.");
    expect(draft.requiresGroundingReview).toBe(true);
    expect(draft.reviewReason).toContain("Review the location conflict");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("approval refreshes the prepared letter and notifies the mounted workspace", async () => {
  const refreshApprovedLetter = vi.fn(() => Promise.resolve());
  const { approveHandler } = register(
    createDetails(),
    undefined,
    undefined,
    refreshApprovedLetter,
  );
  const send = vi.fn();
  await approveHandler({ sender: { send } } as unknown as IpcMainInvokeEvent, {
    documentId: revision.id,
    expectedRevision: revision.revision,
  });
  expect(refreshApprovedLetter).toHaveBeenCalledWith(
    expect.objectContaining({
      id: revision.id,
      status: "approved",
      content: revision.content,
    }),
  );
  expect(send).toHaveBeenCalledWith("job-finder:workspace-updated");
});
