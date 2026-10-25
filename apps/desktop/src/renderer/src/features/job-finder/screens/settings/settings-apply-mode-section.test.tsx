// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsApplyModeSection } from "./settings-apply-mode-section";

afterEach(cleanup);

function renderSection(
  props: Partial<Parameters<typeof SettingsApplyModeSection>[0]> = {},
) {
  const onSave = vi.fn();
  render(
    <SettingsApplyModeSection mode="prepare_only"
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave };
}

const checkedMode = () =>
  screen
    .getAllByRole("radio")
    .find((radio) => radio.getAttribute("aria-checked") === "true")
    ?.textContent ?? "";

describe("SettingsApplyModeSection", () => {
  it("puts the previous mode back and says so when the save fails", async () => {
    const onSave = vi.fn(() => Promise.reject(new Error("offline")));
    renderSection({ onSave });

    fireEvent.click(screen.getByRole("radio", { name: /Ask before sending/ }));

    expect(
      await screen.findByText(
        "That did not save, so Apply still uses the mode shown. Try again.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(checkedMode()).toMatch(/Prepare for me/));
  });

  it("does not save again when the saved mode is picked", () => {
    const { onSave } = renderSection({ mode: "autonomous_submit" });

    fireEvent.click(screen.getByRole("radio", { name: /Send for me/ }));

    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the saved send-for-me mode selected", () => {
    renderSection({ mode: "autonomous_submit" });

    expect(
      screen
        .getByRole("radio", { name: /Send for me/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

it("keeps pay inside Applying and saves on toggle without another button", async () => {
  const onSaveSalaryDisclosure = vi.fn(() => Promise.resolve());
  renderSection({ onSaveSalaryDisclosure });
  const toggle = screen.getByRole("switch", {
    name: "Let Job Finder answer expected and current pay questions",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.closest(".surface-panel-shell")?.textContent).toContain(
    "Applying",
  );
  expect(screen.queryByRole("button", { name: "Save pay privacy" })).toBeNull();
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(onSaveSalaryDisclosure).toHaveBeenCalledWith("answer_from_profile"),
  );
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

it("a failed pay save restores the saved choice and explains the failure", async () => {
  renderSection({
    onSaveSalaryDisclosure: () => Promise.reject(new Error("Failed")),
  });
  const toggle = screen.getByRole("switch", {
    name: "Let Job Finder answer expected and current pay questions",
  });
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("alert").textContent).toContain("did not save");
});
