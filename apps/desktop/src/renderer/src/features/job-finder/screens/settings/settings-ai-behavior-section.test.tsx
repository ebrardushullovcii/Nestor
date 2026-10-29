// @vitest-environment jsdom

import type {
  JobFinderSettings,
  UpdateAiBehaviorInput,
} from "@nestor/contracts";
import {
  AiBehaviorPreferenceSchema,
  JobFinderSettingsSchema,
} from "@nestor/contracts";
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
 * What matters: the groups are there, the defaults are the product's
 * original manner, and each choice saves this section's slice at once
 * (Undo rides on the save toast). How picky a search is is not here; it
 * is chosen on Find jobs before each search. What an application writes
 * is not here either; it lives under Applying. The resume level lives
 * in Profile, under Preferences.
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
    // How picky moved to Find jobs; what an application writes moved to
    // Applying. Neither stays here as a second home.
    expect(
      screen.queryByRole("radiogroup", { name: "How picky a search is" }),
    ).toBeNull();
    expect(screen.queryByTestId("settings-ai-applying")).toBeNull();
    // When a resume gets written lives in Resume look.
    expect(
      screen.queryByRole("switch", { name: "Write resumes when I shortlist" }),
    ).toBeNull();

    const checked = (name: RegExp) =>
      screen.getByRole("radio", { name }).getAttribute("aria-checked");
    expect(checked(/Suggest a little/)).toBe("true");
    // Reply length was cut: the assistant keeps its stored reply style.
    expect(
      screen.queryByRole("radiogroup", {
        name: "How the profile assistant replies",
      }),
    ).toBeNull();
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

  it("sends only this section's slice with each choice, coalescing choices made while a save runs", async () => {
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
    fireEvent.click(
      screen.getByRole("switch", { name: "Count remote jobs as any location" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /Only what I ask/ }));
    expect(onUpdateAiBehavior).toHaveBeenCalledTimes(1);

    await act(() => {
      finishFirst(true);
      return Promise.resolve();
    });

    await waitFor(() => expect(onUpdateAiBehavior).toHaveBeenCalledTimes(2));
    // Only this section's fields: an Applying or cover-letter edit can
    // never be overwritten by this section's older copy.
    expect(onUpdateAiBehavior.mock.calls[1]?.[0]).toEqual({
      aiBehavior: {
        profileAssistant: {
          initiative: "answer_only",
          replyStyle: "brief",
        },
        jobSearch: { remoteCountsAsAnyLocation: false },
        browserPermissions: {
          solveCaptchas: false,
          googleSignIn: false,
          signIn: false,
          createAccounts: false,
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByText(/AI behavior saved/)).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: "Save AI behavior" }),
    ).toBeNull();
  });

  it("keeps each in-app browser permission off until turned on, and saves each on its own", async () => {
    const onUpdateAiBehavior = vi
      .fn<(input: UpdateAiBehaviorInput) => Promise<boolean>>()
      .mockResolvedValue(true);
    renderSection(onUpdateAiBehavior);

    const group = within(screen.getByTestId("settings-ai-browser"));
    expect(group.getByText("In-app browser")).toBeTruthy();
    // The scope is every browser task, and sending is not one of these.
    expect(group.getByText(/in searches, applications/)).toBeTruthy();
    expect(
      group.getByText(/sent stays your choice under Applying/),
    ).toBeTruthy();
    const toggle = (name: string) => group.getByRole("switch", { name });
    const names = [
      "Solve CAPTCHAs",
      "Sign in to websites",
      "Use Google to sign in or sign up",
      "Create website accounts",
    ];
    for (const name of names)
      expect(toggle(name).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle("Sign in to websites"));
    expect(onUpdateAiBehavior.mock.calls[0]?.[0].aiBehavior).toMatchObject({
      browserPermissions: {
        solveCaptchas: false,
        signIn: true,
        createAccounts: false,
      },
    });
    await waitFor(() =>
      expect(screen.getByText(/AI behavior saved/)).toBeTruthy(),
    );

    fireEvent.click(toggle("Create website accounts"));
    await waitFor(() => expect(onUpdateAiBehavior).toHaveBeenCalledTimes(2));
    expect(
      onUpdateAiBehavior.mock.calls[1]?.[0].aiBehavior?.browserPermissions,
    ).toEqual({
      solveCaptchas: false,
      signIn: true,
      googleSignIn: false,
      createAccounts: true,
    });
    expect(toggle("Solve CAPTCHAs").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle("Use Google to sign in or sign up"));
    await waitFor(() => expect(onUpdateAiBehavior).toHaveBeenCalledTimes(3));
    expect(
      onUpdateAiBehavior.mock.calls[2]?.[0].aiBehavior?.browserPermissions,
    ).toEqual({
      solveCaptchas: false,
      signIn: true,
      googleSignIn: true,
      createAccounts: true,
    });
  });

  it("shows saved browser permissions as they are", () => {
    renderSection(
      vi.fn(() => Promise.resolve(true)),
      parseSettings({
        aiBehavior: AiBehaviorPreferenceSchema.parse({
          browserPermissions: { solveCaptchas: true },
        }),
      }),
    );
    const group = within(screen.getByTestId("settings-ai-browser"));
    expect(
      group
        .getByRole("switch", { name: "Solve CAPTCHAs" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      group
        .getByRole("switch", { name: "Sign in to websites" })
        .getAttribute("aria-checked"),
    ).toBe("false");
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
});
