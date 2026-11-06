import {
  CandidateProfileSchema,
  type CandidateProfile,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import pickerReplay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/picker-handover.json";
import { createApplyUserPrompt } from "./apply-prompts";
import { replaceApprovedApplicationLetter } from "./approved-letter";

import type { RawApplyControl, RawApplyPage } from "@nestor/contracts";
import { buildApplyFormObservation } from "./page-hands";
import {
  buildPendingQuestion,
  createApplyGuardState,
  executeApplyProposal,
  pickerExhausted,
  pickerQuestionKey,
  pressOnSitePause,
} from "./policy-executor";
import type {
  ApplyAgentConfig,
  ApplyAuthority,
  ApplyFormObservation,
  ApplyPageHands,
} from "./types";

function rawControl(
  overrides: Partial<RawApplyControl> & { index: number },
): RawApplyControl {
  return {
    tagName: "input",
    inputType: "text",
    role: "",
    id: `field_${overrides.index}`,
    name: `field_${overrides.index}`,
    label: "",
    groupLabel: "",
    placeholder: "",
    autocomplete: "",
    required: false,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value: "",
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
    ...overrides,
  };
}

function rawPage(overrides: Partial<RawApplyPage> = {}): RawApplyPage {
  return {
    url: "https://apply.example.test/form",
    title: "Apply",
    bodyText: "Apply for the role",
    controls: [],
    actions: [],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
    ...overrides,
  };
}

function observationOf(page: RawApplyPage): ApplyFormObservation {
  return buildApplyFormObservation(page, "2026-09-14T10:00:00.000Z");
}

function profile(): CandidateProfile {
  return CandidateProfileSchema.parse({
    id: "candidate_test",
    firstName: "Robin",
    lastName: "Ashford",
    fullName: "Robin Ashford",
    headline: "Platform engineer",
    summary: "Builds dependable internal tools.",
    currentLocation: "Manchester, United Kingdom",
    yearsExperience: 8,
    email: "robin.ashford@example.test",
    baseResume: {
      id: "resume_test",
      fileName: "resume.txt",
      uploadedAt: "2026-09-01T09:00:00.000Z",
      textContent: "8 years of platform engineering.",
      textUpdatedAt: "2026-09-01T09:00:00.000Z",
      extractionStatus: "ready",
    },
  });
}

function authority(overrides: Partial<ApplyAuthority> = {}): ApplyAuthority {
  return {
    mode: "prepare_only",
    submitAuthorized: false,
    preApprovedAttestationKinds: [],
    salaryDisclosure: "pause_for_user",
    allowedOrigins: [],
    ...overrides,
  };
}

function configFor(
  page: RawApplyPage,
  overrides: {
    accountCreationAuthorized?: boolean;
    authority?: Partial<ApplyAuthority>;
    hands?: Partial<ApplyPageHands>;
  } = {},
): { config: ApplyAgentConfig; hands: ApplyPageHands } {
  const hands: ApplyPageHands = {
    observe: () => Promise.resolve(observationOf(page)),
    navigate: () =>
      Promise.resolve({ ok: true, url: "https://apply.example.test/form" }),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    goBack: () =>
      Promise.resolve({ ok: true, url: "https://apply.example.test/form" }),
    readText: () => Promise.resolve("Apply for the role"),
    fillText: (ref, value) => {
      const control = page.controls.find(
        (entry) => (entry.ref ?? `c${entry.index}`) === ref,
      );
      if (control) control.value = value;
      return Promise.resolve({ ok: true, observedValue: value });
    },
    chooseOption: (_ref, option) =>
      Promise.resolve({ ok: true, observedValue: option }),
    setToggle: (ref, checked) => {
      const selected = page.controls.find(
        (entry) => (entry.ref ?? `c${entry.index}`) === ref,
      );
      if (selected) {
        if (selected.inputType === "radio" && checked)
          for (const sibling of page.controls)
            if (sibling.inputType === "radio" && sibling.name === selected.name)
              sibling.checked = false;
        selected.checked = checked;
      }
      return Promise.resolve({
        ok: true,
        observedValue: checked ? "checked" : "unchecked",
      });
    },
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () =>
      Promise.resolve({ ok: true, url: "https://apply.example.test/form" }),
    ...overrides.hands,
  };
  return {
    hands,
    config: {
      // Most of these tests walk a form step by step, which only Send for me
      // does; Fill in for me's own tests turn this off.
      intermediateWritesAuthorized: true,
      hands,
      accountCreationAuthorized: overrides.accountCreationAuthorized,
      authority: authority(overrides.authority),
      sources: {
        profile: profile(),
        resumeText: "Robin Ashford. 8 years of platform engineering.",
        posting: {
          title: "Platform Engineer",
          company: "Northwind Tools",
          location: "Manchester",
          description: "Own the internal platform.",
        },
        reusableAnswers: [],
        documents: [],
      },
      application: {
        jobId: "job_test",
        applicationId: "application_test",
        startingUrl: "https://apply.example.test/form",
      },
      siteLabel: "the careers site",
    },
  };
}

const now = () => new Date("2026-09-14T10:00:00.000Z");

test("optional history rows require a complete Profile record before adding, in either apply mode", async () => {
  for (const mode of ["confirm_before_submit", "autonomous_submit"] as const) {
    const page = rawPage({
      controls: [rawControl({ index: 0, label: "Full name" })],
      actions: [
        {
          index: 0,
          label: "Add another work history entry",
          inForm: true,
          visible: true,
          disabled: false,
        },
      ],
    });
    const { config, hands } = configFor(page, { authority: { mode } });
    const click = vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "clicked" }),
    );
    hands.clickElement = click;
    const guardState = createApplyGuardState();
    config.sources.profile = CandidateProfileSchema.parse({
      ...config.sources.profile,
      experiences: [{ id: "one", companyName: "Example", title: "Engineer" }],
    });
    const deps = { config, guardState, now };
    expect(
      (
        await executeApplyProposal(
          { tool: "click", ref: "a0" },
          observationOf(page).signature,
          deps,
        )
      ).kind,
    ).toBe("refused");
    expect(click).not.toHaveBeenCalled();
    config.sources.profile.experiences[0].startDate = "2024-01";
    expect(
      (
        await executeApplyProposal(
          { tool: "click", ref: "a0" },
          observationOf(page).signature,
          deps,
        )
      ).kind,
    ).toBe("moved");
    expect(click).toHaveBeenCalledOnce();
    expect(
      (
        await executeApplyProposal(
          { tool: "click", ref: "a0" },
          observationOf(page).signature,
          deps,
        )
      ).kind,
    ).toBe("refused");
    expect(click).toHaveBeenCalledOnce();
  }
});

