// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Link, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FoundJob } from "@nestor/contracts";
import {
  createApplicationStore,
  type ApplicationStore,
} from "@nestor/db/applications";
import {
  approveOriginalResumesForTests,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { ToastProvider } from "@renderer/components/ui/toast";
import { createNeedsYouCommandRunner } from "@nestor/job-finder/applications";
import { NeedsYouScreen } from "./needs-you-screen";
import { SourceNeedPane } from "./source-need-pane";
import { workThrough } from "./work-through";
import {
  createJobSitesStore,
  createSourceAccessStore,
} from "@nestor/db/job-store";
import { waitForDisplayedDestination } from "../job-finder/assistant/navigation-display";

it("opens a site through its Needs you item and checks it again without dismissing it", async () => {
  const open = vi.fn(() => Promise.resolve(true));
  const run = vi.fn((name: string) =>
    Promise.resolve(
      name === "retry_source"
        ? { search: { id: "search_1", state: "running" }, sources: [] }
        : { rows: [], nextCursor: null, total: 0 },
    ),
  );
  Object.assign(window.nestor, {
    needsYou: { run: open },
    jobs: {
      run,
      onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
        jobs.onChange(listener),
      onSearchStatus: () => () => undefined,
    },
  });
  render(
    <SourceNeedPane
      check={undefined}
      host="jobs.example.test"
      site={{
        id: 7,
        kind: "site",
        label: "Example board",
        taskIds: [7],
        sources: [{ id: 900, url: "https://jobs.example.test/sign-in" }],
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open to sign in" }));
  expect(open).toHaveBeenCalledWith("open_need", { id: 7 });
  fireEvent.click(
    screen.getByRole("button", { name: "I've signed in, check it" }),
  );
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith("retry_source", { id: 900 }),
  );
  expect(
    screen.getByRole("heading", { name: "Sign in to Example board" }),
  ).toBeTruthy();
  expect(
    screen.getByText(/This item closes when the site is readable/),
  ).toBeTruthy();
});

let jobs: JobStore;
let applications: ApplicationStore;
let claimed: NonNullable<ReturnType<ApplicationStore["claimNext"]>>[];
beforeEach(() => {
  jobs = openJobStore(":memory:");
  const { added } = jobs.saveFoundJobs({
    searchId: null,
    jobs: Array.from(
      { length: 3 },
      (_, i): FoundJob => ({
        title: `Engineer ${i}`,
        company: `Employer ${i}`,
        location: "Remote",
        workModes: ["remote"],
        url: `https://jobs.example.test/${i}`,
        applyUrl: null,
        sourceId: "board",
        sourceLabel: "Board",
        sourceJobId: String(i),
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: null,
        employmentType: null,
        summary: null,
        description: "Synthetic job",
      }),
    ),
  });
  approveOriginalResumesForTests(jobs, added);
  applications = createApplicationStore(jobs);
  applications.applyJobs({ selection: { ids: added } });
  claimed = [
    applications.claimNext()!,
    applications.claimNext()!,
    applications.claimNext()!,
  ];
  const run = createNeedsYouCommandRunner(() => applications, {
    retry: () => Promise.resolve(),
    open: () => Promise.resolve(true),
    check: () => Promise.resolve(false),
  });
  Object.assign(window, {
    nestor: {
      jobs: {
        onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
          jobs.onChange(listener),
      },
      needsYou: { run },
    },
  });
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  workThrough.reset();
  jobs.close();
  vi.unstubAllGlobals();
});
function ask(
  index: number,
  key = "notice",
  prompt = "What is your notice period?",
  input: "text" | "boolean" | "file" = "text",
) {
  const row = claimed[index]!;
  const result = applications.needsYou.request({
    applicationId: row.id,
    attempt: row.attempt,
    fieldKey: key,
    key,
    scope: {},
    prompt,
    kind: "question",
    input,
    options: [],
  });
  if (result.status !== "needs_you") throw new Error("Missing question");
  return result.task;
}
function show(route = "/job-finder/actions", nextRoute?: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        {nextRoute ? <Link to={nextRoute}>Test navigation request</Link> : null}
        <main>
          <NeedsYouScreen />
        </main>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function savedAnswer(index: number) {
  return applications.needsYou.remember({
    key: `window-${index}`,
    prompt: `Window question ${index}?`,
    answer: `Synthetic answer ${index}`,
    input: "text",
    options: [],
    scope: {},
  });
}

it("keeps an unchecked answer when a new answer pushes it past the 50-row window, then forgets only the rest", async () => {
  const kept = savedAnswer(0);
  for (let index = 1; index < 50; index += 1) savedAnswer(index);
  const before = applications.needsYou.savedAnswer(kept.id);
  show(
    `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify({ tab: "saved" }))}`,
  );
  const checkbox = await screen.findByRole("checkbox", {
    name: `Select ${kept.prompt}`,
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select all 50 answers" }),
  );
  fireEvent.click(checkbox);
  await screen.findByText("49 selected");
  act(() => {
    savedAnswer(50);
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("checkbox", { name: `Select ${kept.prompt}` }),
    ).toBeNull(),
  );
  await screen.findByText("50 selected");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Forget selected" }),
    ).toHaveProperty("disabled", false),
  );
  expect(
    JSON.parse(
      document
        .querySelector("[data-needs-list-state]")!
        .getAttribute("data-needs-list-state")!,
    ),
  ).toMatchObject({ all: true, selectedIds: [kept.id] });
  fireEvent.click(screen.getByRole("button", { name: "Forget selected" }));
  await waitFor(() =>
    expect(applications.needsYou.listAnswers().total).toBe(1),
  );
  expect(applications.needsYou.savedAnswer(kept.id)).toEqual(before);
});

it("keeps a real explicit selection outside the loaded window and forgets that exact answer", async () => {
  const chosen = savedAnswer(0);
  for (let index = 1; index < 255; index += 1) savedAnswer(index);
  const view = { tab: "saved", selectedIds: [chosen.id] };
  const route = `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify(view))}`;
  show(route);
  await screen.findByText("1 selected");
  expect(
    screen.queryByRole("checkbox", { name: `Select ${chosen.prompt}` }),
  ).toBeNull();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Forget selected" }),
    ).toHaveProperty("disabled", false),
  );
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "displayed" });
  fireEvent.click(screen.getByRole("button", { name: "Forget selected" }));
  await waitFor(() =>
    expect(applications.needsYou.savedAnswer(chosen.id)).toBeNull(),
  );
  expect(applications.needsYou.listAnswers().total).toBe(254);
});

