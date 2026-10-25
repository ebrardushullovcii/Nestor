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
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FoundJob } from "@nestor/contracts";
import {
  createApplicationStore,
  type ApplicationStore,
} from "@nestor/db/applications";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { ToastProvider } from "@renderer/components/ui/toast";
import { createNeedsYouCommandRunner } from "@nestor/job-finder/applications";
import { NeedsYouScreen } from "./needs-you-screen";
import { SourceNeedPane } from "./source-need-pane";

it("opens a source's URL and retries its ID without dismissing the sign-in item", async () => {
  const command = vi.fn(() => Promise.resolve({}));
  const run = vi.fn(() => Promise.resolve({ search: null, sources: [] }));
  Object.assign(window.nestor, {
    browser: { command },
    jobs: {
      run,
      onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
        jobs.onChange(listener),
    },
  });
  render(
    <SourceNeedPane
      source={{
        id: 900,
        label: "Example board",
        url: "https://jobs.example.test/sign-in",
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open to sign in" }));
  expect(command).toHaveBeenCalledWith({
    type: "open",
    url: "https://jobs.example.test/sign-in",
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(/This item closes when the site is readable/);
  expect(run).toHaveBeenCalledWith("retry_source", { id: 900 });
  expect(
    screen.getByRole("heading", { name: "Sign in to Example board" }),
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
  jobs.setStage(added, "resume");
  applications = createApplicationStore(jobs);
  applications.applyJobs({ selection: { ids: added } });
  claimed = [
    applications.claimNext()!,
    applications.claimNext()!,
    applications.claimNext()!,
  ];
  const run = createNeedsYouCommandRunner(() => applications, {
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
  jobs.close();
  vi.unstubAllGlobals();
});
function ask(
  index: number,
  key = "notice",
  prompt = "What is your notice period?",
  input: "text" | "boolean" = "text",
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
function show(route = "/job-finder/actions") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        <NeedsYouScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
}

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
    scope: {},
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