test("a person's empty history row and a filled agent row cannot be removed", async () => {
  const group = "Application — Work history 1";
  const page = rawPage({
    controls: [rawControl({ index: 0, label: "Company", groupLabel: group })],
    actions: [
      {
        index: 0,
        label: "Remove entry",
        section: group,
        inForm: true,
        visible: true,
        disabled: false,
      },
    ],
  });
  const { config, hands } = configFor(page, {
    authority: { mode: "autonomous_submit" },
  });
  const click = vi.fn(() =>
    Promise.resolve({ ok: true as const, observedValue: "clicked" }),
  );
  hands.clickElement = click;
  const guardState = createApplyGuardState();
  const deps = { config, guardState, now };
  expect(
    (
      await executeApplyProposal(
        { tool: "click", ref: "a0" },
        observationOf(page).signature,
        deps,
      )
    ).kind,
  ).toBe("refused");
  guardState.ownedHistoryRows.add(`${page.url}|${page.stepLabel}|${group}`);
  page.controls[0].value = "Example";
  expect(
    (
      await executeApplyProposal(
        { tool: "click", ref: "a0" },
        observationOf(page).signature,
        deps,
      )
    ).kind,
  ).toBe("refused");
  page.controls[0].value = "";
  expect(
    (
      await executeApplyProposal(
        { tool: "click", ref: "a0" },
        observationOf(page).signature,
        deps,
      )
    ).kind,
  ).toBe("moved");
  expect(click).toHaveBeenCalledOnce();
});