it.each(["missing", "other tab", "outside filter"])(
  "does not confirm a selected ID that is %s",
  async (kind) => {
    const first = ask(0);
    let invalid = 999;
    if (kind === "outside filter")
      invalid = ask(
        1,
        "interviews",
        "When are you available for interviews?",
      ).id;
    if (kind === "other tab") {
      for (const key of ["format", "travel"])
        applications.needsYou.remember({
          key,
          prompt: `Saved ${key}?`,
          answer: "Yes",
          input: "text",
          options: [],
          scope: { country: "", siteOrigin: "" },
        });
      invalid = applications.needsYou
        .listAnswers()
        .rows.find((row) => row.id !== first.id)!.id;
    }
    const view = { tab: "tasks", text: "notice", selectedIds: [invalid] };
    const route = `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify(view))}`;
    show(route);
    const checkbox = await screen.findByRole("checkbox", {
      name: `Select ${first.prompt}`,
    });
    await waitFor(() =>
      expect(checkbox.getAttribute("aria-checked")).toBe("false"),
    );
    const state = JSON.parse(
      document
        .querySelector("[data-needs-list-state]")!
        .getAttribute("data-needs-list-state")!,
    ) as { selectedIds: number[] };
    expect(state.selectedIds).toEqual([]);
    expect(screen.queryByText("1 selected")).toBeNull();
    expect(
      await waitForDisplayedDestination(route, () => route, 0),
    ).toMatchObject({ status: "blocked" });
  },
);

it("does not subtract a stale exception from Select all or acknowledge it", async () => {
  const task = ask(0);
  const view = { tab: "tasks", all: true, selectedIds: [999] };
  const route = `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify(view))}`;
  show(route);
  await waitFor(() =>
    expect(
      screen
        .getByRole("checkbox", { name: `Select ${task.prompt}` })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(screen.getByText("1 selected")).toBeTruthy();
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "blocked" });
});

