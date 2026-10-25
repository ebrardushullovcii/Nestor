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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FoundJob } from "@nestor/contracts";
import {
  createApplicationStore,
  type ApplicationStore,
} from "@nestor/db/applications";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { ToastProvider } from "@renderer/components/ui/toast";
import { createNeedsYouCommandRunner } from "../../../../main/services/needs-you-commands";
import { NeedsYouScreen } from "./needs-you-screen";

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
    open: async () => true,
    check: async () => false,
  });
  Object.assign(window, {
    nestor: { jobs: { onChange: jobs.onChange }, needsYou: { run } },
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
function show() {
  return render(
    <ToastProvider>
      <NeedsYouScreen />
    </ToastProvider>,
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
  await screen.findByRole("button", { name: "Yes", exact: true });
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(applications.getApplication(claimed[2]!.id)?.state).toBe("needs_you");
});

it("restores an exact question draft after leaving and returning", async () => {
  const first = ask(0);
  const second = ask(1, "travel", "Can you travel?", "boolean");
  show();
  fireEvent.change(await screen.findByRole("textbox", { name: first.prompt }), {
    target: { value: "Two weeks" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Can you travel/ }));
  await screen.findByRole("button", { name: "Yes", exact: true });
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
  fireEvent.click(
    await within(pane).findByRole("button", { name: "Yes", exact: true }),
  );
  fireEvent.click(
    within(pane).getByRole("button", { name: "Save answer", exact: true }),
  );
  await waitFor(() =>
    expect(applications.needsYou.findAnswer("travel")).toBe("Yes"),
  );
  fireEvent.click(within(pane).getByRole("button", { name: "Forget answer" }));
  await waitFor(() => expect(applications.needsYou.counts().saved).toBe(0));
});