describe("apply policy executor", () => {
  test("writes supported prose after the applicant-fact check", async () => {
    const source = rawPage({
      controls: [
        rawControl({ index: 0, tagName: "textarea", label: "Why this role?" }),
      ],
    });
    const fillText = vi.fn((_ref: string, value: string) => {
      source.controls[0].value = value;
      return Promise.resolve({
        ok: true as const,
        observedValue: value,
      });
    });
    const { config } = configFor(source, { hands: { fillText } });
    const result = await executeApplyProposal(
      {
        tool: "type",
        ref: "c0",
        text: "I would like to build reliable tools.",
      },
      observationOf(source).signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
      },
    );
    expect(result.kind).toBe("filled");
    expect(fillText).toHaveBeenCalledWith(
      "c0",
      "I would like to build reliable tools.",
    );
    if (result.kind === "filled") {
      expect(result.filled.answer.sourceKind).toBe("generated");
    }
  });
  test("never touches a security-check box, even one the person already ticked", async () => {
    const source = rawPage({
      bodyText: "Apply I am not a robot Local fake CAPTCHA",
      controls: [
        rawControl({ index: 0, label: "Full name", value: "Robin Ashford" }),
        rawControl({
          index: 1,
          inputType: "checkbox",
          role: "checkbox",
          label: "I am not a robot",
          checked: true,
        }),
      ],
    });
    const setToggle = vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "unchecked" }),
    );
    const { config } = configFor(source, { hands: { setToggle } });
    const result = await executeApplyProposal(
      { tool: "set_checkbox", ref: "c1", checked: true },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(result.kind).toBe("refused");
    expect(setToggle).not.toHaveBeenCalled();
  });
  test("refuses an account-creation link when this run has no account authority", async () => {
    const page = rawPage({
      bodyText: "Sign in or create an account to continue.",
      links: [
        {
          index: 0,
          label: "Create account",
          href: "https://apply.example.test/register",
          target: "",
          visible: true,
          topOffset: 10,
        },
      ],
    });
    const followLink = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        url: "https://apply.example.test/register",
      }),
    );
    const { config } = configFor(page, { hands: { followLink } });
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "follow_link", ref: "l0" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("Expected refusal.");
    expect(outcome.reason).toMatch(/account has not been authorized/i);
    expect(followLink).not.toHaveBeenCalled();
  });

  test("permits an account-creation link only with exact account authority", async () => {
    const page = rawPage({
      links: [
        {
          index: 0,
          label: "Register",
          href: "https://apply.example.test/register",
          target: "",
          visible: true,
          topOffset: 10,
        },
      ],
    });
    const followLink = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        url: "https://apply.example.test/register",
      }),
    );
    const { config } = configFor(page, {
      accountCreationAuthorized: true,
      hands: { followLink },
    });
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "follow_link", ref: "l0" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("moved");
    expect(followLink).toHaveBeenCalledOnce();
  });

  test("keeps a continuation on its retained form instead of following the site header home", async () => {
    const page = rawPage({
      url: "https://apply.example.test/workday/apply/2?stage=application",
      controls: [
        rawControl({ index: 0, label: "First name", inputType: "text" }),
      ],
      actions: [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ],
      links: [
        {
          index: 0,
          label: "Careers home",
          href: "https://apply.example.test/workday/",
          target: "",
          visible: true,
          topOffset: 10,
        },
      ],
    });
    const followLink = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        url: "https://apply.example.test/workday/",
      }),
    );
    const { config } = configFor(page, { hands: { followLink } });
    config.application.continuation = {
      sourceUrls: ["https://apply.example.test/workday/jobs/2"],
    };
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "follow_link", ref: "l0" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("Expected refusal.");
    expect(outcome.reason).toMatch(/retained application form/i);
    expect(followLink).not.toHaveBeenCalled();
  });

  test("a continuation can still advance to another page inside its wizard", async () => {
    const page = rawPage({
      url: "https://apply.example.test/workday/apply/2?stage=application",
    });
    const navigate = vi.fn((url: string) =>
      Promise.resolve({ ok: true as const, url }),
    );
    const { config } = configFor(page, { hands: { navigate } });
    config.application.continuation = {
      sourceUrls: ["https://apply.example.test/workday/jobs/2"],
    };
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      {
        tool: "navigate",
        url: "https://apply.example.test/workday/apply/2?stage=review",
      },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("moved");
    expect(navigate).toHaveBeenCalledOnce();
  });

  test("a continuation may leave an account landing page to reach its known job", async () => {
    const landing = rawPage({
      url: "https://apply.example.test/workday/account",
      controls: [
        rawControl({
          index: 0,
          label: "Search jobs",
          inputType: "search",
          required: false,
        }),
      ],
    });
    const navigate = vi.fn((url: string) =>
      Promise.resolve({ ok: true as const, url }),
    );
    const { config } = configFor(landing, { hands: { navigate } });
    config.application.continuation = {
      sourceUrls: ["https://apply.example.test/workday/jobs/2"],
    };
    const observation = observationOf(landing);

    const outcome = await executeApplyProposal(
      {
        tool: "navigate",
        url: "https://apply.example.test/workday/jobs/2",
      },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("moved");
    expect(navigate).toHaveBeenCalledOnce();
  });

  test("stops before pressing a credential-form action outside the task-local credential path", async () => {
    const page = rawPage({
      url: "https://apply.example.test/signin",
      bodyText: "Sign in to continue",
      controls: [
        rawControl({
          index: 0,
          label: "Password",
          inputType: "password",
          required: true,
        }),
      ],
      actions: [
        {
          index: 0,
          label: "Sign in",
          visible: true,
          disabled: false,
        },
      ],
    });
    const clickElement = vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "clicked" }),
    );
    const { config } = configFor(page, { hands: { clickElement } });
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "click", ref: "a0" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome).toMatchObject({
      kind: "paused",
      pause: { blocker: { code: "site_login_required" } },
    });
    expect(clickElement).not.toHaveBeenCalled();
  });

  test("never types a model-proposed value into a credential form", async () => {
    const page = rawPage({
      url: "https://apply.example.test/signin",
      bodyText: "Sign in to continue",
      controls: [
        rawControl({
          index: 0,
          label: "Password",
          inputType: "password",
          required: true,
        }),
      ],
      actions: [
        {
          index: 0,
          label: "Sign in",
          visible: true,
          disabled: false,
        },
      ],
    });
    const fillText = vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "redacted" }),
    );
    const { config } = configFor(page, { hands: { fillText } });
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      {
        tool: "type",
        ref: "c0",
        text: "invented-password",
        groundedIn: ["the posting"],
      },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome).toMatchObject({
      kind: "paused",
      pause: { blocker: { code: "site_login_required" } },
    });
    expect(fillText).not.toHaveBeenCalled();
  });

  // A value about the person goes into the form exactly as stored, however
  // the record id was shortened, without asking the fact check.
  test.each([
    { label: "Phone", inputType: "tel", typed: "+49 555 1234567-88" },
    {
      label: "LinkedIn URL",
      inputType: "url",
      typed: "https://www.linkedin.com/in/robin-ashford-test-profile-2026",
    },
    {
      label: "GitHub",
      inputType: "url",
      typed: "https://github.com/robin-ashford-builds",
    },
    {
      label: "Portfolio website",
      inputType: "url",
      typed: "https://portfolio.example.test/robin-ashford/work",
    },
  ])(
    "writes the stored $label exactly",
    async ({ label, inputType, typed }) => {
      const page = rawPage({
        controls: [rawControl({ index: 0, label, inputType })],
      });
      const { config, hands } = configFor(page);
      const stored = config.sources.profile;
      stored.phone = "+49 555 1234567-88";
      stored.linkedinUrl =
        "https://www.linkedin.com/in/robin-ashford-test-profile-2026";
      stored.githubUrl = "https://github.com/robin-ashford-builds";
      stored.portfolioUrl = "https://portfolio.example.test/robin-ashford/work";
      const fillText = vi.spyOn(hands, "fillText");
      const checkWrittenAnswer = vi.fn();
      const observation = observationOf(page);

      const outcome = await executeApplyProposal(
        { tool: "type", ref: "c0", text: typed },
        observation.signature,
        {
          config,
          now,
          guardState: createApplyGuardState(),
        },
      );

      expect(outcome.kind).toBe("filled");
      expect(checkWrittenAnswer).not.toHaveBeenCalled();
      expect(fillText).toHaveBeenCalledWith("c0", typed);
    },
  );

  test("a proposal made against a page that has since changed is refused", async () => {
    const page = rawPage({
      controls: [rawControl({ index: 0, label: "Email", inputType: "email" })],
    });
    const { config, hands } = configFor(page);
    const fillText = vi.spyOn(hands, "fillText");

    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "" },
      "a-signature-from-an-older-page",
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("refused");
    expect(fillText).not.toHaveBeenCalled();
  });

  test("a reviewed employer handoff may be filled even when only the listing origin is authorized to send", async () => {
    const page = rawPage({
      url: "https://somewhere-else.example.test/form",
      controls: [rawControl({ index: 0, label: "Email", inputType: "email" })],
    });
    const { config } = configFor(page, {
      authority: { allowedOrigins: ["https://apply.example.test"] },
    });
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "robin.ashford@example.test" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("filled");
  });

  test("a hop to another site is reported as a fact when nothing forbids it", async () => {
    // A listing on one site whose form lives on another is the ordinary shape
    // of job applications, so it is told to the model rather than blocked.
    const page = rawPage({
      url: "https://boards.example-ats.test/form",
      controls: [rawControl({ index: 0, label: "Email", inputType: "email" })],
    });
    const { config } = configFor(page);
    const guardState = createApplyGuardState();

    const outcome = await executeApplyProposal(
      { tool: "navigate", url: "https://boards.example-ats.test/form" },
      observationOf(page).signature,
      { config, now, guardState },
    );

    expect(outcome.kind).toBe("moved");
    if (outcome.kind === "moved") {
      expect(outcome.note).toContain("a different site from the listing");
    }
  });

  test("with a reviewer, leaving the listing's site needs a reason the review accepts", async () => {
    const listing = rawPage({
      url: "https://apply.example.test/form",
      controls: [],
    });
    const employer = rawPage({
      url: "https://boards.example-ats.test/form",
      controls: [rawControl({ index: 0, label: "Email", inputType: "email" })],
    });
    let where = listing;
    const review = vi.fn(
      (move: { url: string; reason: string; fromUrl: string | null }) =>
        Promise.resolve(
          /application form/u.test(move.reason)
            ? {
                allowed: true,
                verdict: "The listing hands off to the employer's form.",
              }
            : {
                allowed: false,
                verdict: "That reason does not say what the page is for.",
              },
        ),
    );
    const { config } = configFor(listing, {
      hands: {
        observe: () => Promise.resolve(observationOf(where)),
        navigate: (url) => {
          where = url.startsWith("https://boards") ? employer : listing;
          return Promise.resolve({ ok: true, url });
        },
        goBack: () => {
          where = listing;
          return Promise.resolve({ ok: true, url: listing.url ?? "" });
        },
      },
    });
    const withReview = { ...config, reviewMove: review };
    const guardState = createApplyGuardState();

    const noReason = await executeApplyProposal(
      { tool: "navigate", url: "https://boards.example-ats.test/form" },
      observationOf(listing).signature,
      { config: withReview, now, guardState },
    );
    expect(noReason.kind).toBe("refused");
    if (noReason.kind === "refused")
      expect(noReason.reason).toContain("say why in reason");
    expect(review).not.toHaveBeenCalled();

    const weak = await executeApplyProposal(
      {
        tool: "navigate",
        url: "https://boards.example-ats.test/form",
        reason: "Looks interesting",
      },
      observationOf(listing).signature,
      { config: withReview, now, guardState },
    );
    expect(weak.kind).toBe("refused");
    if (weak.kind === "refused")
      expect(weak.reason).toContain("did not allow going there");

    const good = await executeApplyProposal(
      {
        tool: "navigate",
        url: "https://boards.example-ats.test/form",
        reason:
          "The Apply button on the listing links here, to the employer's application form",
      },
      observationOf(listing).signature,
      { config: withReview, now, guardState },
    );
    expect(good.kind).toBe("moved");
    if (good.kind === "moved") {
      expect(good.note).toContain("allowed after review");
      expect(good.observation.url).toBe("https://boards.example-ats.test/form");
    }
    expect(
      guardState.approvedOrigins.has("https://boards.example-ats.test"),
    ).toBe(true);
    expect(guardState.notes.join("\n")).toContain("Allowed after review");
  });

  test("a sign-in wall is reported on the page rather than ending the run", async () => {
    const page = rawPage({
      bodyText: "Please sign in to continue with your application",
      controls: [rawControl({ index: 0, label: "Email", inputType: "email" })],
    });
    const { config } = configFor(page);

    const observation = await config.hands.observe();

    // The model is told; what to do about it is the model's call, and it can
    // finish saying the person has to sign in.
    expect(observation.blocker?.code).toBe("site_login_required");
  });
});

