// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopProfileWorkflowBridge,
  ProfileSetupState,
  ProfileWorkflowResult,
} from "@nestor/contracts";
import { useProfileWorkflow } from "./use-profile-workflow";

afterEach(cleanup);

const result = (currentStep: ProfileSetupState["currentStep"]) =>
  ({
    state: {
      profileSetupState: {
        status: "in_progress",
        currentStep,
        completedAt: null,
        lastResumedAt: null,
        reviewItems: [],
      },
      latestResumeImportRun: null,
      latestResumeImportReviewCandidates: [],
      resumeImportActive: false,
    },
    message: null,
  }) as ProfileWorkflowResult;

function install(bridge: Partial<DesktopProfileWorkflowBridge>) {
  const cancel = vi.fn();
  Object.assign(window, {
    nestor: {
      jobs: { onChange: () => () => undefined },
      profileWorkflow: {
        run: () => Promise.resolve(result("essentials")),
        importResume: () => new Promise(() => undefined),
        cancelImportResume: cancel,
        checkSite: () => new Promise(() => undefined),
        ...bridge,
      },
    },
  });
  return cancel;
}

test("a read that started before a step ends never undoes the step", async () => {
  let releaseSave: (() => void) | null = null;
  let releaseSlowRead: (() => void) | null = null;
  let reads = 0;
  install({
    run: (command) => {
      if (command.type === "save_setup_state")
        return new Promise((resolve) => {
          releaseSave = () => resolve(result("background"));
        });
      reads++;
      // The second read starts while the save runs and answers after it.
      if (reads === 2)
        return new Promise((resolve) => {
          releaseSlowRead = () => resolve(result("essentials"));
        });
      return Promise.resolve(result(reads === 1 ? "essentials" : "background"));
    },
  });
  const { result: hook } = renderHook(() => useProfileWorkflow());
  await waitFor(() =>
    expect(hook.current.state?.profileSetupState.currentStep).toBe(
      "essentials",
    ),
  );
  const save = hook.current.saveSetupState(
    result("background").state.profileSetupState,
  );
  void hook.current.refresh();
  await act(async () => {
    releaseSave?.();
    await save;
  });
  expect(hook.current.state?.profileSetupState.currentStep).toBe("background");
  await act(async () => {
    releaseSlowRead?.();
    await Promise.resolve();
  });
  expect(hook.current.state?.profileSetupState.currentStep).toBe("background");
});

test("leaving while the file picker is open cancels it; an import already reading goes on", () => {
  const cancel = install({});
  const first = renderHook(() => useProfileWorkflow());
  void first.result.current.importResume();
  first.unmount();
  expect(cancel).toHaveBeenCalledOnce();

  const readingCancel = install({
    importResume: (onProgress) => {
      onProgress({
        stage: "reading_document",
        message: "Reading",
        occurredAt: "2026-10-26T12:00:00.000Z",
      });
      return new Promise(() => undefined);
    },
  });
  const second = renderHook(() => useProfileWorkflow());
  void second.result.current.importResume();
  second.unmount();
  expect(readingCancel).not.toHaveBeenCalled();
});
