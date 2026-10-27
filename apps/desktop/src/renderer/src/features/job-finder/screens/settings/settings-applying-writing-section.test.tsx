// @vitest-environment jsdom

import type {
  JobFinderSettings,
  UpdateAiBehaviorInput,
} from "@nestor/contracts";
import { JobFinderSettingsSchema } from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsApplyingWritingSection } from "./settings-applying-writing-section";

/**
 * What an application writes, under Applying. Each choice saves only the
 * applying/cover-letter slice, so it can never overwrite an AI behavior
 * edit (or be overwritten by one).
 */

function parseSettings(
  overrides: Partial<JobFinderSettings> = {},
): JobFinderSettings {
  return JobFinderSettingsSchema.parse({
    allowAutoSubmitOverride: false,
    fontPreset: "inter_requisite",
    humanReviewRequired: true,
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
    <SettingsApplyingWritingSection
      onUpdateAiBehavior={onUpdateAiBehavior}
      settings={settings}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("SettingsApplyingWritingSection", () => {
  it("shows the writing choices with the defaults selected", () => {
    renderSection(vi.fn(() => Promise.resolve(true)));

    const checked = (name: RegExp) =>
      screen.getByRole("radio", { name }).getAttribute("aria-checked");
    expect(checked(/Only when required/)).toBe("true");
    expect(checked(/^Short/)).toBe("true");
    expect(screen.getByTestId("settings-ai-cover-letter-style")).toBeTruthy();
  });

  it("sends only the applying slice with each choice", async () => {
    const onUpdateAiBehavior = vi
      .fn<(input: UpdateAiBehaviorInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    renderSection(onUpdateAiBehavior);

    fireEvent.click(
      screen.getByRole("radio", { name: /Whenever there is room/ }),
    );

    await waitFor(() => expect(onUpdateAiBehavior).toHaveBeenCalledTimes(1));
    // No profileAssistant or jobSearch fields ride along.
    expect(onUpdateAiBehavior.mock.calls[0]?.[0].aiBehavior).toEqual({
      applying: expect.objectContaining({
        coverLetterPolicy: "when_possible",
      }) as unknown,
    });
    await waitFor(() =>
      expect(screen.getByText(/Applying writing saved/)).toBeTruthy(),
    );
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
      expect(screen.getByText(/Applying writing saved/)).toBeTruthy(),
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

  it("leads with the common choices; declarations and letter style wait closed, saying where they stand", () => {
    renderSection(vi.fn(() => Promise.resolve(true)));
    const closed = [...document.querySelectorAll("details")];
    expect(closed).toHaveLength(2);
    expect(closed.every((details) => !details.open)).toBe(true);
    expect(
      screen.getByText(/^Declarations it may tick for you: \d of \d allowed$/u),
    ).toBeTruthy();
    expect(screen.getByText(/^How a letter reads/u)).toBeTruthy();
    // The common choices are out in the open.
    expect(
      screen
        .getByRole("radiogroup", { name: "When to write a cover letter" })
        .closest("details"),
    ).toBeNull();
  });

  it("hides letter style when letters are off", () => {
    renderSection(vi.fn(() => Promise.resolve(true)));

    expect(screen.getByTestId("settings-ai-cover-letter-style")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^Never/ }));
    expect(screen.queryByTestId("settings-ai-cover-letter-style")).toBeNull();
  });

  it("explains default background-check consent without contradicting Applying", () => {
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
});