describe("the letter this application sends", () => {
  const letterText =
    "Dear hiring team, I have spent eight years building internal platforms that other engineers depend on every day, and the work described in this posting is the same shape. I would bring that experience to your team and would welcome the chance to talk it through with you.";

  function lettersFor(
    document: {
      id: string;
      fileName: string;
      mimeType: string;
      label: string;
      kind: "cover_letter";
      loadBytes: () => Promise<Uint8Array>;
    } | null,
  ) {
    return {
      preference: {
        tone: "plain_professional" as const,
        length: "standard" as const,
        language: null,
        sample: null,
      },
      provide: () =>
        Promise.resolve({
          ok: true as const,
          text: letterText,
          document,
        }),
    };
  }

  test("when possible writes an optional letter box and records it as written for this job", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "textarea",
          label: "Cover letter",
          required: false,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    const fillText = vi.spyOn(hands, "fillText");
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "letter" },
      observation.signature,
      {
        config: {
          ...config,
          writing: {
            coverLetterPolicy: "when_possible",
            writtenAnswerLength: "short",
            preApprovedDeclarations: [],
          },
          letters: lettersFor(null),
        },
        now,
        guardState: createApplyGuardState(),
      },
    );

    expect(outcome.kind).toBe("filled");
    expect(fillText).toHaveBeenCalledWith("c0", letterText);
    if (outcome.kind === "filled") {
      expect(outcome.filled.questionKind).toBe("cover_letter");
      expect(outcome.filled.answer.provenanceLabel).toBe(
        "the letter written for this application",
      );
      expect(outcome.filled.answer.groundedIn.length).toBeGreaterThan(0);
    }
  });

  test("a file field asking for a letter gets the same letter as a file", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          inputType: "file",
          label: "Cover letter",
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    const uploadFile = vi.spyOn(hands, "uploadFile");
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "upload", ref: "c0", documentId: "document_letter" },
      observation.signature,
      {
        config: {
          ...config,
          letters: lettersFor({
            id: "document_letter",
            fileName: "letter.pdf",
            mimeType: "application/pdf",
            label: "Cover letter",
            kind: "cover_letter",
            loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
          }),
        },
        now,
        guardState: createApplyGuardState(),
      },
    );

    expect(outcome.kind).toBe("attached");
    expect(uploadFile).toHaveBeenCalledWith("c0", {
      name: "letter.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
    });
  });

  test("the person's own cover letter file is attached, even to an optional field, instead of writing one", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          inputType: "file",
          label: "Cover letter",
          required: false,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    const uploadFile = vi.spyOn(hands, "uploadFile");
    const observation = observationOf(page);
    const provideLetter = vi.fn();

    const outcome = await executeApplyProposal(
      { tool: "upload", ref: "c0", documentId: "document_asset_letter" },
      observation.signature,
      {
        config: {
          ...config,
          sources: {
            ...config.sources,
            documents: [
              {
                id: "document_asset_letter",
                fileName: "my-letter.pdf",
                mimeType: "application/pdf",
                label: "Cover letter from the person's files",
                kind: "cover_letter",
                loadBytes: () => Promise.resolve(new Uint8Array([7, 8, 9])),
              },
            ],
          },
          letters: { ...lettersFor(null), provide: provideLetter },
        },
        now,
        guardState: createApplyGuardState(),
      },
    );

    expect(outcome.kind).toBe("attached");
    if (outcome.kind === "attached") {
      expect(outcome.attachment.documentId).toBe("document_asset_letter");
    }
    expect(uploadFile).toHaveBeenCalledWith("c0", {
      name: "my-letter.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([7, 8, 9]),
    });
    expect(provideLetter).not.toHaveBeenCalled();
  });

  test("a portfolio field accepts the person's file but refuses a generated statement", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          inputType: "file",
          label: "Portfolio",
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    const uploadFile = vi.spyOn(hands, "uploadFile");
    const observation = observationOf(page);
    const own = {
      id: "own_portfolio",
      fileName: "portfolio.pdf",
      mimeType: "application/pdf",
      label: "Portfolio from the person's files",
      kind: "portfolio" as const,
      loadBytes: () => Promise.resolve(new Uint8Array([4, 5, 6])),
    };
    const generated = {
      ...own,
      id: "generated_statement",
      kind: "other" as const,
    };
    const sources = { ...config.sources, documents: [own, generated] };
    const refused = await executeApplyProposal(
      { tool: "upload", ref: "c0", documentId: generated.id },
      observation.signature,
      {
        config: { ...config, sources },
        now,
        guardState: createApplyGuardState(),
      },
    );
    expect(refused.kind).toBe("refused");
    expect(uploadFile).not.toHaveBeenCalled();
    const attached = await executeApplyProposal(
      { tool: "upload", ref: "c0", documentId: own.id },
      observation.signature,
      {
        config: { ...config, sources },
        now,
        guardState: createApplyGuardState(),
      },
    );
    expect(attached.kind).toBe("attached");
    expect(uploadFile).toHaveBeenCalledWith("c0", {
      name: "portfolio.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([4, 5, 6]),
    });
  });

  test("a file the form insists on that cannot be produced goes to the person", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          inputType: "file",
          label: "Cover letter (Word document)",
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    const uploadFile = vi.spyOn(hands, "uploadFile");
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "upload", ref: "c0", documentId: "document_letter" },
      observation.signature,
      {
        config: { ...config, letters: lettersFor(null) },
        now,
        guardState: createApplyGuardState(),
      },
    );

    expect(outcome.kind).toBe("paused");
    if (outcome.kind === "paused") {
      expect(outcome.pause.code).toBe("document_needs_you");
      expect(outcome.pause.summary).toContain(
        "Attach one here and it will be used",
      );
    }
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe("being ready to send", () => {
  const completePage = () =>
    rawPage({
      stepLabel: "Step 2 of 2",
      controls: [
        rawControl({
          index: 0,
          label: "Email",
          required: true,
          value: "robin@example.test",
        }),
      ],
      actions: [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ],
    });

  test("a complete form with authority is reported ready, and nothing is pressed", async () => {
    const page = completePage();
    const { config, hands } = configFor(page, {
      authority: {
        mode: "autonomous_submit",
        submitAuthorized: true,
        allowedOrigins: ["https://apply.example.test"],
      },
    });
    const clickAction = vi.spyOn(hands, "clickAction");
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "submit_application", ref: "a0" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("ready_to_send");
    if (outcome.kind === "ready_to_send") {
      expect(outcome.finalActionRef).toBe("a0");
      expect(outcome.finalActionLabel).toBe("Submit application");
    }
    // The one irreversible act is not this loop's to take.
    expect(clickAction).not.toHaveBeenCalled();
  });

  test("confirm-first reaches the send button but is never the one to press it", async () => {
    const page = completePage();
    const { config, hands } = configFor(page, {
      authority: {
        mode: "confirm_before_submit",
        submitAuthorized: false,
        allowedOrigins: ["https://apply.example.test"],
      },
    });
    const clickAction = vi.spyOn(hands, "clickAction");
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "submit_application", ref: "a0" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    // The form is worked all the way to the button so the person has a
    // complete application to review; pressing it stays theirs.
    expect(outcome.kind).toBe("ready_to_send");
    expect(clickAction).not.toHaveBeenCalled();
  });

  test.each([
    ["confirm_before_submit", false],
    ["autonomous_submit", true],
  ] as const)(
    "a generic click on the final button in %s mode uses the submission preflight without pressing it",
    async (mode, submitAuthorized) => {
      const page = completePage();
      const clickElement = vi.fn(() =>
        Promise.resolve({ ok: true as const, observedValue: "clicked" }),
      );
      const { config } = configFor(page, {
        authority: {
          mode,
          submitAuthorized,
          allowedOrigins: ["https://apply.example.test"],
        },
        hands: { clickElement },
      });
      const observation = observationOf(page);

      const outcome = await executeApplyProposal(
        { tool: "click", ref: "a0", reason: "The form is complete." },
        observation.signature,
        { config, now, guardState: createApplyGuardState() },
      );

      expect(outcome.kind).toBe("ready_to_send");
      expect(clickElement).not.toHaveBeenCalled();
    },
  );

  test("a model final click is handed to the send path without judging required answers", async () => {
    const page = completePage();
    page.controls = [
      rawControl({
        index: 0,
        label: "Email",
        required: true,
        value: "",
      }),
    ];
    const clickElement = vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "clicked" }),
    );
    const { config } = configFor(page, {
      authority: {
        mode: "confirm_before_submit",
        submitAuthorized: false,
        allowedOrigins: ["https://apply.example.test"],
      },
      hands: { clickElement },
    });
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "click", ref: "a0", reason: "The form is complete." },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("ready_to_send");
    expect(clickElement).not.toHaveBeenCalled();
  });
});

