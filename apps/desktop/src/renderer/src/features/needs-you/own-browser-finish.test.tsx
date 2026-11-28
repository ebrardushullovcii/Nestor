// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_APPLICATION_APPLY_MODE,
  type ApplicationDetails,
  type NeedsYouDetails,
} from "@nestor/contracts";
import { ToastProvider } from "@renderer/components/ui/toast";
import { TaskPane } from "./task-pane";
import { allAnswersText, handAnswer } from "./own-browser-finish";

const APPLY_URL = "https://jobs.replica.test/acme/7f3a/apply";

function need(applications = 1): NeedsYouDetails {
  return {
    task: {
      id: 35,
      kind: "other",
      key: "own_browser",
      scope: { country: "", siteOrigin: "https://jobs.replica.test" },
      prompt:
        "The site rejected the security check in Nestor's browser. Finish the application in your own browser.",
      input: "text",
      options: [],
      openedAt: "2026-11-28T10:00:00.000Z",
      blockedUrl: APPLY_URL,
    },
    applications: Array.from({ length: applications }, (_, index) => ({
      id: 70 + index,
      jobId: 700 + index,
      title: "Staff Engineer",
      company: "Acme Replica",
      location: "Remote",
      state: "blocked",
    })),
    draft: null,
  } as NeedsYouDetails;
}

function record(
  overrides: Partial<ApplicationDetails> = {},
): ApplicationDetails {
  return {
    application: {
      id: 70,
      jobId: 700,
      mode: DEFAULT_APPLICATION_APPLY_MODE,
      title: "Staff Engineer",
      company: "Acme Replica",
      location: "Remote",
      state: "blocked",
      attempt: 1,
      queuedAt: "2026-11-28T09:00:00.000Z",
      updatedAt: "2026-11-28T10:00:00.000Z",
      submittedAt: null,
      error: null,
    },
    summary: null,
    detail: null,
    resumeFileName: "sam-sample-resume.pdf",
    resumeFilePath: "/tmp/replica/resumes/sam-sample-resume.pdf",
    reviewCard: {
      siteLabel: "Replica Lever",
      pageUrl: APPLY_URL,
      answers: [
        {
          fieldKey: "name",
          control: "text",
          question: "Full name",
          answer: "Sam Sample",
          source: "your name",
          written: false,
          groundedIn: [],
        },
        {
          fieldKey: "auth",
          control: "radio",
          question: "Are you legally authorized to work in the US?",
          answer: "Yes",
          source: "your work authorization",
          written: false,
          groundedIn: [],
        },
        {
          fieldKey: "pronouns",
          question: "Pronouns",
          answer: '["He/him","They/them"]',
          source: "your saved answer",
          written: false,
          groundedIn: [],
        },
        {
          fieldKey: "why",
          control: "long_text",
          question: "Why Acme?",
          answer: "I build safety tooling.\nAcme ships it.",
          source: "written for this job",
          written: true,
          groundedIn: [],
        },
      ],
      intermediateSaved: false,
      attachments: [
        {
          label: "Resume/CV",
          fileName: "sam-sample-resume.pdf",
          field: "Resume/CV",
        },
      ],
      letter: null,
      waitingOnYou: [],
      preparedAt: "2026-11-28T09:59:00.000Z",
    },
    receipt: null,
    ...overrides,
  };
}

let run: ReturnType<typeof vi.fn>;
let bridge: {
  getApplicationDetails: ReturnType<typeof vi.fn>;
  writeClipboardText: ReturnType<typeof vi.fn>;
  revealSavedFile: ReturnType<typeof vi.fn>;
  reportApplicationSend: ReturnType<typeof vi.fn>;
};
let onResolved: ReturnType<typeof vi.fn>;

function show(details: NeedsYouDetails, application: ApplicationDetails) {
  run = vi.fn((name: string) =>
    Promise.resolve(name === "get_need" ? details : true),
  );
  bridge.getApplicationDetails.mockResolvedValue(application);
  Object.assign(window, {
    nestor: {
      needsYou: { run },
      jobs: { onChange: () => () => undefined },
      jobFinder: bridge,
    },
  });
  render(
    <ToastProvider>
      <TaskPane id={35} onEditing={() => undefined} onResolved={onResolved} />
    </ToastProvider>,
  );
  return within(screen.getByRole("region", { name: "Task details" }));
}

