// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import {
  ProfileSetupStateSchema,
  type DesktopJobsBridge,
  type DesktopProfileWorkflowBridge,
  type ProfileWorkflowCommand,
  type ProfileWorkflowState,
} from "@nestor/contracts";
import {
  createPreferencesStore,
  createProfileStore,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createJobCommandRunner } from "@nestor/job-finder/job-commands";
import { StoredProfileSetupScreen } from "./stored-profile-setup-screen";

let store: JobStore;
let calls: { name: string; input: unknown }[];
let workflow: ProfileWorkflowCommand[];
let state: ProfileWorkflowState;
// While set, the screen hears of no store change (an edit it never saw).
let quiet = false;

beforeEach(() => {
  store = openJobStore(":memory:");
  calls = [];
  workflow = [];
  quiet = false;
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const run = createJobCommandRunner({ store });
  const jobs: DesktopJobsBridge = {
    run: (name, input) => {
      calls.push({ name, input });
      return run(name, input);
    },
    onChange: (listener) =>
      store.onChange((change) => {
        if (!quiet) listener(change);
      }),
    onSearchStatus: () => () => {},
  };
  state = {
    profileSetupState: {
      status: "in_progress",
      currentStep: "essentials",
      completedAt: null,
      lastResumedAt: null,
      reviewItems: [],
    },
    latestResumeImportRun: null,
    latestResumeImportReviewCandidates: [],
    resumeImportActive: false,
  };
  const profileWorkflow: DesktopProfileWorkflowBridge = {
    run: (command) => {
      workflow.push(command);
      if (command.type === "save_setup_state")
        state = {
          ...state,
          profileSetupState: ProfileSetupStateSchema.parse(command.state),
        };
      return Promise.resolve({ state, message: null });
    },
    importResume: () => new Promise(() => {}),
    cancelImportResume: () => {},
    checkSite: () => new Promise(() => {}),
  };
  Object.assign(window, { nestor: { jobs, profileWorkflow } });
  createProfileStore(store).patch({
    fields: {
      firstName: "Synthetic",
      lastName: "Candidate",
      fullName: "Synthetic Candidate",
      email: "synthetic@example.test",
      headline: "Analyst",
      currentLocation: "Berlin",
    },
  });
  createPreferencesStore(store).goals.patch({
    lists: { targetRoles: ["Data Analyst"] },
  });
});
afterEach(() => {
  cleanup();
  store.close();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

function renderSetup() {
  const router = createMemoryRouter(
    [
      {
        path: "/job-finder/profile/setup",
        element: <StoredProfileSetupScreen />,
      },
      { path: "*", element: <p>Elsewhere</p> },
    ],
    { initialEntries: ["/job-finder/profile/setup"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

test("a setup step saves only what changed, then the step reached", async () => {
  renderSetup();
  const headline = await screen.findByLabelText(/^Headline/u);
  fireEvent.change(headline, { target: { value: "Senior Analyst" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save and continue to Work history" }),
  );
  await waitFor(() =>
    expect(state.profileSetupState.currentStep).toBe("background"),
  );
  expect(createProfileStore(store).overview().fields.headline).toBe(
    "Senior Analyst",
  );
  const commits = calls.filter((call) => call.name === "commit_profile_edits");
  expect(commits).toHaveLength(1);
  expect(commits[0]!.input).toMatchObject({
    profile: {
      fields: { headline: "Senior Analyst" },
      expected: { headline: "Analyst" },
    },
  });
  // Nothing outside the edited field crossed the bridge.
  expect(
    Object.keys(
      (commits[0]!.input as { profile: { fields: object } }).profile.fields,
    ),
  ).toEqual(["headline"]);
  expect(workflow.map((command) => command.type)).toContain("save_setup_state");
});

test("a profile change setup never saw is not overwritten", async () => {
  renderSetup();
  const headline = await screen.findByLabelText(/^Headline/u);
  quiet = true;
  createProfileStore(store).patch({
    fields: { headline: "Changed elsewhere" },
  });
  fireEvent.change(headline, { target: { value: "Typed in setup" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save and continue to Work history" }),
  );
  await waitFor(() =>
    expect(calls.some((call) => call.name === "commit_profile_edits")).toBe(
      true,
    ),
  );
  // The edit was checked against the value setup read; the newer one stays,
  // and setup does not move on as if it had saved.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(createProfileStore(store).overview().fields.headline).toBe(
    "Changed elsewhere",
  );
  expect(state.profileSetupState.currentStep).toBe("essentials");
});