/**
 * Two controls that say the same thing are still two questions.
 *
 * A phone number sits beside its country list, and both are labelled Phone.
 * Treating them as one question gave the number field the country's 240
 * choices and stopped the country being answered from the profile at all.
 */
describe("questions keep to their own control", () => {
  const phoneCountry = rawControl({
    index: 0,
    tagName: "select",
    inputType: "select-one",
    label: "Country",
    groupLabel: "Phone",
    options: ["Afghanistan +93", "United Kingdom +44", "United States +1"],
  });
  const phoneNumber = rawControl({
    index: 1,
    inputType: "tel",
    label: "Phone",
    groupLabel: "Phone",
  });
  const yesNo = rawControl({
    index: 2,
    tagName: "select",
    inputType: "select-one",
    label: "Have you previously worked at or consulted for us?*",
    options: ["Yes", "No"],
  });

  test("the phone country and the phone number are two different questions", () => {
    const page = rawPage({ controls: [phoneCountry, phoneNumber, yesNo] });
    const observation = observationOf(page);
    const [country, number, choice] = observation.controls;
    const build = (control: (typeof observation.controls)[number]) =>
      buildPendingQuestion({
        control,
        jobId: "job_test",
        detectedAt: "2026-09-14T10:00:00.000Z",
        suggestion: null,
      });

    const countryQuestion = build(country);
    const numberQuestion = build(number);
    expect(countryQuestion.id).not.toBe(numberQuestion.id);
    // The number field has no choices; the country list's do not leak onto it.
    expect(numberQuestion.answerOptions).toEqual([]);
    expect(countryQuestion.answerOptions).toHaveLength(3);
    // Display still reads as one thing where the group only repeats the label.
    expect(numberQuestion.prompt).toBe("Phone");
    expect(countryQuestion.prompt).toBe("Phone — Country");

    const choiceQuestion = build(choice);
    expect(choiceQuestion.answerOptions).toEqual(["Yes", "No"]);
    expect(choiceQuestion.answerControlType).toBe("single_choice");
  });
});

/**
 * The same question, the same handle, on every run.
 *
 * A retry reads the page fresh and the refs come out renumbered. If the
 * question's identity moved with them, the answer the person gave yesterday
 * belongs to a question nothing recognises today, and they are asked again.
 */
describe("a question keeps its name across runs", () => {
  function askedPage(offset: number): RawApplyPage {
    const before = Array.from({ length: offset }, (_, index) =>
      rawControl({ index, label: `Filler ${index}` }),
    );
    return rawPage({
      controls: [
        ...before,
        rawControl({
          index: offset,
          tagName: "select",
          inputType: "select-one",
          label: "Have you previously worked at or consulted for us?*",
          options: ["Yes", "No"],
          required: true,
        }),
      ],
    });
  }

  test("renumbered refs do not change the question's id", () => {
    const first = observationOf(askedPage(0));
    const second = observationOf(askedPage(3));
    const build = (observation: ApplyFormObservation, ref: string) =>
      buildPendingQuestion({
        control: observation.controls.find((entry) => entry.ref === ref)!,
        siblings: observation.controls,
        jobId: "job_test",
        detectedAt: "2026-09-14T10:00:00.000Z",
        suggestion: null,
      });

    expect(build(first, "c0").id).toBe(build(second, "c3").id);
  });

  test("two controls that say exactly the same thing are still told apart", () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "select",
          inputType: "select-one",
          label: "Gender",
          options: ["Male", "Female"],
        }),
        rawControl({
          index: 1,
          tagName: "select",
          inputType: "select-one",
          label: "Gender",
          options: ["Male", "Female"],
        }),
      ],
    });
    const observation = observationOf(page);
    const ids = observation.controls.map(
      (control) =>
        buildPendingQuestion({
          control,
          siblings: observation.controls,
          jobId: "job_test",
          detectedAt: "2026-09-14T10:00:00.000Z",
          suggestion: null,
        }).id,
    );

    expect(new Set(ids).size).toBe(2);
  });

  test("one radio group has one stable id while equal-worded groups stay distinct", () => {
    const page = rawPage({
      controls: [
        ...["Yes", "No"].map((label, index) =>
          rawControl({
            index,
            inputType: "radio",
            name: "authorized-primary",
            label,
            value: label,
            groupLabel: "Are you authorized?",
          }),
        ),
        ...["Yes", "No"].map((label, index) =>
          rawControl({
            index: index + 2,
            inputType: "radio",
            name: "authorized-secondary",
            label,
            value: label,
            groupLabel: "Are you authorized?",
          }),
        ),
      ],
    });
    const observation = observationOf(page);
    const questions = observation.controls.map((control) =>
      buildPendingQuestion({
        control,
        siblings: observation.controls,
        jobId: "job_test",
        detectedAt: "2026-09-14T10:00:00.000Z",
        suggestion: null,
      }),
    );

    expect(questions[0]?.id).toBe(questions[1]?.id);
    expect(questions[2]?.id).toBe(questions[3]?.id);
    expect(questions[0]?.id).not.toBe(questions[2]?.id);
    expect(questions[0]?.answerOptions).toEqual(["Yes", "No"]);
  });

  test("radio ids ignore option wording and digest exact long group keys", () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          inputType: "radio",
          name: `${"same-prefix-".repeat(8)}alpha!`,
          label: "Yes",
          groupLabel: "",
        }),
        rawControl({
          index: 1,
          inputType: "radio",
          name: `${"same-prefix-".repeat(8)}alpha!`,
          label: "No",
          groupLabel: "",
        }),
        rawControl({
          index: 2,
          inputType: "radio",
          name: `${"same-prefix-".repeat(8)}alpha?`,
          label: "Yes",
          groupLabel: "",
        }),
      ],
    });
    const observation = observationOf(page);
    const ids = observation.controls.map(
      (control) =>
        buildPendingQuestion({
          control,
          siblings: observation.controls,
          jobId: "job_test",
          detectedAt: "2026-09-14T10:00:00.000Z",
          suggestion: null,
        }).id,
    );

    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
  });
});


