// @vitest-environment jsdom

import type {
  JobFinderSettings,
  UpdateAiBehaviorInput,
} from "@nestor/contracts";
import { JobFinderSettingsSchema } from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsAiBehaviorSection } from "./settings-ai-behavior-section";

/**
 * The AI behavior section, as a person meets it.
 *
 * What matters: every group is there, the defaults are the product's
 * original manner, and each choice saves the whole section at once (Undo
 * rides on the save toast). The resume level is not here; it lives in
 * Profile, under Preferences.
 */

function parseSettings(
  overrides: Partial<JobFinderSettings> = {},
): JobFinderSettings {
  return JobFinderSettingsSchema.parse({
    allowAutoSubmitOverride: false,
    fontPreset: "inter_requisite",
    humanReviewRequired: true,
    keepSessionAlive: false,
    resumeFormat: "pdf",
    resumeTemplateId: "classic_ats",
    ...overrides,
  });
}

function renderSection(
  onUpdateAiBehavior: (input: UpdateAiBehaviorInput) => Promise<boolean>,
  settings = parseSettings(),
) {
  return render(
    <SettingsAiBehaviorSection
      onUpdateAiBehavior={onUpdateAiBehavior}
      settings={settings}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("SettingsAiBehaviorSection", () => {
  it("shows the groups with the original behaviour selected by default", () => {
    renderSection(vi.fn(() => Promise.resolve(true)));

    expect(
      within(screen.getByTestId("settings-ai-profile-assistant")).getByText(
        "Assistant",
      ),
    ).toBeTruthy();
    // The side-chat assistant, not the old profile-only one.
    expect(
      screen.getByRole("radiogroup", {
        name: "How much the assistant suggests",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Finding jobs")).toBeTruthy();
    // No resume level here: it lives in Profile, under Preferences. The
    // Resumes group only appears with the write-on-shortlist switch.
    expect(
      screen.queryByRole("radiogroup", { name: "Resume level" }),
    ).toBeNull();
    expect(
      within(screen.getByTestId("settings-ai-applying")).getByRole("heading", {
        name: "Applying",
      }),
    ).toBeTruthy();

    const checked = (name: RegExp) =>
      screen.getByRole("radio", { name }).getAttribute("aria-checked");
    expect(checked(/Suggest a little/)).toBe("true");
    expect(checked(/^Brief/)).toBe("true");
    expect(checked(/^Balanced/)).toBe("true");
    expect(checked(/Only when required/)).toBe("true");
    expect(checked(/^Short/)).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "Count remote jobs as any location" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // Nothing to save: no button.
    expect(
      screen.queryByRole("button", { name: "Save AI behavior" }),
    ).toBeNull();
  });

  it("sends the whole section with each choice, coalescing choices made while a save runs", async () => {
    let finishFirst: (saved: boolean) => void = () => undefined;
    const onUpdateAiBehavior = vi
      .fn<(input: UpdateAiBehaviorInput) => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue(true);
    renderSection(onUpdateAiBehavior);

    // The click itself saves; no Save button is needed.
    fireEvent.click(screen.getByRole("radio", { name: /^Proactive/ }));
    expect(onUpdateAiBehavior).toHaveBeenCalledTimes(1);
    expect(onUpdateAiBehavior.mock.calls[0]?.[0]).toMatchObject({
      aiBehavior: {
        profileAssistant: { initiative: "proactive", replyStyle: "brief" },
      },
    });

    // Choices made while that save runs stay on screen and go out together.
    fireEvent.click(screen.getByRole("radio", { name: /Cast a wide net/ }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Count remote jobs as any location" }),
    );
    fireEvent.click(
      screen.getByRole("radio", { name: /Whenever there is room/ }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /^Full/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Marketing contact" }));
    fireEvent.click(screen.getByRole("switch", { name: "Site terms" }));
    expect(onUpdateAiBehavior).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("radio", { name: /Cast a wide net/ })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await act(() => {
      finishFirst(true);
      return Promise.resolve();
    });

    await waitFor(() => expect(onUpdateAiBehavior).toHaveBeenCalledTimes(2));
    expect(onUpdateAiBehavior.mock.calls[1]?.[0]).toEqual({
      aiBehavior: {
        profileAssistant: { initiative: "proactive", replyStyle: "brief" },
        jobSearch: {
          selectivity: "wide_net",
          remoteCountsAsAnyLocation: false,
        },
        applying: {
          coverLetterPolicy: "when_possible",
          writtenAnswerLength: "full",
          preApprovedDeclarations: [
            "truthfulness_certification",
            "privacy_notice_acknowledgement",
            "background_check_consent",
            "marketing_contact_consent",
          ],
        },
      },
      coverLetter: {
        tone: "plain_professional",
        length: "standard",
        language: null,
        sample: null,
      },
    });
    await waitFor(() =>
      expect(screen.getByText(/AI behavior saved/)).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: "Save AI behavior" }),
    ).toBeNull();
  });

  it("saves typed text when the person leaves the field, trimmed", async () => {
    const onUpdateAiBehavior = vi
      .fn<(input: UpdateAiBehaviorInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    renderSection(onUpdateAiBehavior);

    const language = screen.getByPlaceholderText(
      /Leave empty to match the job posting/i,
    );
    fireEvent.change(language, { target: { value: "  German  " } });
    fireEvent.change(
      screen.getByPlaceholderText(/Paste a letter you wrote yourself/i),
      { target: { value: "   " } },
    );
    // Not on every keystroke.
    expect(onUpdateAiBehavior).not.toHaveBeenCalled();
    fireEvent.blur(language);

    expect(onUpdateAiBehavior).toHaveBeenCalledTimes(1);
    expect(onUpdateAiBehavior.mock.calls[0]?.[0]).toMatchObject({
      coverLetter: {
        tone: "plain_professional",
        length: "standard",
        language: "German",
        sample: null,
      },
    });
    await waitFor(() =>
      expect(screen.getByText(/AI behavior saved/)).toBeTruthy(),
    );
  });

  it("hands the save toast an Undo that saves the earlier choice back", async () => {
    const onUpdateAiBehavior = vi
      .fn<
        (
          input: UpdateAiBehaviorInput,
          options?: { undo?: () => void },
        ) => Promise<boolean>
      >()
      .mockResolvedValue(true);
    renderSection(onUpdateAiBehavior);

    fireEvent.click(screen.getByRole("radio", { name: /^Proactive/ }));
    await waitFor(() =>
      expect(screen.getByText(/AI behavior saved/)).toBeTruthy(),
    );
    expect(onUpdateAiBehavior.mock.calls[0]?.[0]).toMatchObject({
      aiBehavior: {
        profileAssistant: { initiative: "proactive" },
      },
    });
    expect(onUpdateAiBehavior.mock.calls[0]?.[1]?.undo).toEqual(
      expect.any(Function) as unknown,
    );

    const undo = onUpdateAiBehavior.mock.calls[0]?.[1]?.undo;
    act(() => undo?.());

    await waitFor(() => expect(onUpdateAiBehavior).toHaveBeenCalledTimes(2));
    // Undoing offers no Undo of its own.
    expect(onUpdateAiBehavior.mock.calls[1]?.[0]).toMatchObject({
      aiBehavior: {
        profileAssistant: { initiative: "suggest" },
      },
    });
    expect(onUpdateAiBehavior.mock.calls[1]?.[1]).toBeUndefined();
    expect(
      screen
        .getByRole("radio", { name: /Suggest a little/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await waitFor(() =>
      expect(screen.getByText("AI behavior change undone.")).toBeTruthy(),
    );
  });

  it("keeps a failed choice on screen and retries it", async () => {
    const onUpdateAiBehavior = vi
      .fn<(input: UpdateAiBehaviorInput) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    renderSection(onUpdateAiBehavior);

    fireEvent.click(screen.getByRole("radio", { name: /^Proactive/ }));
    const retry = await screen.findByRole("button", {
      name: "Retry AI behavior",
    });
    expect(
      screen.getByText(
        "AI behavior was not saved. Retry before leaving this page.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: /^Proactive/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(retry);
    await waitFor(() => expect(onUpdateAiBehavior).toHaveBeenCalledTimes(2));
    expect(onUpdateAiBehavior.mock.calls[1]?.[0]).toMatchObject({
      aiBehavior: {
        profileAssistant: { initiative: "proactive" },
      },
    });
    await waitFor(() =>
      expect(screen.getByText(/AI behavior saved/)).toBeTruthy(),
    );
  });

  it("shows the saved choice rather than the default", () => {
    renderSection(
      vi.fn(() => Promise.resolve(true)),
      parseSettings({
        coverLetter: {
          tone: "direct",
          length: "short",
          language: "Dutch",
          sample: null,
        },
      }),
    );

    expect(screen.getByDisplayValue("Dutch")).toBeTruthy();
    expect(screen.getByText(/Direct and brief/i)).toBeTruthy();
  });

  it("hides letter style when letters are off", () => {
    renderSection(vi.fn(() => Promise.resolve(true)));

    expect(screen.getByTestId("settings-ai-cover-letter-style")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^Never/ }));
    expect(screen.queryByTestId("settings-ai-cover-letter-style")).toBeNull();
  });
});

it("explains default background-check consent and sending without contradicting Applying", () => {
  renderSection(vi.fn(() => Promise.resolve(true)));
  expect(
    screen
      .getByRole("switch", { name: "Background check" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByText(
      "Ticks background or reference check consent on forms for you. Turn it off to be asked each time.",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText(/never approves or sends an application on its own/),
  ).toBeNull();
});