it.each(["tasks", "saved"] as const)(
  "blocks a stale %s focus and returns to the normal first item",
  async (tab) => {
    const task = ask(0);
    if (tab === "saved")
      applications.needsYou.answer({
        id: task.id,
        answer: "Four weeks",
        remember: true,
      });
    const route = `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify({ tab, focusId: 999 }))}`;
    show(route);
    await screen.findByRole("textbox", { name: task.prompt });
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-needs-detail-id]")
          ?.getAttribute("data-needs-detail-id"),
      ).not.toBe("999"),
    );
    expect(
      screen.queryByText("This item is no longer waiting for you."),
    ).toBeNull();
    expect(screen.queryByText("This answer has been forgotten.")).toBeNull();
    expect(
      await waitForDisplayedDestination(route, () => route, 0),
    ).toMatchObject({ status: "blocked" });
  },
);

it("opens and selects the requested filtered question instead of the first task", async () => {
  ask(0);
  const question = ask(
    1,
    "availability",
    "When are you available for interviews?",
  );
  const view = {
    tab: "tasks",
    kind: "question",
    text: "interviews",
    focusId: question.id,
    selectedIds: [question.id],
  };
  show(`/job-finder/actions?needs=${encodeURIComponent(JSON.stringify(view))}`);
  await screen.findByRole("textbox", { name: question.prompt });
  await waitFor(() =>
    expect(
      screen
        .getByRole("checkbox", { name: `Select ${question.prompt}` })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(
    screen.queryByRole("button", { name: /^What is your notice/ }),
  ).toBeNull();
});

it("loads a focused question outside the first page without treating it as a saved answer", async () => {
  ask(0);
  const question = ask(
    1,
    "availability",
    "When are you available for interviews?",
  );
  show(
    `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify({ tab: "tasks", text: "notice", focusId: question.id }))}`,
  );
  await screen.findByRole("textbox", { name: question.prompt });
  expect(
    screen.getByRole("searchbox", { name: "Filter Needs you" }),
  ).toHaveProperty("value", "notice");
  expect(screen.queryByRole("region", { name: "Saved answer" })).toBeNull();
});

it("opens Saved answers, applies its text filter and focuses the requested saved answer", async () => {
  const task = ask(0);
  applications.needsYou.answer({
    id: task.id,
    answer: "Four weeks",
    remember: true,
  });
  const answer = applications.needsYou.listAnswers().rows[0]!;
  show(
    `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify({ tab: "saved", text: "notice", focusId: answer.id, all: true, selectedIds: [] }))}`,
  );
  const pane = await screen.findByRole("region", { name: "Saved answer" });
  await within(pane).findByRole("textbox", { name: task.prompt });
  expect(
    screen
      .getByRole("button", { name: "Saved answers 1" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await waitFor(() =>
    expect(
      screen
        .getByRole("checkbox", { name: `Select ${task.prompt}` })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

it("keeps unsaved typing when a new chat navigation requests another question", async () => {
  const first = ask(0);
  const second = ask(
    1,
    "availability",
    "When are you available for interviews?",
  );
  show(
    "/job-finder/actions",
    `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify({ text: "interviews", focusId: second.id }))}`,
  );
  const editor = await screen.findByRole("textbox", { name: first.prompt });
  fireEvent.change(editor, { target: { value: "My unsaved answer" } });
  fireEvent.click(
    screen.getByRole("link", { name: "Test navigation request" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: first.prompt })).toHaveProperty(
      "value",
      "My unsaved answer",
    ),
  );
  expect(screen.queryByRole("textbox", { name: second.prompt })).toBeNull();
  expect(
    screen.getByRole("searchbox", { name: "Filter Needs you" }),
  ).toHaveProperty("value", "");
});

it("opens a failed-upload form from its file task without resolving or answering it", async () => {
  const task = ask(0, "upload-repair", "Resume — upload failed", "file");
  const openApplication = vi.fn(() => Promise.resolve(true));
  Object.assign(window.nestor, { jobFinder: { openApplication } });
  show();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Open application",
    }),
  );
  await waitFor(() =>
    expect(openApplication).toHaveBeenCalledWith({ id: claimed[0]!.id }),
  );
  // A refused upload belongs to this one application: nothing offers to
  // save it for other forms.
  expect(screen.queryByText("Save this answer for next time")).toBeNull();
  expect(
    screen.getByText(
      "This is for this application only. Nothing is saved for other forms.",
    ),
  ).toBeTruthy();
  expect(applications.needsYou.details(task.id)?.task.id).toBe(task.id);
  expect(applications.getApplication(claimed[0]!.id)?.state).toBe("needs_you");
});

it("hands Fill's Next to the person: open the form, press it, and continue", async () => {
  const task = ask(
    0,
    "step_handover",
    'Press "Save and continue" on the site, then continue',
  );
  const openApplication = vi.fn(() => Promise.resolve(true));
  Object.assign(window.nestor, { jobFinder: { openApplication } });
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Open application" }),
  );
  await waitFor(() =>
    expect(openApplication).toHaveBeenCalledWith({ id: claimed[0]!.id }),
  );
  // Nothing to type and nothing to save for other forms.
  expect(screen.queryByText("Save this answer for next time")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "I pressed it, continue" }),
  );
  await waitFor(() =>
    expect(applications.getApplication(claimed[0]!.id)?.state).toBe("queued"),
  );
  expect(
    applications.needsYou.fieldAnswer(claimed[0]!.id, "step_handover")?.answer,
  ).toBe("Pressed on the site");
  // The item is done; the run picks the form up where the person left it.
  expect(applications.needsYou.details(task.id)).toBeNull();
});

it("lets the person say a failed upload is attached on the site, which continues the form", async () => {
  const task = ask(0, "upload-repair", "Resume — upload failed", "file");
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "It's attached on the site" }),
  );
  await waitFor(() =>
    expect(applications.needsYou.details(task.id)).toMatchObject({
      task: { id: task.id },
    }),
  );
  await waitFor(() =>
    expect(applications.getApplication(claimed[0]!.id)?.state).toBe("queued"),
  );
  expect(
    applications.needsYou.fieldAnswer(claimed[0]!.id, "upload-repair")?.answer,
  ).toBe("Attached on the site");
});