describe("Round 2 application recovery", () => {
  test("an upload that retains another filename is not recorded as attached", async () => {
    const page = rawPage({
      controls: [rawControl({ index: 0, inputType: "file", label: "Resume" })],
    });
    const { config } = configFor(page, {
      hands: {
        uploadFile: () =>
          Promise.resolve({ ok: true, observedValue: "original.docx" }),
      },
    });
    config.sources.documents = [
      {
        id: "approved",
        kind: "resume",
        label: "Your CV",
        fileName: "approved.pdf",
        mimeType: "application/pdf",
        loadBytes: () => Promise.resolve(new Uint8Array([1])),
      },
    ];
    expect(
      await executeApplyProposal(
        { tool: "upload", ref: "c0", documentId: "approved" },
        observationOf(page).signature,
        { config, now, guardState: createApplyGuardState() },
      ),
    ).toMatchObject({ kind: "refused" });
  });
});

describe("one-use answers and compatible originals", () => {
  test("attaches an unchanged TXT copy when an Original Markdown resume is rejected", async () => {
    const source = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "Resume",
          inputType: "file",
          required: true,
          accept: ".txt,.pdf,.doc,.docx",
        }),
      ],
    });
    const { config, hands } = configFor(source);
    const bytes = new TextEncoder().encode(
      "# Robin Ashford\nSynthetic platform engineer\n",
    );
    config.sources.documents = [
      {
        id: "original",
        kind: "resume",
        fileName: "resume.md",
        mimeType: "text/markdown",
        label: "Original resume",
        loadBytes: () => Promise.resolve(bytes),
      },
    ];
    hands.uploadFile = vi.fn(hands.uploadFile);
    const result = await executeApplyProposal(
      { tool: "upload", ref: "c0", documentId: "original" },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(result.kind).toBe("attached");
    expect(hands.uploadFile).toHaveBeenCalledWith("c0", {
      name: "resume.txt",
      mimeType: "text/plain",
      bytes,
    });
    if (result.kind === "attached")
      expect(result.attachment.fileName).toBe("resume.txt");
    source.controls[0].value = "C:\\fakepath\\resume.txt";
    source.actions = [
      { index: 0, label: "Next", visible: true, disabled: false },
    ];
    const next = await executeApplyProposal(
      { tool: "click", ref: "a0" },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(next.kind).toBe("moved");
    source.actions[0].label = "Submit application";
    config.authority.mode = "confirm_before_submit";
    config.authority.allowedOrigins = ["https://apply.example.test"];
    const submit = await executeApplyProposal(
      { tool: "submit_application", ref: "a0" },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(submit.kind).toBe("ready_to_send");
  });

  test("requests a compatible file before uploading an unsupported Original", async () => {
    const source = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "Resume",
          inputType: "file",
          required: true,
          accept: ".pdf",
        }),
      ],
    });
    const { config, hands } = configFor(source);
    config.sources.documents = [
      {
        id: "original",
        kind: "resume",
        fileName: "resume.md",
        mimeType: "text/markdown",
        label: "Original resume",
        loadBytes: () => Promise.resolve(new Uint8Array([1])),
      },
    ];
    hands.uploadFile = vi.fn(hands.uploadFile);
    const result = await executeApplyProposal(
      { tool: "upload", ref: "c0", documentId: "original" },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(result).toMatchObject({
      kind: "paused",
      pause: { code: "document_needs_you" },
    });
    expect(hands.uploadFile).not.toHaveBeenCalled();
  });
});

test("an exact multi-choice selection preserves option labels containing commas", async () => {
  const label = "Writing, editing";
  const source = rawPage({
    controls: [
      rawControl({
        index: 0,
        inputType: "checkbox",
        label,
        groupLabel: "Skills",
        name: "skills",
        required: true,
        value: label,
      }),
      rawControl({
        index: 1,
        inputType: "checkbox",
        label: "Planning",
        groupLabel: "Skills",
        name: "skills",
        value: "Planning",
      }),
    ],
  });
  const { config, hands } = configFor(source);
  config.sources.reusableAnswers = [
    {
      id: "skills",
      kind: "other",
      label: "Skills",
      question: "Skills",
      answer: JSON.stringify([label]),
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  hands.setToggle = vi.fn(hands.setToggle);
  const result = await executeApplyProposal(
    { tool: "set_checkbox", ref: "c0", checked: true },
    observationOf(source).signature,
    { config, now, guardState: createApplyGuardState() },
  );
  expect(result.kind).toBe("filled");
  expect(hands.setToggle).toHaveBeenCalledWith("c0", true);
});

test.each([
  ["file", "saved answer"],
  ["text", "saved answer"],
  ["file", "document library"],
  ["text", "document library"],
] as const)(
  "uses a person's approved letter as %s from %s without asking again",
  async (delivery, source) => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "Cover letter",
          inputType: delivery === "file" ? "file" : "text",
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    config.application.applicationRecordId = "app";
    const approvedText =
      "I enjoy building dependable platforms. I can work 20 hours a week from Manchester.";
    config.sources.reusableAnswers = [
      {
        id: "application_letter",
        label: "Cover letter",
        question: "Cover letter",
        kind: "other",
        answer: approvedText,
        roleFamilies: [],
        proofEntryIds: [],
        applicationScope: {
          resultId: "old_result",
          applicationRecordId: "app",
          location: null,
        },
      },
    ];
    if (source === "document library") {
      config.sources.approvedLetterText = approvedText;
      // The library letter wins over an older one-use answer.
      config.sources.reusableAnswers = config.sources.reusableAnswers.map(
        (answer) => ({ ...answer, answer: "Earlier letter" }),
      );
    }
    if (source === "document library") {
      const prompt = createApplyUserPrompt(config);
      expect(prompt).toContain(approvedText);
      expect(prompt).toContain(
        "even when an earlier letter is already present",
      );
      expect(prompt).toContain("do not rewrite it or ask for approval again");
    }
    config.writing = {
      coverLetterPolicy: "never",
      writtenAnswerLength: "short",
      preApprovedDeclarations: [],
    };
    const provide = vi.fn(
      (
        request: Parameters<
          NonNullable<ApplyAgentConfig["letters"]>["provide"]
        >[0],
      ) =>
        Promise.resolve({
          ok: true as const,
          text: request.approvedText ?? "",
          document: {
            id: "letter",
            label: "Your letter",
            fileName: "letter.pdf",
            kind: "cover_letter" as const,
            mimeType: "application/pdf",
            loadBytes: () =>
              Promise.resolve(new TextEncoder().encode(request.approvedText)),
          },
        }),
    );
    config.letters = {
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: null,
      },
      provide,
    };
    const upload = vi.spyOn(hands, "uploadFile");
    const fill = vi.spyOn(hands, "fillText");
    const result = await executeApplyProposal(
      delivery === "file"
        ? { tool: "upload", ref: "c0", documentId: "letter" }
        : { tool: "type", ref: "c0", text: "letter" },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(result.kind).toBe(delivery === "file" ? "attached" : "filled");
    expect(provide).toHaveBeenCalledWith(
      expect.objectContaining({ approvedText, delivery }),
    );
    if (delivery === "file")
      expect(new TextDecoder().decode(upload.mock.calls[0][1].bytes)).toBe(
        approvedText,
      );
    else expect(fill).toHaveBeenCalledWith("c0", approvedText);
  },
);

test.each(["text", "file"] as const)(
  "replaces the retained %s letter through the executor without sending",
  async (delivery) => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "Cover letter",
          inputType: delivery === "file" ? "file" : "text",
          value: "Earlier letter",
        }),
      ],
    });
    const { config, hands } = configFor(page);
    config.sources.approvedLetterText = "  My exact approved letter.\n";
    config.letters = {
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: null,
      },
      provide: (request) =>
        Promise.resolve({
          ok: true,
          text: request.approvedText!,
          document: {
            id: "approved",
            kind: "cover_letter",
            label: "Approved letter",
            fileName: "approved.txt",
            mimeType: "text/plain",
            loadBytes: () =>
              Promise.resolve(new TextEncoder().encode(request.approvedText)),
          },
        }),
    };
    const chatWithTools = vi.fn(() =>
      Promise.resolve({
        toolCalls: [
          {
            id: "classify",
            type: "function" as const,
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify({
                questions: [
                  { index: 0, asksAboutPay: false, declarationKind: null },
                ],
              }),
            },
          },
        ],
      }),
    );
    const fill = vi.spyOn(hands, "fillText");
    const upload = vi.spyOn(hands, "uploadFile");
    const click = vi.spyOn(hands, "clickAction");
    const result = await replaceApprovedApplicationLetter({
      config,
      client: { chatWithTools },
      fields: ["Cover letter"],
    });
    expect(result).not.toBeNull();
    expect(chatWithTools).toHaveBeenCalledTimes(1);
    if (delivery === "file")
      expect(new TextDecoder().decode(upload.mock.calls[0][1].bytes)).toBe(
        config.sources.approvedLetterText,
      );
    else
      expect(fill).toHaveBeenCalledWith(
        "c0",
        config.sources.approvedLetterText,
      );
    expect(click).not.toHaveBeenCalled();
  },
);

