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
    <SettingsApplyModeSection
      maxApplicationsPerLocalDay={20}
      mode="prepare_only"
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
  it("shows the three useful application modes and the daily cap", () => {
    renderSection();

    expect(screen.getByRole("radio", { name: /Prepare for me/ })).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: /Ask before sending/ }),
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Send for me/ })).toBeTruthy();
    expect(screen.getByLabelText("Most preparations in one day")).toBeTruthy();

    // Nothing about envelopes, approvals, revoking, websites, or reusable
    // answers survives on this screen (ADR 0022).
    expect(document.body.textContent ?? "").not.toMatch(
      /envelope|approval|approve|revoke|website|reusable answer|fingerprint|snapshot/i,
    );
  });

  it("saves a mode the moment it is picked, with the saved daily limit, and says what Apply now does", async () => {
    // Picking Send for me and going back to Home used to lose the choice
    // without a word, because the mode waited for a Save further down.
    const { onSave } = renderSection();

    fireEvent.click(screen.getByRole("radio", { name: /Send for me/ }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      mode: "autonomous_submit",
      maxApplicationsPerLocalDay: 20,
    });
    expect(
      await screen.findByText(
        "Saved. From now on Apply fills in and sends each application, and pauses only when it needs you.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

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

  it("keeps a typed daily limit behind its own save, with the saved mode", async () => {
    const { onSave } = renderSection({ mode: "confirm_before_submit" });

    expect(
      screen.queryByRole("button", { name: "Save daily limit" }),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText("Most preparations in one day"), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save daily limit" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        mode: "confirm_before_submit",
        maxApplicationsPerLocalDay: 8,
      }),
    );
    expect(
      await screen.findByText("Saved. Apply stops after 8 applications a day."),
    ).toBeTruthy();
  });

  it("offers one Save daily limit, not a second one under the field", () => {
    renderSection({ mode: "confirm_before_submit" });

    fireEvent.change(screen.getByLabelText("Most preparations in one day"), {
      target: { value: "8" },
    });

    expect(
      screen.getAllByRole("button", { name: "Save daily limit" }),
    ).toHaveLength(1);
    expect(screen.getByText("Not saved yet.")).toBeTruthy();
  });

  it.each(["1.5", "1e3", "0", "9007199254740992", ""])(
    "keeps an invalid daily limit %s unsaved without sending a rounded value",
    (value) => {
      const { onSave } = renderSection();
      fireEvent.change(screen.getByLabelText("Most preparations in one day"), {
        target: { value },
      });

      expect(
        screen.getByText("Enter a whole number of 1 or more."),
      ).toBeTruthy();
      expect(screen.getByText("Not saved yet.")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Save daily limit" }),
      ).toHaveProperty("disabled", true);
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it("shows the saved send-for-me mode selected", () => {
    renderSection({ mode: "autonomous_submit" });

    expect(
      screen
        .getByRole("radio", { name: /Send for me/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("application mode and daily limit save ordering", () => {
  it.each(["mode", "daily limit"])(
    "prevents a second settings write while the %s saves",
    async (first) => {
      let finish: () => void = () => undefined;
      const onSave = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      renderSection({ onSave });
      fireEvent.change(screen.getByLabelText("Most preparations in one day"), {
        target: { value: "8" },
      });
      if (first === "mode") {
        fireEvent.click(
          screen.getByRole("radio", { name: /Ask before sending/ }),
        );
      } else {
        fireEvent.click(
          screen.getByRole("button", { name: "Save daily limit" }),
        );
      }
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(
        screen.getByLabelText("Most preparations in one day"),
      ).toHaveProperty("disabled", true);
      for (const radio of screen.getAllByRole("radio"))
        expect(radio).toHaveProperty("disabled", true);
      fireEvent.click(screen.getByRole("radio", { name: /Send for me/ }));
      if (first === "mode")
        fireEvent.click(
          screen.getByRole("button", { name: "Save daily limit" }),
        );
      expect(onSave).toHaveBeenCalledTimes(1);
      finish();
      await waitFor(() =>
        expect(
          screen.getByLabelText("Most preparations in one day"),
        ).toHaveProperty("disabled", false),
      );
    },
  );
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
