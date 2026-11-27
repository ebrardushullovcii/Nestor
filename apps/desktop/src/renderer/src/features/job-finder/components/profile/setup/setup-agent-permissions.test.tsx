// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { DesktopJobsBridge } from "@nestor/contracts";
import {
  createPreferencesStore,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createJobCommandRunner } from "@nestor/job-finder/job-commands";
import { SetupAgentPermissions } from "./setup-agent-permissions";

let store: JobStore;
beforeEach(() => {
  store = openJobStore(":memory:");
  const run = createJobCommandRunner({ store });
  const jobs: DesktopJobsBridge = {
    run: (name, input) => run(name, input),
    onChange: (listener) => store.onChange(listener),
    onSearchStatus: () => () => {},
  };
  Object.assign(window, { nestor: { jobs } });
});
afterEach(() => {
  cleanup();
  store.close();
});

test("Guided setup shows a new profile's full access, each switch on and each one saves alone", async () => {
  const preferences = createPreferencesStore(store);
  render(<SetupAgentPermissions />);
  const names = [
    "Solve CAPTCHAs",
    "Sign in to websites",
    "Use Google to sign in or sign up",
    "Create website accounts",
    "Answer pay questions",
  ];
  for (const name of names)
    expect(
      (await screen.findByRole("switch", { name })).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  // One plain line each says what it lets the agent do.
  expect(
    screen.getByText(/Makes an account when a site needs one/),
  ).toBeTruthy();

  fireEvent.click(
    screen.getByRole("switch", { name: "Create website accounts" }),
  );
  await waitFor(() =>
    expect(preferences.settings.read().aiBehavior?.browserPermissions).toEqual({
      solveCaptchas: true,
      signIn: true,
      googleSignIn: true,
      createAccounts: false,
    }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("switch", { name: "Answer pay questions" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch", { name: "Answer pay questions" }));
  await waitFor(() =>
    expect(preferences.settings.read().salaryDisclosure).toBe("pause_for_user"),
  );
  expect(preferences.settings.read().aiBehavior?.browserPermissions).toEqual({
    solveCaptchas: true,
    signIn: true,
    googleSignIn: true,
    createAccounts: false,
  });
});