beforeEach(() => {
  bridge = {
    getApplicationDetails: vi.fn(),
    writeClipboardText: vi.fn(() => Promise.resolve({ written: true })),
    revealSavedFile: vi.fn(() => Promise.resolve({ outcome: "revealed" })),
    reportApplicationSend: vi.fn(() => Promise.resolve(true)),
  };
  onResolved = vi.fn();
});
afterEach(() => {
  cleanup();
});

it("lists every prepared answer under its question, with a choice shown as the option to pick", async () => {
  const pane = show(need(), record());
  expect(
    await pane.findByRole("heading", { name: "Finish it in your own browser" }),
  ).toBeTruthy();
  const answers = within(
    await pane.findByRole("list", { name: "Prepared answers" }),
  );
  expect(answers.getByText("Full name")).toBeTruthy();
  expect(answers.getByText("Sam Sample")).toBeTruthy();
  const auth = within(
    answers
      .getByText("Are you legally authorized to work in the US?")
      .closest("li")!,
  );
  expect(auth.getByRole("list", { name: "Option to pick" })).toBeTruthy();
  expect(auth.getByText("Pick", { exact: false })).toBeTruthy();
  const pronouns = within(answers.getByText("Pronouns").closest("li")!);
  expect(pronouns.getByRole("list", { name: "Options to tick" })).toBeTruthy();
  expect(pronouns.getByText("He/him")).toBeTruthy();
  expect(pronouns.getByText("They/them")).toBeTruthy();
  expect(
    answers.getByText(
      (_, node) =>
        node?.textContent === "I build safety tooling.\nAcme ships it.",
    ),
  ).toBeTruthy();
  expect(pane.getByText(/4 answers, in the form’s order/u)).toBeTruthy();
});

it("copies one answer, and every answer at once", async () => {
  const pane = show(need(), record());
  fireEvent.click(
    await pane.findByRole("button", {
      name: "Copy answer to “Are you legally authorized to work in the US?”",
    }),
  );
  await waitFor(() =>
    expect(bridge.writeClipboardText).toHaveBeenCalledWith("Yes"),
  );
  expect(
    await pane.findByRole("button", {
      name: "Copied answer to “Are you legally authorized to work in the US?”",
    }),
  ).toBeTruthy();
  fireEvent.click(
    pane.getByRole("button", { name: "Copy answer to “Pronouns”" }),
  );
  await waitFor(() =>
    expect(bridge.writeClipboardText).toHaveBeenCalledWith("He/him, They/them"),
  );
  fireEvent.click(pane.getByRole("button", { name: "Copy all answers" }));
  await waitFor(() =>
    expect(bridge.writeClipboardText).toHaveBeenLastCalledWith(
      [
        "Full name\nSam Sample",
        "Are you legally authorized to work in the US?\nYes",
        "Pronouns\nHe/him, They/them",
        "Why Acme?\nI build safety tooling.\nAcme ships it.",
      ].join("\n\n"),
    ),
  );
});

it("shows the attached resume once, and reveals it or copies its path", async () => {
  const pane = show(need(), record());
  const files = within(
    await pane.findByRole("list", { name: "Files to attach" }),
  );
  expect(files.getAllByText("sam-sample-resume.pdf")).toHaveLength(1);
  expect(files.getByText("Resume, Resume/CV")).toBeTruthy();
  fireEvent.click(files.getByRole("button", { name: /^Show in/u }));
  await waitFor(() =>
    expect(bridge.revealSavedFile).toHaveBeenCalledWith(
      "/tmp/replica/resumes/sam-sample-resume.pdf",
    ),
  );
  fireEvent.click(
    files.getByRole("button", {
      name: "Copy path the path to sam-sample-resume.pdf",
    }),
  );
  await waitFor(() =>
    expect(bridge.writeClipboardText).toHaveBeenCalledWith(
      "/tmp/replica/resumes/sam-sample-resume.pdf",
    ),
  );
});