test("does not guess a replacement when a recorded letter field is on another step", async () => {
  const { config, hands } = configFor(rawPage({ controls: [] }));
  const fill = vi.spyOn(hands, "fillText");
  const result = await replaceApprovedApplicationLetter({
    config,
    client: { chatWithTools: vi.fn() },
    fields: ["Cover letter"],
  });
  expect(result).toBeNull();
  expect(fill).not.toHaveBeenCalled();
});

test("keeps a generated numeric suggestion's real source for later review", () => {
  const control = observationOf(
    rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "Years of reporting experience",
          inputType: "text",
        }),
      ],
    }),
  ).controls[0];
  const question = buildPendingQuestion({
    control,
    jobId: "synthetic",
    detectedAt: "2026-10-05T10:00:00Z",
    suggestion: {
      value: "0",
      kind: control.questionKind,
      sourceKind: "generated",
      sourceId: "generated.reporting",
      provenanceLabel: "your profile",
      groundedIn: ["your profile"],
    },
  });
  expect(question.suggestedAnswers[0]).toMatchObject({
    sourceKind: "prior_answer",
    provenance: [
      {
        sourceId: "generated.reporting",
        label: "your profile",
        sourceKind: "prior_answer",
      },
    ],
  });
});

describe("picker replay: refused choices", () => {
  const picker = (overrides: Partial<RawApplyControl> = {}) =>
    rawPage({
      controls: [
        rawControl({
          index: 0,
          role: "combobox",
          inputType: "combobox",
          label: pickerReplay.question,
          options: [...pickerReplay.snapshotOptions],
          required: true,
          ...overrides,
        }),
      ],
    });
  const refusing = () =>
    vi.fn((_ref: string, option: string) =>
      Promise.resolve({
        ok: false as const,
        reason: "option_not_offered" as const,
        offeredOptions: [...pickerReplay.options],
        error: `The list did not offer "${option}".`,
      }),
    );
  const savedCountry = (answer: string) => ({
    id: "saved_country",
    kind: "other" as const,
    label: pickerReplay.question,
    question: pickerReplay.question,
    answer,
    roleFamilies: [],
    proofEntryIds: [],
  });

  test("a choice past the list read with the page still goes to the picker", async () => {
    const readList = Array.from(
      { length: pickerReplay.readListSize },
      (_, index) => `Region ${String(index).padStart(3, "0")}`,
    );
    const source = picker({ options: readList });
    const { config, hands } = configFor(source);
    config.sources.profile.currentCountry = pickerReplay.beyondReadList;
    const chooseOption = vi.spyOn(hands, "chooseOption");
    const outcome = await executeApplyProposal(
      {
        tool: "select",
        ref: "c0",
        option: pickerReplay.beyondReadList,
        storedFactId: "profile.currentCountry",
      },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(chooseOption).toHaveBeenCalledWith(
      "c0",
      pickerReplay.beyondReadList,
    );
    expect(outcome.kind).toBe("filled");
  });

  test("a refusal offers the model the form's own choices; repeating it hands over", async () => {
    const source = picker();
    const chooseOption = refusing();
    const { config } = configFor(source, { hands: { chooseOption } });
    config.sources.profile.currentCountry = pickerReplay.primary;
    const guardState = createApplyGuardState();
    const propose = () =>
      executeApplyProposal(
        {
          tool: "select",
          ref: "c0",
          option: pickerReplay.primary,
          storedFactId: "profile.currentCountry",
        },
        observationOf(source).signature,
        { config, now, guardState },
      );
    const first = await propose();
    expect(first.kind).toBe("refused");
    if (first.kind === "refused")
      expect(first.reason).toContain(JSON.stringify(pickerReplay.options));
    const second = await propose();
    expect(second.kind).toBe("suggestion");
    if (second.kind === "suggestion")
      expect(second.question?.answerOptions).toEqual(pickerReplay.options);
    expect(chooseOption).toHaveBeenCalledTimes(1);
    const control = observationOf(source).controls[0];
    expect(pickerExhausted(guardState, control)).toBe(true);
    expect(guardState.pickerAttempts.get(pickerQuestionKey(control))).toEqual({
      question: pickerQuestionKey(control),
      tried: [pickerReplay.primary.toLowerCase()],
      notOffered: [pickerReplay.primary.toLowerCase()],
      offeredOptions: pickerReplay.options,
    });
  });

  test("a long search never repeats an earlier refused picker choice", async () => {
    const source = picker({ label: "City", options: [] });
    const chooseOption = refusing();
    const { config } = configFor(source, { hands: { chooseOption } });
    config.sources.profile.currentLocation = "Prishtina";
    const guardState = createApplyGuardState();
    const tryOption = (option: string) =>
      executeApplyProposal(
        { tool: "select", ref: "c0", option },
        observationOf(source).signature,
        {
          config,
          now,
          guardState,
        },
      );
    for (let index = 0; index < 25; index++)
      await tryOption(`City spelling ${index}`);
    expect(chooseOption).toHaveBeenCalledTimes(25);
    const repeated = await tryOption("City spelling 0");
    expect(repeated.kind).toBe("suggestion");
    expect(chooseOption).toHaveBeenCalledTimes(25);
  });

  test("distinct supported choices remain available after two earlier refusals", async () => {
    const source = picker();
    const { config, hands } = configFor(source);
    const control = observationOf(source).controls[0];
    const earlier = [
      {
        question: pickerQuestionKey(control),
        tried: ["unlisted territory", "another territory"],
        notOffered: ["unlisted territory", "another territory"],
        offeredOptions: [...pickerReplay.options],
      },
    ];
    const chooseOption = vi.spyOn(hands, "chooseOption");
    const invent = (guardState: ReturnType<typeof createApplyGuardState>) =>
      executeApplyProposal(
        { tool: "select", ref: "c0", option: pickerReplay.options[1] },
        observationOf(source).signature,
        {
          config,
          now,
          guardState,
        },
      );
    // Without that history the same checked choice would be tried.
    expect((await invent(createApplyGuardState())).kind).toBe("filled");
    expect(chooseOption).toHaveBeenCalledTimes(1);
    chooseOption.mockClear();
    expect((await invent(createApplyGuardState(earlier))).kind).toBe("filled");
    expect(chooseOption).toHaveBeenCalledTimes(1);

    config.sources.reusableAnswers = [savedCountry(pickerReplay.options[0])];
    const answered = await executeApplyProposal(
      { tool: "select", ref: "c0", option: pickerReplay.options[0] },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState(earlier) },
    );
    expect(answered.kind).toBe("filled");
    expect(chooseOption).toHaveBeenCalledWith("c0", pickerReplay.options[0]);
  });

  test("a later success keeps the refused choice on record", async () => {
    const source = picker();
    const chooseOption = vi.fn((_ref: string, option: string) =>
      Promise.resolve(
        option === pickerReplay.primary
          ? {
              ok: false as const,
              reason: "option_not_offered" as const,
              offeredOptions: [...pickerReplay.options],
              error: "Not offered.",
            }
          : { ok: true as const, observedValue: option },
      ),
    );
    const { config } = configFor(source, { hands: { chooseOption } });
    config.sources.profile.currentCountry = pickerReplay.primary;
    const guardState = createApplyGuardState();
    const deps = { config, now, guardState };
    const signature = observationOf(source).signature;
    await executeApplyProposal(
      {
        tool: "select",
        ref: "c0",
        option: pickerReplay.primary,
        storedFactId: "profile.currentCountry",
      },
      signature,
      deps,
    );
    config.sources.reusableAnswers = [savedCountry(pickerReplay.options[0])];
    const chosen = await executeApplyProposal(
      { tool: "select", ref: "c0", option: pickerReplay.options[0] },
      signature,
      deps,
    );
    expect(chosen.kind).toBe("filled");
    const control = observationOf(source).controls[0];
    expect(
      guardState.pickerAttempts.get(pickerQuestionKey(control))?.tried,
    ).toEqual([pickerReplay.primary.toLowerCase()]);
    expect(guardState.openPickers.has(pickerQuestionKey(control))).toBe(false);
  });

  test("an optional picker that refuses its choice is left blank, not asked about", async () => {
    const source = picker({ required: false });
    const { config } = configFor(source, {
      hands: { chooseOption: refusing() },
    });
    config.sources.profile.currentCountry = pickerReplay.primary;
    const outcome = await executeApplyProposal(
      {
        tool: "select",
        ref: "c0",
        option: pickerReplay.primary,
        storedFactId: "profile.currentCountry",
      },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(outcome.kind).toBe("refused");
    expect(outcome).not.toHaveProperty("question");
  });
});

test("Needs you keeps every offered choice in the form's order", () => {
  const options = Array.from(
    { length: 250 },
    (_, index) => `Option ${String(index + 1).padStart(3, "0")}`,
  );
  const observation = buildApplyFormObservation(
    rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "select",
          label: "Choose a region",
          options,
          required: true,
        }),
      ],
    }),
    now().toISOString(),
  );
  expect(
    buildPendingQuestion({
      control: observation.controls[0],
      jobId: "synthetic",
      detectedAt: "2026-10-26T00:00:00Z",
      suggestion: null,
    }).answerOptions,
  ).toEqual(options);
});