it("keeps the editor on its task when new work arrives, and one remembered answer releases both applications", async () => {
  const first = ask(0);
  expect(ask(1).id).toBe(first.id);
  show();
  const answer = await screen.findByRole("textbox", { name: first.prompt });
  fireEvent.change(answer, { target: { value: "Four weeks" } });
  let later = first;
  act(() => {
    later = ask(2, "travel", "Can you travel?", "boolean");
  });
  expect(screen.getByRole("textbox", { name: first.prompt })).toBe(answer);
  expect(answer).toHaveProperty("value", "Four weeks");
  fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
  await waitFor(() =>
    expect(applications.getApplication(claimed[0]!.id)?.state).toBe("queued"),
  );
  expect(applications.getApplication(claimed[1]!.id)?.state).toBe("queued");
  expect(applications.needsYou.findAnswer("notice")).toBe("Four weeks");
  expect(applications.needsYou.details(later.id)?.draft).toBeNull();
  await screen.findByRole("button", { name: "Yes" });
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(applications.getApplication(claimed[2]!.id)?.state).toBe("needs_you");
});

it.each([false, true])(
  "confirms a suggested page value in one click, or edits it first (edit: %s)",
  async (edit) => {
    const task = ask(0, "start-date", "When could you start?");
    applications.needsYou.saveDraft({
      id: task.id,
      answer: "2026-11-15",
      remember: true,
      revision: 0,
    });
    show();
    const field = await screen.findByRole("textbox", { name: task.prompt });
    expect(field).toHaveProperty("value", "2026-11-15");
    expect(
      screen.getByText(/Review this draft answer before saving/),
    ).toBeTruthy();
    expect(applications.needsYou.findAnswer(task.key)).toBeNull();
    if (edit) fireEvent.change(field, { target: { value: "2026-11-16" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() =>
      expect(applications.needsYou.findAnswer(task.key)).toBe(
        edit ? "2026-11-16" : "2026-11-15",
      ),
    );
    expect(applications.needsYou.list().total).toBe(0);
  },
);

it("a text question gains its native Yes/No choices without adding a card or losing the person's draft", async () => {
  const row = claimed[0]!;
  const prompt = "Are you over the age of 21?";
  const requested = applications.needsYou.request({
    applicationId: row.id,
    attempt: row.attempt,
    fieldKey: "age-text",
    key: "age-text",
    scope: {},
    kind: "question",
    input: "text",
    options: [],
    reusePrompt: true,
    prompt,
  });
  if (requested.status !== "needs_you") throw new Error("Expected a question.");
  show();
  fireEvent.change(await screen.findByRole("textbox", { name: prompt }), {
    target: { value: "No" },
  });
  act(() => {
    applications.needsYou.request({
      applicationId: row.id,
      attempt: row.attempt,
      fieldKey: "age-boolean",
      key: "age-boolean",
      scope: {},
      kind: "question",
      input: "boolean",
      options: ["Yes", "No"],
      reusePrompt: true,
      prompt,
    });
  });
  const no = await screen.findByRole("button", { name: "No", pressed: true });
  expect(no).toBeTruthy();
  expect(applications.needsYou.list().total).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
  await waitFor(() => expect(applications.needsYou.list().total).toBe(0));
  expect(applications.needsYou.findAnswer(requested.task.key)).toBe("No");
});

it("restores an exact question draft after leaving and returning", async () => {
  const first = ask(0);
  ask(1, "travel", "Can you travel?", "boolean");
  show();
  fireEvent.change(await screen.findByRole("textbox", { name: first.prompt }), {
    target: { value: "Two weeks" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Can you travel/ }));
  await screen.findByRole("button", { name: "Yes" });
  await waitFor(() =>
    expect(applications.needsYou.details(first.id)?.draft?.answer).toBe(
      "Two weeks",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /^What is your notice/ }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: first.prompt })).toHaveProperty(
      "value",
      "Two weeks",
    ),
  );
});