it("says so when the resume file is no longer where Apply kept it", async () => {
  bridge.revealSavedFile.mockResolvedValue({ outcome: "not_found" });
  const pane = show(need(), record());
  fireEvent.click(await pane.findByRole("button", { name: /^Show in/u }));
  expect(await pane.findByText(/That file is no longer there/u)).toBeTruthy();
});

it("opens the page in the person's browser or in Nestor", async () => {
  const pane = show(need(), record());
  fireEvent.click(
    await pane.findByRole("button", { name: "Open in my browser" }),
  );
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith("open_need", { id: 35 }),
  );
  await waitFor(() =>
    expect(
      pane.getByRole<HTMLButtonElement>("button", { name: "Open in Nestor" })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(pane.getByRole("button", { name: "Open in Nestor" }));
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith("open_need", {
      id: 35,
      browser: "nestor",
    }),
  );
  expect(pane.getByText(APPLY_URL)).toBeTruthy();
});

it("settles the application from the card once the person sent it", async () => {
  const pane = show(need(), record());
  fireEvent.click(await pane.findByRole("button", { name: "It went through" }));
  await waitFor(() =>
    expect(bridge.reportApplicationSend).toHaveBeenCalledWith({
      id: 70,
      sent: true,
    }),
  );
  await waitFor(() =>
    expect(onResolved).toHaveBeenCalledWith(35, "Moved to Applied."),
  );
});

it("records a send that did not go through, and says when it had moved on", async () => {
  const pane = show(need(), record());
  fireEvent.click(
    await pane.findByRole("button", { name: "It didn’t go through" }),
  );
  await waitFor(() =>
    expect(onResolved).toHaveBeenCalledWith(
      35,
      "Marked as not sent. Apply won't send it again by itself.",
    ),
  );
  expect(bridge.reportApplicationSend).toHaveBeenCalledWith({
    id: 70,
    sent: false,
  });
  bridge.reportApplicationSend.mockResolvedValue(false);
  onResolved.mockClear();
  fireEvent.click(pane.getByRole("button", { name: "It went through" }));
  expect(await pane.findByText(/had already moved on/u)).toBeTruthy();
  expect(onResolved).not.toHaveBeenCalled();
});

it("keeps the link and open buttons when several applications share the hand-off", async () => {
  const pane = show(need(2), record());
  expect(
    await pane.findByRole("button", { name: "Open in my browser" }),
  ).toBeTruthy();
  expect(pane.queryByRole("list", { name: "Prepared answers" })).toBeNull();
  expect(pane.queryByRole("button", { name: "It went through" })).toBeNull();
  expect(bridge.getApplicationDetails).not.toHaveBeenCalled();
});

it("offers the cover letter with its own Copy, and includes it in Copy all", async () => {
  const base = record();
  const withLetter = record({
    reviewCard: {
      ...base.reviewCard!,
      letter: { text: "Dear Acme,\nHello.", groundedIn: [] },
    },
  });
  expect(allAnswersText(withLetter)).toMatch(
    /\n\nCover letter\nDear Acme,\nHello\.$/u,
  );
  const pane = show(need(), withLetter);
  fireEvent.click(await pane.findByText("Cover letter"));
  fireEvent.click(pane.getByRole("button", { name: "Copy cover letter" }));
  await waitFor(() =>
    expect(bridge.writeClipboardText).toHaveBeenCalledWith(
      "Dear Acme,\nHello.",
    ),
  );
});

it("reads a select or combobox answer as one option and plain text as typed", () => {
  const base = record().reviewCard!.answers[0]!;
  expect(handAnswer({ ...base, control: "select", answer: "Kosovo" })).toEqual({
    kind: "choice",
    values: ["Kosovo"],
  });
  expect(
    handAnswer({ ...base, control: "checkbox", answer: "I agree" }),
  ).toEqual({ kind: "choices", values: ["I agree"] });
  expect(
    handAnswer({ ...base, control: undefined, answer: "[not json" }),
  ).toEqual({ kind: "text", values: ["[not json"] });
});