test.each(["Target@Example.test", "wrong@example.test"])(
  "Google identifier grounding writes canonical Profile application email only: %s",
  async (text) => {
    const seen = rawPage({
      url: "https://accounts.google.com/v3/signin/identifier",
      title: "Sign in",
      controls: [rawControl({ index: 0, label: "Email", inputType: "email" })],
      actions: [{ index: 0, label: "Next", visible: true, disabled: false }],
    });
    const { config, hands } = configFor(seen);
    config.sources.profile.applicationIdentity.preferredEmail =
      "Target@Example.test";
    config.readIntendedAccountEmail = () => "Target@Example.test";
    config.browserPermissions = {
      googleSignIn: true,
      signIn: false,
      createAccounts: false,
      solveCaptchas: false,
    };
    const write = vi.spyOn(hands, "fillText");
    const result = await executeApplyProposal(
      { tool: "type", ref: "c0", text },
      observationOf(seen).signature,
      { config, guardState: createApplyGuardState(), now },
    );
    if (text === "wrong@example.test") {
      expect(result.kind).toBe("refused");
      expect(write).not.toHaveBeenCalled();
    } else {
      expect(result.kind).toBe("moved");
      expect(write).toHaveBeenCalledExactlyOnceWith(
        "c0",
        "Target@Example.test",
      );
    }
  },
);

test("navigation handoffs never turn a raw URL into a question", () => {
  const pause = pressOnSitePause(
    "http://127.0.0.1:47950/application/42",
    now(),
  );
  expect(pause.question?.prompt).toBe(
    "Press the application link on the site, then continue",
  );
  expect(JSON.stringify(pause)).not.toContain("http://");
});

test.each([
  ["", "", "pdf"],
  ["*/*", "", "pdf"],
  [".pdf,.doc,.docx", "", "pdf"],
  ["application/pdf,application/msword", "", "pdf"],
  [".docx", "", "docx"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "",
    "docx",
  ],
  ["", "Accepted formats: DOCX only", "docx"],
  [".pdf,.docx", "Supported files: .pdf, .docx", "pdf"],
])(
  "chooses the approved resume format for accept=%s guidance=%s",
  async (accept, hint, expected) => {
    const source = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "Resume Choose file",
          inputType: "file",
          accept,
          hint,
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(source);
    config.sources.documents = [
      ["pdf", "application/pdf"],
      [
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
    ].map(([extension, mime]) => ({
      id: extension,
      kind: "resume",
      fileName: `approved.${extension}`,
      mimeType: mime,
      label: "Your CV",
      loadBytes: () => Promise.resolve(new Uint8Array([1, 2])),
    }));
    hands.uploadFile = vi.fn(hands.uploadFile);
    const result = await executeApplyProposal(
      // Even a model choosing Word must use PDF when the field supports it.
      { tool: "upload", ref: "c0", documentId: "docx" },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(result.kind).toBe("attached");
    expect(hands.uploadFile).toHaveBeenCalledWith(
      "c0",
      expect.objectContaining({ name: `approved.${expected}` }),
    );
    if (result.kind === "attached")
      expect(result.attachment.fileName).toBe(`approved.${expected}`);
  },
);