it("edits and forgets remembered answers from Needs you", async () => {
  const first = ask(0, "travel", "Can you travel?", "boolean");
  applications.needsYou.answer({ id: first.id, answer: "No", remember: true });
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Saved answers 1" }),
  );
  const pane = await screen.findByRole("region", { name: "Saved answer" });
  fireEvent.click(await within(pane).findByRole("button", { name: "Yes" }));
  fireEvent.click(within(pane).getByRole("button", { name: "Save answer" }));
  await waitFor(() =>
    expect(applications.needsYou.findAnswer("travel")).toBe("Yes"),
  );
  fireEvent.click(within(pane).getByRole("button", { name: "Forget answer" }));
  await waitFor(() => expect(applications.needsYou.counts().saved).toBe(0));
});

it("saves numeric answers before Apply and reuses the same facts in number or text fields", async () => {
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Saved answers 0" }),
  );
  for (const [prompt, answer] of [
    ["Years of analysis experience", "5"],
    ["Years of coordination experience", "14"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: "Add answer" }));
    const pane = await screen.findByRole("region", {
      name: "New saved answer",
    });
    fireEvent.change(within(pane).getByLabelText("Question"), {
      target: { value: prompt },
    });
    fireEvent.change(within(pane).getByLabelText("Your answer"), {
      target: { value: answer },
    });
    fireEvent.click(within(pane).getByRole("button", { name: "Save answer" }));
    await waitFor(() =>
      expect(
        applications.needsYou.listAnswers({ text: prompt }).rows.length,
      ).toBe(1),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "New saved answer" }),
      ).toBeNull(),
    );
  }
  const lookup = [
    {
      key: "number-analysis",
      prompt: "Years of analysis experience?",
      reusePrompt: true,
    },
    {
      key: "text-coordination",
      prompt: "Years of coordination experience",
      reusePrompt: true,
    },
  ];
  expect(
    applications.needsYou
      .answersForQuestions(claimed[0]!.id, lookup, "https://jobs.example.test")
      .map((value) => value.answer),
  ).toEqual(["5", "14"]);
  expect(
    applications.needsYou.request({
      applicationId: claimed[0]!.id,
      attempt: claimed[0]!.attempt,
      fieldKey: "years",
      key: "number-analysis",
      prompt: lookup[0]!.prompt,
      scope: {},
      kind: "question",
      input: "number",
      options: [],
      reusePrompt: true,
    }),
  ).toEqual({ status: "answered", answer: "5" });
  expect(applications.needsYou.list().rows).toEqual([]);
});

