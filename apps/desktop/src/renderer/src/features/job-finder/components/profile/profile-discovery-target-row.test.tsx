// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  EditableSourceInstructionArtifact,
  SourceAccessPrompt,
  SourceDebugRunDetails,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import { ToastProvider } from "@renderer/components/ui/toast";
import { ProfileDiscoveryTargetRow } from "./profile-discovery-target-row";

describe("ProfileDiscoveryTargetRow", () => {
  const globalScope = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const originalActEnvironment = globalScope.IS_REACT_ACT_ENVIRONMENT;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeAll(() => {
    globalScope.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    if (originalActEnvironment === undefined) {
      delete globalScope.IS_REACT_ACT_ENVIRONMENT;
      return;
    }

    globalScope.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("renders sign-in actions and explains retained jobs when removing the source", () => {
    const updateDiscoveryTargets = vi.fn();
    const onOpenBrowserSessionForTarget = vi.fn();
    const target = {
      id: "target_linkedin_default",
      label: "LinkedIn",
      startingUrl: "https://www.linkedin.com/jobs/search/",
      enabled: true,
      adapterKind: "auto" as const,
      customInstructions: "",
      instructionStatus: "draft" as const,
      validatedInstructionId: null,
      draftInstructionId: "instruction_1",
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    };
    const sourceAccessPrompt: SourceAccessPrompt = {
      targetId: "target_linkedin_default",
      targetLabel: "LinkedIn",
      targetUrl: "https://www.linkedin.com/jobs/search/",
      state: "prompt_login_required",
      summary: "Sign in to LinkedIn before the next search can continue.",
      detail: "Please sign in first.",
      actionLabel: "Sign in to LinkedIn",
      rerunLabel: "Search again after sign-in",
      updatedAt: "2026-03-20T10:01:00.000Z",
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ToastProvider>
          <ProfileDiscoveryTargetRow
            discoveryTargets={[target]}
            index={0}
            instructionArtifact={null}
            isBrowserSessionPending={() => false}
            isSourceDebugPending={() => false}
            isSourceInstructionPending={() => false}
            isSourceInstructionVerifyPending={() => false}
            isTargetDiscoveryPending={() => false}
            onGetSourceDebugRunDetails={vi.fn(() =>
              Promise.resolve(undefined as unknown as SourceDebugRunDetails),
            )}
            onOpenBrowserSessionForTarget={onOpenBrowserSessionForTarget}
            onRunDiscoveryForTarget={vi.fn()}
            onRunSourceDebug={vi.fn()}
            onSaveSourceInstructionArtifact={vi.fn<
              (
                targetId: string,
                artifact: EditableSourceInstructionArtifact,
              ) => void
            >()}
            onVerifySourceInstructions={vi.fn()}
            recentSourceDebugRuns={[] as readonly SourceDebugRunRecord[]}
            sourceAccessPrompt={sourceAccessPrompt}
            target={target}
            updateDiscoveryTargets={updateDiscoveryTargets}
          />
        </ToastProvider>,
      );
    });

    expect(container?.textContent).toContain("Sign-in required");
    expect(container?.textContent).toContain(
      "Sign in to LinkedIn before the next search can continue.",
    );
    expect(container?.textContent).toContain(
      "After sign-in: Search again after sign-in.",
    );

    const signInButton = [
      ...(container?.querySelectorAll("button") ?? []),
    ].find((button) => button.textContent?.trim() === "Sign in to LinkedIn");
    expect(signInButton).not.toBeNull();

    act(() => {
      signInButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenBrowserSessionForTarget).toHaveBeenCalledWith(
      "target_linkedin_default",
    );
    const remove = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Remove",
    );
    expect(remove?.title).toContain("Saved jobs stay");
    act(() => {
      remove?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(updateDiscoveryTargets).toHaveBeenCalledWith([]);
    expect(document.body.textContent).toContain(
      "Its saved jobs stay in your plans with their original source name.",
    );
  });
});
