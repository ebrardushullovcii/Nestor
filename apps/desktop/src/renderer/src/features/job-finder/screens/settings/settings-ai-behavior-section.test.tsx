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
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsAiBehaviorSection } from "./settings-ai-behavior-section";

/**
 * The AI behavior section, as a person meets it.
 *
 * What matters: every group is there, the defaults are the product's
 * original manner, one Save commits the whole section with the full input,
 * and the aggressive resume choice carries its own warning.
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
  tailoringMode: "conservative" | "balanced" | "aggressive" = "balanced",
) {
  return render(
    <SettingsAiBehaviorSection
      onUpdateAiBehavior={onUpdateAiBehavior}
      searchPreferences={{ tailoringMode }}
      settings={settings}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("SettingsAiBehaviorSection", () => {
  it("shows the four groups with the original behaviour selected by default", () => {
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
    expect(screen.getByRole("heading", { name: "Resumes" })).toBeTruthy();
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
    expect(checked(/^Tailored/)).toBe("true");
    expect(checked(/Only when required/)).toBe("true");
    expect(checked(/^Short/)).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "Count remote jobs as any location" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // Nothing to save: no button.
    expect(screen.queryByRole("button", { name: "Save AI behavior" })).toBeNull();
  });

  it("commits the whole section in one save with the full input", async () => {
    const onUpdateAiBehavior = vi.fn(() => Promise.resolve(true));
    renderSection(onUpdateAiBehavior);

    fireEvent.click(screen.getByRole("radio", { name: /^Proactive/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Cast a wide net/ }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Count remote jobs as any location" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /^Light/ }));
    fireEvent.click(
      screen.getByRole("radio", { name: /Whenever there is room/ }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /^Full/ }));
    fireEvent.change(
      screen.getByPlaceholderText(/Leave empty to match the job posting/i),
      { target: { value: "  German  " } },
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Paste a letter you wrote yourself/i),
      { target: { value: "   " } },
    );
    expect(screen.getByText("Not saved yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save AI behavior" }));

    await waitFor(() =>
      expect(onUpdateAiBehavior).toHaveBeenCalledWith({
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
              "terms_acceptance",
              "background_check_consent",
            ],
          },
        },
        coverLetter: {
          tone: "plain_professional",
          length: "standard",
          language: "German",
          sample: null,
        },
        resumeApproach: "conservative",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText(/AI behavior saved/)).toBeTruthy(),
    );
  });

  it("shows the saved choice rather than the default, and warns on aggressive", () => {
    renderSection(
      vi.fn(() => Promise.resolve(true)),
      parseSettings({
        resumeApplicationMode: "tailored_per_job",
        coverLetter: {
          tone: "direct",
          length: "short",
          language: "Dutch",
          sample: null,
        },
      }),
      "aggressive",
    );

    expect(
      screen
        .getByRole("radio", { name: /^Aggressive/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("status").textContent).toContain(
      "cannot be used until you confirm it yourself",
    );
    expect(screen.getByDisplayValue("Dutch")).toBeTruthy();
    expect(screen.getByText(/Direct and brief/i)).toBeTruthy();
  });

  it("reads the original file as the fourth resume choice and hides letter style when letters are off", () => {
    renderSection(
      vi.fn(() => Promise.resolve(true)),
      parseSettings({ resumeApplicationMode: "original_resume" }),
    );

    expect(
      screen
        .getByRole("radio", { name: /^Original/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
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
  fireEvent.click(screen.getByRole("radio", { name: /^Aggressive/ }));
  expect(
    screen.getByText(/Aggressive resumes still need your approval/).textContent,
  ).toContain(
    "Aggressive resumes still need your approval; sending follows your Applying choice.",
  );
  expect(
    screen.queryByText(/never approves or sends an application on its own/),
  ).toBeNull();
});