it("keeps one blocked-site card with its manual job link and no retry or saved-answer controls", async () => {
  for (const row of claimed.slice(0, 2)) {
    applications.needsYou.request({
      applicationId: row.id,
      attempt: row.attempt,
      fieldKey: "site_access",
      key: "access:https://jobs.example.test",
      kind: "sign_in",
      scope: { siteOrigin: "https://jobs.example.test" },
      prompt: "The site refused this browser.",
      input: "text",
      options: [],
      blockedUrl: "https://jobs.example.test/0",
    });
    applications.block(row.id, row.attempt, "The site refused this browser.");
  }
  const open = vi.spyOn(window.nestor.needsYou, "run");
  show();
  await screen.findByRole("heading", { name: "This site blocked the browser" });
  expect(applications.needsYou.list().total).toBe(1);
  expect(screen.getByText("https://jobs.example.test/0")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save answer" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open in my browser" }));
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith("open_need", {
      id: applications.needsYou.list().rows[0]!.id,
    }),
  );
  expect(applications.listApplications({ state: "blocked" }).rows).toHaveLength(
    2,
  );
});

it("updates a single site card as sign-in reaches MFA and applications continue", async () => {
  const request = (index: number, kind: "sign_in" | "mfa") =>
    applications.needsYou.request({
      applicationId: claimed[index]!.id,
      attempt: claimed[index]!.attempt,
      fieldKey: "site_access",
      key: "access",
      kind,
      scope: { siteOrigin: "https://jobs.example.test" },
      prompt: kind === "mfa" ? "Enter the code sent to you" : "Sign in first",
      input: "text",
      options: [],
    });
  const initial = request(0, "sign_in");
  request(1, "sign_in");
  request(2, "sign_in");
  if (initial.status !== "needs_you") throw new Error("Missing task");
  show();
  await screen.findByRole("heading", { name: "Sign in to continue" });
  act(() => {
    request(0, "mfa");
  });
  await screen.findByRole("heading", { name: "Complete verification" });
  expect(applications.needsYou.list().total).toBe(1);
  expect(screen.queryByRole("textbox")).toBeNull();
  act(() => {
    applications.needsYou.completeAccess(initial.task.id, claimed[0]!.id);
  });
  await waitFor(() =>
    expect(
      applications.needsYou.details(initial.task.id)?.applications,
    ).toHaveLength(2),
  );
  expect(screen.getByRole("button", { name: "Open in browser" })).toBeTruthy();
  act(() => {
    applications.needsYou.completeAccess(initial.task.id, claimed[1]!.id);
    applications.needsYou.completeAccess(initial.task.id, claimed[2]!.id);
  });
  await waitFor(() => expect(applications.needsYou.list().total).toBe(0));
});

it("updates tab counts while a saved answer is being edited, without moving the editor", async () => {
  applications.needsYou.remember({
    key: "notice",
    prompt: "What is your notice period?",
    answer: "Four weeks",
    scope: { country: "", siteOrigin: "" },
    input: "text",
    options: [],
  });
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Saved answers 1" }),
  );
  const answer = await screen.findByRole("textbox", {
    name: "What is your notice period?",
  });
  fireEvent.change(answer, { target: { value: "Six weeks" } });
  let task: ReturnType<typeof ask>;
  act(() => {
    task = ask(0, "travel", "Can you travel?", "boolean");
  });
  await screen.findByRole("button", { name: "Needs you 1" });
  act(() => {
    expect(ask(1, "travel", "Can you travel?", "boolean").id).toBe(task.id);
  });
  expect(screen.getByRole("button", { name: "Needs you 1" })).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "What is your notice period?" }),
  ).toBe(answer);
  expect(answer).toHaveProperty("value", "Six weeks");
  act(() => {
    applications.needsYou.answer({
      id: task.id,
      answer: "Yes",
      remember: false,
    });
  });
  await screen.findByRole("button", { name: "Needs you 0" });
  expect(answer).toHaveProperty("value", "Six weeks");
});

