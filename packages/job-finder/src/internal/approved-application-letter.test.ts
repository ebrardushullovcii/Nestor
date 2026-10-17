import { createSeed } from "../workspace-service.test-fixtures";
import { expect, test, vi } from "vitest";
import {
  ApplyJobResultSchema,
  CandidateProfileSchema,
  SavedJobSchema,
  JobFinderSettingsSchema,
  type ApplicationDocumentRevision,
  type ApplyPageSession,
} from "@nordri/contracts";
import type { ExecuteApplicationFlowInput } from "@nordri/browser-runtime";
import type * as BrowserAgent from "@nordri/browser-agent";
import type { WorkspaceServiceContext } from "./workspace-service-context";
vi.mock("@nordri/browser-agent", async (original) => ({
  ...(await original<typeof BrowserAgent>()),
  replaceApprovedApplicationLetter: vi.fn(),
}));
import { replaceApprovedApplicationLetter } from "@nordri/browser-agent";
import { refreshApprovedApplicationLetter } from "./approved-application-letter";
const at = "2026-10-06T10:00:00.000Z";

function setup(held = true) {
  let result = ApplyJobResultSchema.parse({
    id: "result",
    runId: "run",
    jobId: "job",
    applicationRecordId: "application",
    state: "awaiting_review",
    summary: "Ready",
    detail: "Ready",
    startedAt: at,
    updatedAt: at,
    reviewCard: {
      siteLabel: "Synthetic careers",
      pageUrl: "https://synthetic.example/form",
      preparedAt: at,
      letter: {
        text: "Earlier letter",
        groundedIn: [],
        fields: ["Cover letter"],
      },
      attachments: [
        {
          field: "Cover letter",
          label: "Cover letter v1",
          fileName: "old.txt",
        },
      ],
    },
  });
  const document = {
    kind: "cover_letter",
    status: "approved",
    content: "Approved revision two",
    job: { jobId: "job", applicationRecordId: "application" },
  } as ApplicationDocumentRevision;
  const job = SavedJobSchema.parse({
    ...createSeed().savedJobs[0],
    id: "job",
    source: "target_site",
    sourceJobId: "job",
    canonicalUrl: "https://synthetic.example/form",
    title: "Analyst",
    company: "Synthetic employer",
  });
  const profile = CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Synthetic Applicant",
    yearsExperience: 2,
    baseResume: {
      id: "resume",
      fileName: "synthetic.txt",
      uploadedAt: at,
      extractionStatus: "ready",
    },
  });
  const facts = {
    job,
    profile,
    settings: JobFinderSettingsSchema.parse(createSeed().settings),
    mode: "prepare_only",
    resumeArtifact: {
      id: "resume",
      jobId: "job",
      fileName: "synthetic.txt",
      filePath: "/tmp/synthetic.txt",
      source: "original_upload",
      sourceDocumentId: "resume",
      exportArtifactId: null,
      sha256: "a".repeat(64),
      approvedAt: at,
    },
  } satisfies Omit<ExecuteApplicationFlowInput, "prepareApplicationForm">;
  const installPrepareOnlyGuard = vi.fn();
  const executeApplicationFlow = vi.fn(
    async (_source, input: ExecuteApplicationFlowInput) =>
      input.prepareApplicationForm({
        session: { installPrepareOnlyGuard } as unknown as ApplyPageSession,
        currentUrl: "https://synthetic.example/form",
        startedAt: at,
      }),
  );
  const ctx = {
    repository: {
      listApplyJobResults: () => Promise.resolve([result]),
      listSavedJobs: () => Promise.resolve([job]),
      upsertApplyJobResult: (entry: typeof result) => {
        result = entry;

        return Promise.resolve();
      },
    },
    browserRuntime: {
      hasApplicationPageBinding: () => Promise.resolve(held),
      executeApplicationFlow,
    },
    aiClient: { chatWithTools: vi.fn() },
    documentManager: {
      getApprovedApplicationLetter: () => Promise.resolve(document),
    },
  } as unknown as WorkspaceServiceContext;
  return {
    ctx,
    document,
    facts,
    result: () => result,
    executeApplicationFlow,
    installPrepareOnlyGuard,
  };
}

test("an approval replaces the held attachment, persists its new review and never grants send", async () => {
  const fixture = setup();
  vi.mocked(replaceApprovedApplicationLetter).mockResolvedValueOnce({
    filled: [],
    attachments: [
      {
        documentId: "approved",
        fileName: "approved.txt",
        label: "Approved letter",
        controlLabel: "Cover letter",
        at,
      },
    ],
  });
  await refreshApprovedApplicationLetter(fixture.ctx, fixture.document, () =>
    Promise.resolve(fixture.facts),
  );
  expect(fixture.result().reviewCard?.letter).toMatchObject({
    text: "Approved revision two",
    needsRefresh: false,
  });
  expect(fixture.result().reviewCard?.attachments[0]?.fileName).toBe(
    "approved.txt",
  );
  expect(fixture.executeApplicationFlow.mock.calls[0]?.[1]).toMatchObject({
    applicationPageBindingKey: "result",
    startingUrl: "https://synthetic.example/form",
    mode: "prepare_only",
    submitAuthorized: false,
  });
  expect(fixture.installPrepareOnlyGuard).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "approval keeps the stale notice when a safe replacement is unavailable (held=%s)",
  async (held) => {
    const fixture = setup(held);
    vi.mocked(replaceApprovedApplicationLetter).mockResolvedValueOnce(null);
    await refreshApprovedApplicationLetter(fixture.ctx, fixture.document, () =>
      Promise.resolve(fixture.facts),
    );
    expect(fixture.result().reviewCard?.letter).toMatchObject({
      text: "Earlier letter",
      needsRefresh: true,
    });
    expect(fixture.executeApplicationFlow).toHaveBeenCalledTimes(held ? 1 : 0);
  },
);

test("approving the displayed text again cannot clear an unresolved form replacement", async () => {
  const fixture = setup(false);
  fixture.result().reviewCard!.letter!.needsRefresh = true;
  fixture.document.content = "Earlier letter";
  await refreshApprovedApplicationLetter(fixture.ctx, fixture.document, () =>
    Promise.resolve(fixture.facts),
  );
  expect(fixture.result().reviewCard?.letter?.needsRefresh).toBe(true);
});
