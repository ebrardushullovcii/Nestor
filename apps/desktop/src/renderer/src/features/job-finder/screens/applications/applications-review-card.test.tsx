// @vitest-environment jsdom

import { ApplicationReviewCardSchema } from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApplicationsReviewCard } from "./applications-review-card";

/**
 * The review a person reads before they send.
 *
 * The rules worth holding: every answer shows the run's own phrase for where
 * it came from, the letter is shown in full, the button refuses while anything
 * is waiting, and a page that closed says so instead of failing silently.
 */

afterEach(() => {
  cleanup();
});

function card(overrides: Record<string, unknown> = {}) {
  return ApplicationReviewCardSchema.parse({
    siteLabel: "Northwind careers",
    pageUrl: "https://apply.example.test/form",
    answers: [
      {
        question: "Email",
        answer: "robin@example.test",
        source: "your email address",
        written: false,
        groundedIn: [],
      },
    ],
    attachments: [
      { label: "Your CV", fileName: "robin-cv.pdf", field: "Resume/CV" },
    ],
    letter: null,
    waitingOnYou: [],
    preparedAt: "2026-09-14T10:00:00.000Z",
    ...overrides,
  });
}

describe("ApplicationsReviewCard", () => {
  it("shows each answer with the run's own phrase for where it came from", () => {
    render(
      <ApplicationsReviewCard
        card={card()}
        onSubmit={vi.fn(() => Promise.resolve())}
      />,
    );

    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.getByText("robin@example.test")).toBeTruthy();
    // The stored phrase, not a category name.
    expect(screen.getByText(/From your email address/i)).toBeTruthy();
    expect(screen.getByText(/robin-cv\.pdf/)).toBeTruthy();
    expect(screen.getByText(/Nothing has been sent yet/i)).toBeTruthy();
  });

  it("says what a written answer was based on", () => {
    render(
      <ApplicationsReviewCard
        card={card({
          answers: [
            {
              question: "Why do you want to work here?",
              answer: "I build platforms other engineers rely on.",
              source: "written for this application",
              written: true,
              groundedIn: [
                "the resume sent with this application",
                "the posting",
              ],
            },
          ],
        })}
        onSubmit={vi.fn(() => Promise.resolve())}
      />,
    );

    expect(
      screen.getByText(
        /Written for this application, based on the resume sent with this application, the posting/i,
      ),
    ).toBeTruthy();
  });

  it("shows the letter in full with what it was written from", () => {
    const text =
      "Dear hiring team, I have spent eight years building platforms.";
    render(
      <ApplicationsReviewCard
        card={card({
          letter: {
            text,
            groundedIn: ["the resume sent with this application"],
          },
        })}
        onSubmit={vi.fn(() => Promise.resolve())}
      />,
    );

    expect(screen.getByText(text)).toBeTruthy();
    expect(
      screen.getByText(/Written from the resume sent with this application/i),
    ).toBeTruthy();
  });

  it("sends once when pressed, and says it only sends once", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<ApplicationsReviewCard card={card()} onSubmit={onSubmit} />);

    const send = screen.getByRole<HTMLButtonElement>("button", {
      name: "Submit application",
    });
    expect(send.disabled).toBe(false);
    expect(screen.getByText(/never sends it twice/i)).toBeTruthy();

    fireEvent.click(send);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("refuses to send while something is still waiting on the person", () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(
      <ApplicationsReviewCard
        card={card({
          waitingOnYou: ['Job Finder stopped on "Expected salary".'],
        })}
        onSubmit={onSubmit}
      />,
    );

    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Submit application",
      }).disabled,
    ).toBe(true);
    expect(screen.getByText(/Expected salary/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("says the page closed, and offers to prepare it again", async () => {
    const onPrepareAgain = vi.fn(() => Promise.resolve());
    const onSubmit = vi.fn(() => Promise.resolve());
    render(
      <ApplicationsReviewCard
        card={card()}
        onPrepareAgain={onPrepareAgain}
        onSubmit={onSubmit}
        pageClosed
      />,
    );

    expect(
      screen.getByText(
        "The application page was closed before you reviewed it. Prepare it again to continue.",
      ),
    ).toBeTruthy();
    // Sending is impossible until it is prepared again.
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Submit application",
      }).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Prepare again" }));
    await waitFor(() => expect(onPrepareAgain).toHaveBeenCalledTimes(1));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("says a failed send changed nothing, without leading with the raw error", async () => {
    render(
      <ApplicationsReviewCard
        card={card()}
        onSubmit={vi.fn(() =>
          Promise.reject(new Error("ECONNRESET at socket")),
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit application" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nothing on the site was changed");
    expect(alert.textContent).not.toMatch(/^ECONNRESET/);
  });
});

it.each([
  "chosen on the form",
  "chosen on the form by Job Finder",
  "your answer on the form",
])("labels the source of an answer on the form (%s)", (source) => {
  render(
    <ApplicationsReviewCard
      card={card({
        answers: [
          {
            question: "Currency",
            answer: "EUR",
            source,
            written: source !== "your answer on the form",
            groundedIn: [],
          },
        ],
      })}
      onSubmit={vi.fn()}
    />,
  );
  expect(
    screen.getByText(
      source === "your answer on the form"
        ? "Your answer on the form"
        : "Chosen on the form by Job Finder",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText(/Written for this application chosen|From chosen/),
  ).toBeNull();
});

it("labels an unchecked letter as a draft and shows the review reason", () => {
  render(
    <ApplicationsReviewCard
      card={card({
        letter: {
          text: "Letter draft",
          groundedIn: ["Resume"],
          reviewReason:
            "Agree how to handle the location mismatch before sending.",
        },
        waitingOnYou: ["Review the draft"],
      })}
      onSubmit={vi.fn(() => Promise.resolve())}
    />,
  );
  expect(screen.getByText("Letter draft for your review")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("location mismatch");
  expect(screen.queryByText("The letter going with it")).toBeNull();
});

it("Open this page opens the record's own application tab without sending", async () => {
  const onOpenPage = vi.fn(() => Promise.resolve());
  const onSubmit = vi.fn(() => Promise.resolve());
  const command = vi.fn();
  vi.stubGlobal("nestor", { browser: { command } });
  render(
    <ApplicationsReviewCard
      card={card()}
      onSubmit={onSubmit}
      onOpenPage={onOpenPage}
    />,
  );
  const open = screen.getByRole("button", { name: "Open this page" });
  expect(open.dataset.variant).toBe("secondary");
  expect(open.parentElement?.textContent).toContain(
    "Page: https://apply.example.test/form",
  );
  fireEvent.click(open);
  await waitFor(() => expect(onOpenPage).toHaveBeenCalledOnce());
  // It opens the tab bound to this result, never a tab found by address.
  expect(command).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("shows the earlier-letter warning beside the letter and prepares again instead of sending", async () => {
  const onPrepareAgain = vi.fn(() => Promise.resolve());
  const onSubmit = vi.fn(() => Promise.resolve());
  const original = card();
  render(
    <ApplicationsReviewCard
      card={{
        ...original,
        letter: {
          text: "Earlier letter",
          groundedIn: [],
          needsRefresh: true,
          fields: ["Cover letter"],
        },
      }}
      onSubmit={onSubmit}
      onPrepareAgain={onPrepareAgain}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "The form still holds the earlier letter",
  );
  expect(
    screen
      .getByRole("button", { name: "Submit application" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Prepare again" }));
  await waitFor(() => expect(onPrepareAgain).toHaveBeenCalledTimes(1));
  expect(onSubmit).not.toHaveBeenCalled();
});

it("shows the answer review in prepare-only mode without a Job Finder send control", () => {
  render(<ApplicationsReviewCard card={card()} onOpenPage={vi.fn()} />);
  expect(screen.getByText("Read this before you send it")).toBeTruthy();
  expect(screen.getByText("robin@example.test")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Submit application" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Open this page" })).toBeTruthy();
});

it("does not claim a blank form was filled or holds an earlier letter", () => {
  render(
    <ApplicationsReviewCard
      card={ApplicationReviewCardSchema.parse({
        siteLabel: "Example",
        preparedAt: "2026-10-05T10:00:00Z",
        answers: [],
        attachments: [],
        waitingOnYou: [],
        letter: { text: "Approved draft", groundedIn: [], needsRefresh: true },
      })}
    />,
  );
  expect(
    screen.getByText(
      "Nothing has been filled in on Example yet. Nothing has been sent.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(/The approved letter has not been added to the form yet/),
  ).toBeTruthy();
  expect(
    screen.queryByText(
      /still holds the earlier letter|Job Finder filled this in/,
    ),
  ).toBeNull();
});
