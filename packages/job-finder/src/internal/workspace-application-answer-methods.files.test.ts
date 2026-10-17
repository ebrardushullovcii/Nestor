import type { ApplyRunDetails, UserActionRequest } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import { createWorkspaceApplicationAnswerMethods } from "./workspace-application-answer-methods";
import type { WorkspaceServiceContext } from "./workspace-service-context";

function uploadRequest(id: string, resultId: string): UserActionRequest {
  return {
    id,
    kind: "manual_upload",
    revision: 2,
    state: "pending",
    scope: {
      type: "application",
      source: "target_site",
      jobId: `job_${resultId}`,
      runId: `run_${resultId}`,
      resultId,
      applicationRecordId: null,
    },
    verification: { type: "page_blocker_absent" },
  } as unknown as UserActionRequest;
}

function details(
  resultId: string,
  kind: string,
  status = "detected",
): ApplyRunDetails {
  return {
    questionRecords: [
      {
        id: `question_${resultId}`,
        resultId,
        kind,
        answerControlType: "file",
        status,
        isRequired: true,
      },
    ],
  } as unknown as ApplyRunDetails;
}

function setup(
  requests: UserActionRequest[],
  detailsByRun: Record<string, ApplyRunDetails>,
) {
  const performUserAction = vi.fn(() => Promise.resolve(undefined));
  const ctx = {
    repository: {
      listUserActionRequests: vi.fn(() => Promise.resolve(requests)),
    },
  } as unknown as WorkspaceServiceContext;
  const methods = createWorkspaceApplicationAnswerMethods(
    ctx,
    (runId) => {
      const found = detailsByRun[runId];
      return found ? Promise.resolve(found) : Promise.reject(new Error("gone"));
    },
    performUserAction,
  );
  return { methods, performUserAction };
}

describe("continueApplicationsWaitingForFiles", () => {
  test("continues only the uploads whose open file question takes this file", async () => {
    const { methods, performUserAction } = setup(
      [
        uploadRequest("upload_portfolio", "result_portfolio"),
        uploadRequest("upload_letter", "result_letter"),
        uploadRequest("upload_done", "result_done"),
        uploadRequest("upload_missing", "result_missing"),
      ],
      {
        run_result_portfolio: details("result_portfolio", "portfolio"),
        run_result_letter: details("result_letter", "cover_letter"),
        run_result_done: details("result_done", "portfolio", "answered"),
      },
    );

    await expect(
      methods.continueApplicationsWaitingForFiles({
        assetId: "asset_portfolio",
        assetKind: "portfolio",
      }),
    ).resolves.toBe(1);
    expect(performUserAction).toHaveBeenCalledTimes(1);
    expect(performUserAction).toHaveBeenCalledWith({
      action: "confirm_done",
      commandId: "files_changed_asset_portfolio_upload_portfolio_r2",
      requestId: "upload_portfolio",
      expectedRevision: 2,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
  });

  test("a restored transcript continues the transcript upload (read as an other file)", async () => {
    const { methods, performUserAction } = setup(
      [uploadRequest("upload_transcript", "result_transcript")],
      { run_result_transcript: details("result_transcript", "other") },
    );
    await expect(
      methods.continueApplicationsWaitingForFiles({
        assetId: "asset_transcript",
        assetKind: "transcript",
      }),
    ).resolves.toBe(1);
    expect(performUserAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "confirm_done",
        requestId: "upload_transcript",
      }),
    );
  });

  test("a resume never stands in for an application file", async () => {
    const { methods, performUserAction } = setup(
      [uploadRequest("upload_portfolio", "result_portfolio")],
      { run_result_portfolio: details("result_portfolio", "other") },
    );
    await expect(
      methods.continueApplicationsWaitingForFiles({
        assetId: "asset_resume",
        assetKind: "resume",
      }),
    ).resolves.toBe(0);
    expect(performUserAction).not.toHaveBeenCalled();
  });

  test("offers a file added during a continuation to the step that comes back asking for it", async () => {
    // Portfolio added: its continuation starts and reads the files. The
    // transcript is added a moment later, too late for that read, and the
    // application comes back asking for the transcript already in Files.
    let phase: "portfolio" | "transcript" | "done" = "portfolio";
    const performUserAction = vi.fn(() => {
      phase = phase === "portfolio" ? "transcript" : "done";
      return Promise.resolve(undefined);
    });
    const ctx = {
      repository: {
        listUserActionRequests: vi.fn(() =>
          Promise.resolve(
            phase === "portfolio"
              ? [uploadRequest("upload_1", "result_1")]
              : phase === "transcript"
                ? [{ ...uploadRequest("upload_2", "result_2"), revision: 1 }]
                : [],
          ),
        ),
      },
      candidateAssetResolver: {
        list: vi.fn(() =>
          Promise.resolve({
            assets: [
              {
                id: "asset_portfolio",
                kind: "portfolio",
                deletedAt: null,
                consentScope: "job_application_attachment",
              },
              {
                id: "asset_transcript",
                kind: "transcript",
                deletedAt: null,
                consentScope: "job_application_attachment",
              },
            ],
          }),
        ),
        resolveForApplication: vi.fn(),
      },
    } as unknown as WorkspaceServiceContext;
    const detailsByRun: Record<string, ApplyRunDetails> = {
      run_result_1: details("result_1", "portfolio"),
      run_result_2: details("result_2", "transcript"),
    };
    const methods = createWorkspaceApplicationAnswerMethods(
      ctx,
      (runId) => {
        const found = detailsByRun[runId];
        return found
          ? Promise.resolve(found)
          : Promise.reject(new Error("gone"));
      },
      performUserAction,
    );

    await methods.continueApplicationsWaitingForFiles({
      assetId: "asset_portfolio",
      assetKind: "portfolio",
    });
    await vi.waitFor(() => expect(performUserAction).toHaveBeenCalledTimes(2));
    expect(performUserAction).toHaveBeenLastCalledWith(
      // The continuation reads the active files itself and attaches the
      // one that fits; the command only has to reach the waiting step.
      expect.objectContaining({
        requestId: "upload_2",
        action: "confirm_done",
      }),
    );
  });
});
