import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApplications: vi.fn(),
  stopApplication: vi.fn(),
  openApplication: vi.fn(),
  sendPrepared: vi.fn(),
  reportSendByPerson: vi.fn(),
  browserCommand: vi.fn(),
  getApplication: vi.fn(),
  getWork: vi.fn(),
  getResumeArtifact: vi.fn(),
  getSubmissionReceipt: vi.fn(),
}));
vi.mock("../services/job-finder/application-store", () => ({
  getApplicationStore: () => ({
    listApplications: mocks.listApplications,
    getApplication: mocks.getApplication,
    getWork: mocks.getWork,
    getResumeArtifact: mocks.getResumeArtifact,
    getSubmissionReceipt: mocks.getSubmissionReceipt,
  }),
}));
vi.mock("../services/job-store", () => ({ getJobStore: vi.fn() }));
vi.mock("../services/job-finder/test-api", () => ({
  isDesktopTestApiEnabled: () => false,
}));
vi.mock("../services/applications", () => ({
  getApplicationService: () =>
    Promise.resolve({
      stopApplication: mocks.stopApplication,
      open: mocks.openApplication,
      sendPrepared: mocks.sendPrepared,
      reportSendByPerson: mocks.reportSendByPerson,
    }),
}));
vi.mock("../services/browser/load-embedded-browser", () => ({
  loadEmbeddedBrowser: () => Promise.resolve({ command: mocks.browserCommand }),
}));
vi.mock("../services/browser/embedded-browser", () => ({
  getEmbeddedBrowser: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ noteExplicitUserStart: vi.fn() }));
vi.mock("../services/job-finder/runtime", () => ({
  startJobFinderRuntime: () => Promise.resolve({}),
  noteExplicitUserStart: runtime.noteExplicitUserStart,
}));

import { executeApplicationStoreCommand } from "./application-store";

beforeEach(() => vi.clearAllMocks());

// The preload passes these calls through, so main is where they are checked.
describe("application commands in main", () => {
  it("the Ready Send command calls only the existing ledgered send path", async () => {
    mocks.sendPrepared.mockResolvedValue(true);
    await expect(
      executeApplicationStoreCommand("send-application", { id: 3 }),
    ).resolves.toBe(true);
    expect(mocks.sendPrepared).toHaveBeenCalledExactlyOnceWith(3, undefined);
    expect(mocks.openApplication).not.toHaveBeenCalled();
    expect(mocks.browserCommand).not.toHaveBeenCalled();
  });

  it.each(["ready", "stopped", "failed"])(
    "the record-only route settles %s without sending or opening it",
    async (state) => {
      mocks.getApplication.mockReturnValue({ state });
      mocks.getSubmissionReceipt.mockReturnValue(null);
      mocks.reportSendByPerson.mockResolvedValue(true);
      await expect(
        executeApplicationStoreCommand("report-application-send", {
          id: 3,
          sent: true,
        }),
      ).resolves.toBe(true);
      expect(mocks.reportSendByPerson).toHaveBeenCalledExactlyOnceWith(3, true);
      expect(mocks.sendPrepared).not.toHaveBeenCalled();
      expect(mocks.openApplication).not.toHaveBeenCalled();
    },
  );
  it.each(["site_login_required", "security_challenge"])(
    "exposes the recorded access reason only for a sign-in handoff: %s",
    async (code) => {
      const at = "2026-11-03T21:00:00.000Z";
      const accessDetail =
        "Nestor cannot prove this request is limited to basic identity. Review the listed access yourself. ".repeat(
          24,
        );
      mocks.getApplication.mockReturnValue({
        id: 3,
        jobId: 3,
        mode: "confirm_before_submit",
        title: "Synthetic role",
        company: "Synthetic employer",
        location: "Berlin, Germany",
        state: "needs_you",
        attempt: 1,
        queuedAt: at,
        updatedAt: at,
        submittedAt: null,
        error: null,
      });
      mocks.getWork.mockReturnValue({
        execution: {
          summary: "Google needs you to finish this step.",
          detail: "Google needs you to finish this step.",
          blocker: { code, detail: accessDetail },
        },
        reviewCard: null,
      });
      mocks.getResumeArtifact.mockReturnValue(null);
      mocks.getSubmissionReceipt.mockReturnValue(null);
      await expect(
        executeApplicationStoreCommand("get-application-details", { id: 3 }),
      ).resolves.toMatchObject({
        accessDetail: code === "site_login_required" ? accessDetail : null,
      });
    },
  );

  it.each([true, false])(
    "Open delegates the retained page or URL to the service and never opens an unrelated active tab: %s",
    async (opened) => {
      mocks.openApplication.mockResolvedValue({ opened, retained: opened });
      expect(
        await executeApplicationStoreCommand("open-application", { id: 3 }),
      ).toEqual({ opened, retained: opened });
      expect(mocks.openApplication).toHaveBeenCalledWith(3);
      expect(mocks.browserCommand).not.toHaveBeenCalled();
      // Opening is the person's own start: a browser they closed may reopen.
      expect(runtime.noteExplicitUserStart).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a malformed selection before anything is queued", async () => {
    await expect(
      executeApplicationStoreCommand("apply-jobs", {
        selection: { ids: [-1] },
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("reads a list with the query's defaults filled in", async () => {
    mocks.listApplications.mockReturnValue({ rows: [], nextCursor: null });
    await expect(
      executeApplicationStoreCommand("list-applications", {
        state: "queued",
        limit: 20,
      }),
    ).resolves.toEqual({ rows: [], nextCursor: null });
    expect(mocks.listApplications).toHaveBeenCalledWith({
      state: "queued",
      cursor: null,
      limit: 20,
    });
  });

  it("does not send the renderer a malformed stop result", async () => {
    mocks.stopApplication.mockResolvedValue({ stopped: "yes" });
    await expect(
      executeApplicationStoreCommand("stop-application", { id: 3 }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
