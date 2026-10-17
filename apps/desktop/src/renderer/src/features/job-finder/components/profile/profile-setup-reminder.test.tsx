// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProfileSetupState } from "@nestor/contracts";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageStatusLine } from "../page-status-line";
import { useProfileSetupStatusItem } from "./profile-setup-reminder";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

function Harness(props: {
  currentStep?: ProfileSetupState["currentStep"];
  enabled?: boolean;
  onResume?: (step: ProfileSetupState["currentStep"]) => void;
  pendingItemCount?: number;
}) {
  const item = useProfileSetupStatusItem({
    currentStep: props.currentStep ?? "essentials",
    enabled: props.enabled ?? true,
    isResumePending: false,
    onResume: props.onResume ?? vi.fn(),
    pendingItemCount: props.pendingItemCount ?? 16,
  });
  return (
    <MemoryRouter>
      <PageStatusLine items={item ? [item] : []} />
    </MemoryRouter>
  );
}

describe("useProfileSetupStatusItem", () => {
  it("is an info item on the status line that resumes guided setup from the current step", () => {
    const onResume = vi.fn();
    render(<Harness onResume={onResume} />);

    const text = screen.getByText(
      "Setup in progress: 16 items still need review. Continue from your basics.",
    );
    expect(
      text.closest("[data-page-status-item]")?.getAttribute("data-tone"),
    ).toBe("info");
    fireEvent.click(
      screen.getByRole("button", { name: "Resume guided setup" }),
    );
    expect(onResume).toHaveBeenCalledWith("essentials");
  });

  it("says only where to continue when nothing is waiting for review", () => {
    render(<Harness currentStep="targeting" pendingItemCount={0} />);

    expect(
      screen.getByText("Setup in progress. Continue from your job targets."),
    ).toBeTruthy();
  });

  it("renders nothing once setup is finished", () => {
    const view = render(<Harness enabled={false} />);

    expect(
      view.container.querySelector("[data-page-header-status]"),
    ).toBeNull();
  });

  it("stays hidden for the rest of the session once the person hides it", () => {
    const view = render(<Harness />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Hide for now: Setup in progress/,
      }),
    );
    expect(screen.queryByText(/Setup in progress/)).toBeNull();

    view.unmount();
    render(<Harness />);
    expect(screen.queryByText(/Setup in progress/)).toBeNull();
  });
});
