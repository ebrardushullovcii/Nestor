import type { ApplicationDetails } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import {
  actionNeededText,
  actionSite,
  doneSoFar,
  sentStatus,
  taskAction,
} from "./action-needed";

const AT = "2026-11-03T19:34:00.000Z";

function record(
  patch: {
    state?: ApplicationDetails["application"]["state"];
    submittedAt?: string | null;
    reviewCard?: Partial<NonNullable<ApplicationDetails["reviewCard"]>> | null;
    receipt?: Partial<NonNullable<ApplicationDetails["receipt"]>> | null;
  } = {},
): ApplicationDetails {
  return {
    application: {
      id: 3,
      jobId: 3,
      mode: "confirm_before_submit",
      title: "Synthetic role",
      company: "Synthetic harbor-health",
      location: "Berlin, Germany",
      state: patch.state ?? "needs_you",
      attempt: 1,
      queuedAt: AT,
      updatedAt: AT,
      submittedAt: patch.submittedAt ?? null,
      error: null,
    },
    summary: null,
    detail: null,
    resumeFileName: "campaign-synthetic-jamie.txt",
    reviewCard:
      patch.reviewCard === null
        ? null
        : {
            siteLabel: "Synthetic harbor-health",
            pageUrl: null,
            answers: [
              {
                question: "Referral code",
                answer: "person-kept",
                source: "Profile",
                written: false,
                groundedIn: [],
              },
            ],
            attachments: [],
            intermediateSaved: false,
            letter: null,
            waitingOnYou: [],
            preparedAt: AT,
            ...patch.reviewCard,
          },
    receipt: (patch.receipt
      ? {
          outcome: "outcome_uncertain",
          attemptedAt: AT,
          verifiedAt: null,
          evidence: [],
          ...patch.receipt,
        }
      : null) as ApplicationDetails["receipt"],
  };
}

const question = {
  kind: "question" as const,
  prompt: "What is your notice period?",
  input: "text" as const,
  scope: { country: "", siteOrigin: "" },
};

describe("the ACTION NEEDED line", () => {
  it("names the site and the exact question a normal question asks", () => {
    const text = actionNeededText({
      site: actionSite(question, [{ company: "Employer 0" }]),
      action: taskAction(question),
      done: doneSoFar(record()),
      sent: sentStatus(record()),
    });
    expect(text).toMatch(
      /^ACTION NEEDED — Employer 0: Give your answer to “What is your notice period\?”\. Done so far: filled 1 field \(.+\)\. Sent: no application send recorded\./u,
    );
  });

  it("names the site host and the recorded step for a site sign-in, without its address", () => {
    const signIn = {
      kind: "sign_in" as const,
      prompt:
        "Sign in at https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&scope=drive to continue",
      input: "text" as const,
      scope: { country: "", siteOrigin: "https://accounts.google.com" },
    };
    const line = {
      site: actionSite(signIn, [{ company: "Synthetic harbor-health" }]),
      action: taskAction(signIn),
    };
    expect(line.site).toBe("accounts.google.com");
    expect(line.action).toBe(
      "Sign in at accounts.google.com to continue. Then press “Check again”.",
    );
    expect(line.action).not.toMatch(/client_id|scope=|oauth2|https?:/u);
    // On the application it points at the control's real place.
    expect(taskAction(signIn, { onApplication: true })).toMatch(
      /Then press “Check again” in Needs you\.$/u,
    );
  });

  it("shows the recorded extra-access reason when supplied, and never guesses one", () => {
    const google = {
      kind: "sign_in" as const,
      prompt: "Google needs you to finish this step.",
      input: "text" as const,
      scope: { country: "", siteOrigin: "https://accounts.google.com" },
    };
    expect(
      taskAction(google, {
        accessDetail:
          "Nestor cannot prove this request is limited to your name, email and profile picture. Review the Google access request yourself.",
      }),
    ).toBe(
      "Google needs you to finish this step. Nestor cannot prove this request is limited to your name, email and profile picture. Review the Google access request yourself. Then press “Check again”.",
    );
    // Without a recorded reason it says only what was recorded: no Drive,
    // no password, no sign-in that did not happen.
    const bare = taskAction(google);
    expect(bare).toBe(
      "Google needs you to finish this step. Then press “Check again”.",
    );
    expect(bare).not.toMatch(/drive|password|signed in/iu);
  });

  it("names the form's own control for a step handed to the person", () => {
    expect(
      taskAction({
        ...question,
        prompt: 'Press "Save and continue" on the site, then continue',
      }),
    ).toBe(
      'Press "Save and continue" on the form yourself, then press “I pressed it, continue” here.',
    );
    expect(
      taskAction({ ...question, prompt: "Resume, Your CV — upload failed" }),
    ).toBe(
      "Attach the file for Resume, Your CV on the form; the upload failed.",
    );
  });

  it("says Nestor already pressed a step once when the page did not confirm it", () => {
    const detail =
      'Nestor pressed "Save and Continue" once on step 1 of 3, but the form did not show step 2 of 3 afterwards. It will not press it again. Check the form; if that step is not done, press "Save and Continue" yourself.';
    const prompt = 'Press "Save and Continue" on the site, then continue';
    expect(
      taskAction({
        ...question,
        prompt,
        askReason: {
          kind: "page_refused",
          check: "step_not_confirmed",
          detail,
        },
      }),
    ).toBe(`${detail} Then press “I pressed it, continue” here.`);
    expect(
      taskAction(
        {
          ...question,
          prompt,
          askReason: {
            kind: "page_refused",
            check: "step_not_confirmed",
            detail,
          },
        },
        { onApplication: true },
      ),
    ).toBe(`${detail} Then press “I pressed it, continue” in Needs you.`);
    // Another recorded reason on a step handover keeps the plain step line.
    expect(
      taskAction({
        ...question,
        prompt,
        askReason: {
          kind: "page_refused",
          check: "native_page_attachment",
          detail: "Nestor could not attach automation to that exact tab.",
        },
      }),
    ).toBe(
      'Press "Save and Continue" on the form yourself, then press “I pressed it, continue” here.',
    );
  });

  it("says a question Nestor could not read is Nestor's problem, not a personal question", () => {
    const action = taskAction({
      ...question,
      askReason: {
        kind: "no_source",
        check: "question_classification",
        detail: "provider timeout",
      },
    });
    expect(action).toMatch(/^Nestor could not read the question/u);
    expect(action).toContain(
      "This is a Nestor problem, not missing information",
    );
    expect(action).not.toContain("Give your answer");
    expect(action).not.toContain("answer it here");
    expect(action).toContain("Press “Open application”");
  });
});

