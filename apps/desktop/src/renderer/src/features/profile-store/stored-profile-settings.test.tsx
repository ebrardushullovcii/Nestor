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
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  CandidateExperienceSchema,
  type DesktopJobsBridge,
} from "@nestor/contracts";
import {
  openJobStore,
  createProfileStore,
  createPreferencesStore,
  createJobSitesStore,
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
function profileScreen(
  section = "basics",
  analyzing = false,
  feedback: ComponentProps<
    typeof StoredProfileScreen
  >["discoveryRunFeedback"] = null,
) {
  render(
    <MemoryRouter initialEntries={[`/job-finder/profile?section=${section}`]}>
      <StoredProfileScreen
        discoveryRunFeedback={feedback}
        actionState={{ message: null }}
        importResumeGuardMessage={null}
        latestResumeImportReviewCandidates={[]}
        latestResumeImportRun={null}
        recentSourceDebugRuns={[]}
        resumeImportProgress={null}
        sourceAccessPrompts={[]}
        sourceInstructionArtifacts={[]}
        profileSetupState={{
          status: "completed",
          currentStep: "ready_check",
          completedAt: "2026-01-01T00:00:00.000Z",
          lastResumedAt: null,
          reviewItems: [],
        }}
        pendingActions={{
          analyzeProfile: analyzing,
          importResume: false,
          profileCopilotBusy: false,
          profileMutation: false,
          profileSetup: false,
          browserSession: () => false,
          profileReviewItem: () => false,
          sourceDebug: () => false,
          sourceInstruction: () => false,
          sourceInstructionVerify: () => false,
          targetDiscovery: () => false,
        }}
        onApplyProfileSetupReviewAction={() => {}}
        onAnalyzeProfileFromResume={() => {}}
        onApplyResumeTimelineRepairAction={async () => {}}
        onGetSourceDebugRunDetails={() => Promise.reject(Error("unused"))}
        onImportResume={() => {}}
        onOpenBrowserSessionForTarget={() => {}}
        onProfileSurfaceDirtyChange={() => {}}
        onResumeProfileSetup={() => {}}
        onRunSourceDebug={() => {}}
        onSaveSourceInstructionArtifact={() => {}}
        onVerifySourceInstructions={() => {}}
      />
    </MemoryRouter>,
  );
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
      <StoredSettingsScreen
        availableResumeTemplates={[]}
        browserSession={{
          source: "target_site",
          status: "unknown",
          driver: "catalog_seed",
          label: "Idle",
          detail: null,
          lastCheckedAt: "2026-01-01T00:00:00.000Z",
        }}
        isWorkspaceResetPending={false}
        onResetWorkspace={() => {}}
        onSettingsDraftEdited={() => {}}
      />
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

test("per-source feedback uses the current site row even after its label changed", async () => {
  const sites = createJobSitesStore(store);
  sites.add({ text: "https://synthetic.test/jobs" });
  const site = sites.list().rows[0]!;
  sites.update({ id: site.id, label: "Renamed source" });
  profileScreen("sources", false, {
    status: "failed",
    detail: "Read failed",
    headline: "This site's read failed.",
    recovery: null,
    targetLabel: "Old source label",
    targetId: String(site.id),
  });
  expect(await screen.findByText("This site's read failed.")).not.toBeNull();
  expect(
    calls.some(
      (call) =>
        call.name === "get_site" &&
        JSON.stringify(call.input) === JSON.stringify({ id: site.id }),
    ),
  ).toBe(true);
});