it("opens on one kind of item from a link, and shows everything again on request", async () => {
  ask(0);
  const row = claimed[1]!;
  const signIn = applications.needsYou.request({
    applicationId: row.id,
    attempt: row.attempt,
    fieldKey: "account",
    key: "account",
    scope: { siteOrigin: "https://jobs.example.test" },
    prompt: "Sign in to Example careers",
    kind: "sign_in",
    input: "text",
    options: [],
  });
  if (signIn.status !== "needs_you") throw new Error("Missing sign-in");
  show("/job-finder/actions?kind=sign_in");
  await screen.findByRole("button", { name: /^Sign in to Example careers/ });
  expect(
    screen.queryByRole("button", { name: /^What is your notice/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show everything" }));
  await screen.findByRole("button", { name: /^What is your notice/ });
});

it("a question's row names the company and role waiting on it, with the site beside", async () => {
  // Two applications wait on the same question; a third has its own.
  const row = claimed[0]!;
  applications.needsYou.request({
    applicationId: row.id,
    attempt: row.attempt,
    fieldKey: "notice",
    key: "notice",
    scope: { siteOrigin: "https://www.jobs.example.test" },
    prompt: "What is your notice period?",
    kind: "question",
    input: "text",
    options: [],
  });
  const second = claimed[1]!;
  applications.needsYou.request({
    applicationId: second.id,
    attempt: second.attempt,
    fieldKey: "notice",
    key: "notice",
    scope: { siteOrigin: "https://www.jobs.example.test" },
    prompt: "What is your notice period?",
    kind: "question",
    input: "text",
    options: [],
  });
  show();
  expect(
    await screen.findByText(/^Employer \d · Engineer \d and 1 more$/u),
  ).toBeTruthy();
  expect(screen.getByText("jobs.example.test")).toBeTruthy();
  expect(screen.queryByText(/https:\/\//u)).toBeNull();
});

/** Job sites search could not read: two on one host, one elsewhere. */
function gatedSites() {
  const sites = createJobSitesStore(jobs);
  const access = createSourceAccessStore(jobs);
  const ids = [
    "https://scale-853.example.test/careers",
    "https://scale-853.example.test/jobs",
    "https://orbit.example.test/jobs",
  ].map((text) => {
    const id = sites.add({ text }).firstAddedId!;
    access.request(id, "Open the site and sign in, then Retry.");
    return id;
  });
  return ids;
}

it("lists application questions first, then one sign-in row per host under one group", async () => {
  const question = ask(0);
  gatedSites();
  show();
  const list = await screen.findByRole("list", { name: "Things needing you" });
  await within(list).findByText(question.prompt);
  const group = await screen.findByRole("button", {
    name: "2 job sites need you to sign in",
  });
  // A question holds up an application, so the sites start folded away.
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(within(list).queryByText(/^Sign in to /u)).toBeNull();
  fireEvent.click(group);
  const scale = await within(list).findByRole("button", {
    name: /Sign in to .*scale-853\.example\.test · 2 sites/u,
  });
  expect(scale.textContent).toContain("Search couldn't read this site");
  expect(
    within(list).getByRole("button", { name: /orbit\.example\.test/u }),
  ).toBeTruthy();
  expect(list.querySelectorAll("[data-list-row-id]")).toHaveLength(3);
  // The question row comes before the sites.
  const order = [...list.querySelectorAll("[data-list-row-id]")].map((row) =>
    Number(row.getAttribute("data-list-row-id")),
  );
  expect(order[0]).toBe(question.id);
});

it("works through selected items: a question in place, then each site in the browser", async () => {
  const opened: number[] = [];
  const run = createNeedsYouCommandRunner(() => applications, {
    retry: () => Promise.resolve(),
    open: (id) => {
      opened.push(id);
      return Promise.resolve(true);
    },
    check: () => Promise.resolve(false),
  });
  const jobsRun = vi.fn((name: string) =>
    Promise.resolve(
      name === "retry_source"
        ? { search: { id: "search_1", state: "running" }, sources: [] }
        : { rows: [], nextCursor: null, total: 0 },
    ),
  );
  const command = vi.fn(() => Promise.resolve({}));
  Object.assign(window.nestor, {
    needsYou: { run },
    browser: { command },
    jobs: {
      run: jobsRun,
      onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
        jobs.onChange(listener),
      onSearchStatus: () => () => undefined,
    },
  });
  const question = ask(0);
  const [scaleCareers] = gatedSites();
  show();
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Select all 4 items" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Work through selected" }),
  );
  const walk = () =>
    document.querySelector("[data-needs-walk]")?.textContent ?? "";
  await waitFor(() => expect(walk()).toContain("1 of 3"));
  expect(
    document
      .querySelector("#list-detail")
      ?.getAttribute("data-needs-detail-id"),
  ).toBe(String(question.id));
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  await waitFor(() => expect(walk()).toContain("2 of 3"));
  expect(walk()).toContain("Signing in");
  await waitFor(() => expect(opened).toHaveLength(1));
  act(() => workThrough.doneWithSite());
  await waitFor(() => expect(walk()).toContain("3 of 3"));
  await waitFor(() => expect(opened).toHaveLength(2));
  expect(jobsRun).toHaveBeenCalledWith("retry_source", expect.anything());
  // Both scale-853 sources are checked together; its row says so.
  expect(
    jobsRun.mock.calls.filter(([name]) => name === "retry_source"),
  ).toHaveLength(2);
  fireEvent.click(
    await screen.findByRole("button", {
      name: /job sites need you to sign in/,
    }),
  );
  expect(await screen.findByText("Checking…")).toBeTruthy();
  // One of the host's two sites now reads: its row moves to the other site's
  // task and keeps the check it started under the first.
  act(() => {
    createSourceAccessStore(jobs).complete(scaleCareers!);
  });
  const scaleRow = await screen.findByRole("button", {
    name: /scale-853\.example\.test(?! · 2 sites)/u,
  });
  expect(scaleRow.textContent).toContain("Checking…");
  act(() => workThrough.pause());
  await waitFor(() => expect(walk()).toContain("Paused at 3 of 3"));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(opened).toHaveLength(3));
  act(() => workThrough.doneWithSite());
  await waitFor(() => expect(walk()).toBe(""));
  expect(command).toHaveBeenCalledWith({ type: "minimize" });
});

it("lists filled forms under their own group, and says so when nothing is blocked", async () => {
  const listApplications = vi.fn(() =>
    Promise.resolve({
      rows: [
        {
          id: 31,
          jobId: 8,
          mode: "prepare_only",
          title: "Backend Engineer",
          company: "Lantern Services",
          location: "Remote",
          state: "ready",
          attempt: 1,
          queuedAt: "2026-10-27T09:00:00.000Z",
          updatedAt: "2026-10-27T09:05:00.000Z",
          submittedAt: null,
          error: null,
        },
      ],
      nextCursor: null,
    }),
  );
  const openApplication = vi.fn(() => Promise.resolve(true));
  Object.assign(window.nestor, {
    jobFinder: {
      listApplications,
      openApplication,
      getApplicationDetails: () =>
        Promise.resolve({ application: { state: "ready" } }),
    },
  });
  show();
  expect(
    await screen.findByText(
      "Nothing is blocked. 1 application is filled in and waiting for your Send.",
      { exact: false },
    ),
  ).toBeTruthy();
  expect(screen.getByText("Ready for you to send (1)")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Needs you 0" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review and send" }));
  await waitFor(() => expect(openApplication).toHaveBeenCalledWith({ id: 31 }));
  openApplication.mockClear();
  // A question appears: the form stays listed below, not counted.
  act(() => {
    ask(0);
  });
  await screen.findByText("What is your notice period?");
  expect(screen.getByText("Ready for you to send (1)")).toBeTruthy();
  expect(screen.queryByText(/Nothing is blocked/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /Backend Engineer.*Lantern Services/ }),
  );
  await waitFor(() => expect(openApplication).toHaveBeenCalledWith({ id: 31 }));
});
