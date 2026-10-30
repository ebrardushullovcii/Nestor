// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  createMemoryRouter,
} from "react-router-dom";
import {
  CandidateExperienceSchema,
  ResumeImportRunSchema,
  type DesktopJobsBridge,
  type DesktopProfileWorkflowBridge,
  type ProfileWorkflowState,
} from "@nestor/contracts";
import {
  openJobStore,
  createProfileStore,
  createPreferencesStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createJobCommandRunner } from "@nestor/job-finder/job-commands";
import { StoredProfileScreen } from "./stored-profile-screen";
import { StoredSettingsScreen } from "./stored-settings-screen";

let store: JobStore;
let calls: { name: string; input: unknown }[];
let pauseCommit: Promise<void> | null;
beforeEach(() => {
  store = openJobStore(":memory:");
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  calls = [];
  pauseCommit = null;
  const run = createJobCommandRunner({ store });
  const jobs: DesktopJobsBridge = {
    run: (name, input) => {
      calls.push({ name, input });
      return pauseCommit && name === "commit_profile_edits"
        ? pauseCommit.then(() => run(name, input))
        : run(name, input);
    },
    onChange: (listener) => store.onChange(listener),
    onSearchStatus: () => () => {},
  };
  Object.assign(window, { nestor: { jobs } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const profile = createProfileStore(store);
  profile.patch({
    fields: {
      firstName: "Synthetic",
      lastName: "Candidate",
      fullName: "Synthetic Candidate",
      email: "synthetic@example.test",
      headline: "Analyst",
      currentLocation: "Berlin",
      "professionalSummary.shortValueProposition": "Builds useful reports.",
    },
  });
  for (let n = 0; n < 30; n++)
    profile.records.upsert({
      collection: "experiences",
      record: CandidateExperienceSchema.parse({
        id: `work-${n}`,
        title: `Analyst ${n}`,
        companyName: "Synthetic Employer",
        startDate: "2020-01",
        workMode: [],
      }),
    });
  createPreferencesStore(store).goals.patch({
    lists: { targetRoles: ["Data Analyst"], workModes: ["remote"] },
  });
});
afterEach(() => {
  cleanup();
  store.close();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});
function profileScreen(section = "basics", analyzing = false) {
  const state: ProfileWorkflowState = {
    profileSetupState: {
      status: "completed",
      currentStep: "ready_check",
      completedAt: "2026-01-01T00:00:00.000Z",
      lastResumedAt: null,
      reviewItems: [],
    },
    // A run still reading the resume is how Profile knows analysis is on.
    latestResumeImportRun: analyzing
      ? ResumeImportRunSchema.parse({
          id: "synthetic",
          sourceResumeId: "synthetic",
          sourceResumeFileName: "synthetic.pdf",
          status: "parsing",
          startedAt: "2026-10-26T00:00:00.000Z",
        })
      : null,
    latestResumeImportReviewCandidates: [],
    resumeImportActive: analyzing,
  };
  Object.assign(window.nestor, {
    profileWorkflow: {
      run: () =>
        Promise.resolve({ state, message: null, siteInstructions: [] }),
      importResume: () => new Promise(() => {}),
      cancelImportResume: () => {},
      checkSite: () => new Promise(() => {}),
    } satisfies DesktopProfileWorkflowBridge,
  });
  // Profile guards unsaved edits with a route blocker, which needs a data
  // router.
  const router = createMemoryRouter(
    [{ path: "*", element: <StoredProfileScreen /> }],
    { initialEntries: [`/job-finder/profile?section=${section}`] },
  );
  render(<RouterProvider router={router} />);
}
test("Profile saves an edited field without loading or sending unseen work history", async () => {
  profileScreen();
  const headline = await screen.findByLabelText(/^Headline/u);
  expect(
    calls.filter((call) => call.name === "list_profile_records"),
  ).toHaveLength(0);
  expect(
    screen
      .getByRole("tab", { name: "Work history" })
      .getAttribute("data-profile-section-progress-state"),
  ).toBe("complete");
  fireEvent.change(headline, { target: { value: "Senior Analyst" } });
  expect(screen.queryByRole("button", { name: /Save changes/u })).toBeNull();
  await screen.findByText("Profile saved.");
  expect(createProfileStore(store).overview().fields.headline).toBe(
    "Senior Analyst",
  );
  expect(createProfileStore(store).overview().counts.experiences).toBe(30);
  const save = calls.find((call) => call.name === "commit_profile_edits");
  expect(save?.input).toMatchObject({
    profile: { fields: { headline: "Senior Analyst" } },
    upsert: [],
    remove: [],
  });
  expect(JSON.stringify(save?.input)).not.toContain("Synthetic Employer");
});
test("work-history pages keep unseen records and lock paging until edits save", async () => {
  profileScreen("experience");
  await screen.findByText("1–25 of 30");
  const title = (await screen.findAllByLabelText(/^Title$/u))[0]!;
  fireEvent.change(title, { target: { value: "Lead Analyst" } });
  const pager = screen.getByRole("navigation", { name: "Work history pages" });
  expect(
    within(pager)
      .getByRole("button", { name: "Next" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await screen.findByText("Profile saved.");
  const next = () =>
    within(
      screen.getByRole("navigation", { name: "Work history pages" }),
    ).getByRole("button", { name: "Next" });
  await waitFor(() => expect(next().hasAttribute("disabled")).toBe(false));
  fireEvent.click(next());
  await screen.findByText("26–30 of 30");
  expect(
    createProfileStore(store).records.get("experiences", "work-29"),
  ).not.toBeNull();
  expect(
    createProfileStore(store).records.get("experiences", "work-0"),
  ).toMatchObject({ record: { title: "Lead Analyst" } });
  expect(
    calls.find((call) => call.name === "commit_profile_edits")?.input,
  ).toMatchObject({
    upsert: [{ collection: "experiences", record: { id: "work-0" } }],
    remove: [],
  });
});
test("typing during an autosave keeps the latest work-history edit and input focus", async () => {
  let release: (() => void) | undefined;
  pauseCommit = new Promise<void>((resolve) => {
    release = resolve;
  });
  profileScreen("experience");
  await screen.findByText("1–25 of 30");
  const title = (await screen.findAllByLabelText(/^Title$/u))[0]!;
  title.focus();
  fireEvent.change(title, { target: { value: "Senior Analyst" } });
  await waitFor(() =>
    expect(
      calls.filter((call) => call.name === "commit_profile_edits"),
    ).toHaveLength(1),
  );
  fireEvent.change(title, {
    target: { value: "Senior Analyst, Data Products" },
  });
  await act(() => Promise.resolve().then(() => release!()));
  await waitFor(() =>
    expect(
      createProfileStore(store).records.get("experiences", "work-0"),
    ).toMatchObject({ record: { title: "Senior Analyst, Data Products" } }),
  );
  expect(document.activeElement).toBe(title);
  expect(title.isConnected).toBe(true);
  expect(createProfileStore(store).overview().counts.experiences).toBe(30);
});

test("a competing Assistant record edit is kept; the blocked draft survives leaving and can be recovered", async () => {
  let release: (() => void) | undefined;
  pauseCommit = new Promise<void>((resolve) => {
    release = resolve;
  });
  profileScreen("experience");
  await screen.findByText("1–25 of 30");
  fireEvent.change((await screen.findAllByLabelText(/^Title$/u))[0]!, {
    target: { value: "My kept title" },
  });
  await waitFor(() =>
    expect(calls.some((call) => call.name === "commit_profile_edits")).toBe(
      true,
    ),
  );
  const profile = createProfileStore(store);
  const original = profile.records.get("experiences", "work-0");
  if (!original || original.collection !== "experiences")
    throw Error("Missing fixture");
  act(() => {
    profile.records.upsert({
      ...original,
      record: {
        ...original.record,
        title: "Assistant's current title",
        summary: "Assistant context must stay",
      },
    });
  });
  await act(() => Promise.resolve().then(() => release!()));
  await screen.findByText(/saved experiences record changed while/u);
  expect(profile.records.get("experiences", "work-0")?.record).toMatchObject({
    title: "Assistant's current title",
  });
  cleanup();
  const kept = await window.nestor.jobs.run("get_profile_draft", {});
  expect(kept?.edits.upsert).toHaveLength(1);
  expect(kept?.edits.upsert[0]?.record).toMatchObject({
    id: "work-0",
    title: "My kept title",
  });
  pauseCommit = null;
  profileScreen("experience");
  await screen.findByText(
    "Your unsaved edits were kept. Review them before replacing the current saved values.",
  );
  fireEvent.click(screen.getByText("Review kept changes"));
  expect(screen.getByText(/My kept title/u)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Restore my edits" }));
  await waitFor(() =>
    expect(profile.records.get("experiences", "work-0")?.record).toMatchObject({
      title: "My kept title",
      summary: "Assistant context must stay",
    }),
  );
  expect(await window.nestor.jobs.run("get_profile_draft", {})).toBeNull();
  expect(profile.overview().counts.experiences).toBe(30);
  expect(profile.records.get("experiences", "work-1")?.record).toMatchObject({
    title: "Analyst 1",
  });
});

test("Profile autosaves later edits to shifts and weekly hours", async () => {
  profileScreen("preferences");
  const shifts = await screen.findByLabelText("Shifts"),
    minimum = screen.getByLabelText("Minimum weekly hours"),
    maximum = screen.getByLabelText("Maximum weekly hours");
  fireEvent.change(shifts, { target: { value: "day" } });
  fireEvent.change(minimum, { target: { value: "10" } });
  fireEvent.change(maximum, { target: { value: "20" } });
  await waitFor(() =>
    expect(createPreferencesStore(store).goals.read()).toMatchObject({
      shiftPreference: "day",
      weeklyHours: { minimum: 10, maximum: 20 },
    }),
  );
  fireEvent.change(minimum, { target: { value: "12" } });
  fireEvent.change(maximum, { target: { value: "18" } });
  await waitFor(() =>
    expect(createPreferencesStore(store).goals.read().weeklyHours).toEqual({
      minimum: 12,
      maximum: 18,
    }),
  );
});

test("Settings saves Apply mode and appearance independently and follows other writers live", async () => {
  const preferences = createPreferencesStore(store);
  render(
    <MemoryRouter>
      <StoredSettingsScreen />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("radio", { name: /Send for me/u }));
  await waitFor(() =>
    expect(preferences.settings.read().applicationAutomationMode).toBe(
      "autonomous_submit",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  await waitFor(() =>
    expect(preferences.settings.read().appearanceTheme).toBe("dark"),
  );
  expect(preferences.settings.read().applicationAutomationMode).toBe(
    "autonomous_submit",
  );
  expect(
    calls
      .filter((call) => call.name === "patch_settings")
      .map((call) => call.input),
  ).toEqual([
    {
      fields: { applicationAutomationMode: "autonomous_submit" },
      expected: { applicationAutomationMode: "confirm_before_submit" },
    },
    {
      fields: { appearanceTheme: "dark" },
      expected: { appearanceTheme: "system" },
    },
  ]);
  act(() => {
    preferences.settings.patch({ fields: { appearanceTheme: "light" } });
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Light" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
});

test("Settings saves one in-app browser permission without touching the others", async () => {
  const preferences = createPreferencesStore(store);
  render(
    <MemoryRouter>
      <StoredSettingsScreen />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("switch", { name: "Sign in to websites" }),
  );
  await waitFor(() =>
    expect(preferences.settings.read().aiBehavior?.browserPermissions).toEqual({
      solveCaptchas: false,
      googleSignIn: false,
      signIn: true,
      createAccounts: false,
    }),
  );
  expect(
    calls
      .filter((call) => call.name === "patch_settings")
      .map((call) => call.input),
  ).toEqual([
    {
      fields: { "aiBehavior.browserPermissions.signIn": true },
      expected: { "aiBehavior.browserPermissions.signIn": false },
    },
  ]);
});

test("Settings can enable Google's default-off permission in an upgraded workspace", async () => {
  const preferences = createPreferencesStore(store);
  preferences.settings.patch({
    fields: { "aiBehavior.browserPermissions.signIn": true },
  });
  // An existing settings row gets NULL when this permission is added.
  store
    .sql(
      "UPDATE profile_settings SET ai_behavior_browser_permissions_google_sign_in=NULL",
    )
    .run();
  const view = render(
    <MemoryRouter>
      <StoredSettingsScreen />
    </MemoryRouter>,
  );
  const label = "Use Google to sign in or sign up";
  const toggle = await screen.findByRole("switch", { name: label });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await screen.findByText("AI behavior saved.");
  expect(preferences.settings.read().aiBehavior?.browserPermissions).toEqual({
    solveCaptchas: false,
    signIn: true,
    googleSignIn: true,
    createAccounts: false,
  });
  expect(calls.filter((call) => call.name === "patch_settings")).toEqual([
    {
      name: "patch_settings",
      input: {
        fields: { "aiBehavior.browserPermissions.googleSignIn": true },
        expected: { "aiBehavior.browserPermissions.googleSignIn": false },
      },
    },
  ]);
  view.unmount();
  render(
    <MemoryRouter>
      <StoredSettingsScreen />
    </MemoryRouter>,
  );
  expect(
    (await screen.findByRole("switch", { name: label })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
});

test("Reset everything clears the workspace and opens guided setup", async () => {
  const resetWorkspace = vi.fn(() => Promise.resolve());
  Object.assign(window.nestor, { jobFinder: { resetWorkspace } });
  render(
    <MemoryRouter initialEntries={["/job-finder/settings"]}>
      <Routes>
        <Route element={<StoredSettingsScreen />} path="/job-finder/settings" />
        <Route element={<p>Guided setup</p>} path="/job-finder/profile/setup" />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Reset everything" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reset workspace" }));
  expect(await screen.findByText("Guided setup")).not.toBeNull();
  expect(resetWorkspace).toHaveBeenCalledOnce();
});

test("edits typed during resume analysis are flushed when Profile unmounts", async () => {
  profileScreen("basics", true);
  const headline = await screen.findByLabelText(/^Headline/u);
  fireEvent.change(headline, { target: { value: "Kept during analysis" } });
  cleanup();
  await waitFor(() =>
    expect(createProfileStore(store).overview().fields.headline).toBe(
      "Kept during analysis",
    ),
  );
});

test("a primary contact autosave cannot replay its former application email", async () => {
  profileScreen();
  const email = await screen.findByRole("textbox", {
    name: "Email",
  });
  email.focus();
  fireEvent.change(email, { target: { value: "new-contact@example.test" } });
  await waitFor(() =>
    expect(
      createProfileStore(store).read().applicationIdentity.preferredEmail,
    ).toBe("new-contact@example.test"),
  );
  await screen.findByText("Profile saved.");
  expect(document.activeElement).toBe(email);
  fireEvent.change(screen.getByLabelText(/^Headline/u), {
    target: { value: "Another edit" },
  });
  await waitFor(() =>
    expect(createProfileStore(store).overview().fields.headline).toBe(
      "Another edit",
    ),
  );
  expect(
    createProfileStore(store).read().applicationIdentity.preferredEmail,
  ).toBe("new-contact@example.test");
});