describe("done so far and sent", () => {
  it("lists only what the run recorded on the form", () => {
    expect(doneSoFar(record({ reviewCard: null }))).toBe(
      "nothing is recorded on the form yet.",
    );
    expect(
      doneSoFar(
        record({
          reviewCard: {
            attachments: [
              {
                label: "Resume",
                fileName: "cv.pdf",
                field: "resume",
              },
            ],
          },
        }),
      ),
    ).toMatch(/^filled 1 field, attached cv\.pdf \(/u);
    // The selected resume alone is not an attachment the form took.
    expect(doneSoFar(record())).not.toContain("campaign-synthetic-jamie.txt");
  });

  it("claims a send only from a confirmed receipt", () => {
    expect(
      sentStatus(
        record({
          state: "submitted",
          submittedAt: AT,
          receipt: {
            outcome: "submitted",
            verifiedAt: AT,
            evidence: [],
          },
        }),
      ),
    ).toMatch(/^yes, site confirmed /u);
  });

  it("keeps an uncertain send unknown, never sent or not sent", () => {
    const sent = sentStatus(
      record({ state: "uncertain", receipt: { outcome: "outcome_uncertain" } }),
    );
    expect(sent).toMatch(/^unknown\. Nestor pressed send/u);
    expect(sent).toContain("will not send it again by itself");
    expect(sent).not.toMatch(/^yes|not sent|nothing was sent|no application/iu);
  });

  it("does not turn a filled form or a missing receipt into zero writes", () => {
    const stopped = sentStatus(record({ state: "stopped" }));
    expect(stopped).toBe(
      "no application send recorded. Whether the site saved answers on its own is not verified.",
    );
    expect(stopped).not.toMatch(/nothing was sent|not sent\b/iu);
    expect(
      sentStatus(
        record({ state: "stopped", reviewCard: { intermediateSaved: true } }),
      ),
    ).toBe(
      "no application send recorded. The site saved some answers or files while Nestor filled the form.",
    );
    expect(
      sentStatus(
        record({ state: "stopped", receipt: { outcome: "not_submitted" } }),
      ),
    ).toBe("no, the application was not sent.");
  });
});
