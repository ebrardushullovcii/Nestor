import githubReplay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/github-username.json";
import pickerReplay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/picker-handover.json";
import typedReplay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/typed-answer-permissions.json";
import { answerSourceCatalog } from "./answer-source-catalog";
import type { ApplyAnswerTags } from "@nestor/contracts";
import { createApplyUserPrompt } from "./apply-prompts";
import { replaceApprovedApplicationLetter } from "./approved-letter";
import {
  CandidateProfileSchema,
  type CandidateProfile,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  buildPendingQuestion,
  createApplyGuardState,
  executeApplyProposal,
  pickerExhausted,
  pickerQuestionKey,
} from "./policy-executor";
import type { RawApplyControl, RawApplyPage } from "@nestor/contracts";
import ownWords from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/own-words.json";
import discovery from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/listing-discovery.json";
import { buildApplyFormObservation } from "./page-hands";
import { runSubmitPreflight } from "./submit-preflight";
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
    setToggle: (_ref, checked) =>
      Promise.resolve({
        ok: true,
        observedValue: checked ? "checked" : "unchecked",
      }),
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

describe("apply policy executor", () => {
  test.each([
    "What is your go-to tool?",
    "What is your top skill?",
    "What is your preferred tool?",
    "What is your favourite tool?",
    "What is your favorite tool?",
    "What monitoring product do you love or hate, and why?",
  ])(
    "an exact skill fact cannot bypass an opinion handover: %s",
    async (question) => {
      const source = rawPage({
        controls: [rawControl({ index: 0, label: question, required: false })],
      });
      const { config } = configFor(source);
      config.sources.profile.skills = ["Playwright"];
      const fill = vi.spyOn(config.hands, "fillText"),
        checkWrittenAnswer = vi
          .fn()
          .mockResolvedValue({ supported: true, reason: "Supported" });
      const outcome = await executeApplyProposal(
        {
          tool: "type",
          ref: "c0",
          text: "Playwright",
          storedFactId: "profile.skills.0",
        },
        observationOf(source).signature,
        {
          config,
          now,
          guardState: createApplyGuardState(),
          checkWrittenAnswer,
        },
      );
      expect(outcome).toMatchObject({
        kind: "suggestion",
        question: { prompt: question },
      });
      expect(fill).not.toHaveBeenCalled();
      expect(checkWrittenAnswer).not.toHaveBeenCalled();
    },
  );
  test.each(discovery.cases)(
    "listing-source replay uses observed provenance, never a generated referral: $kind $options",
    async (entry) => {
      const source = rawPage({
        controls: [
          rawControl({
            index: 0,
            label: discovery.question,
            tagName: entry.kind === "select" ? "select" : "input",
            role: entry.kind === "combobox" ? "combobox" : "",
            options: entry.options,
            required: true,
          }),
        ],
      });
      const { config } = configFor(source);
      config.sources.listingDiscovery = {
        label: discovery.label,
        url: discovery.url,
      };
      const checkWrittenAnswer = vi
        .fn()
        .mockResolvedValue({ supported: true, reason: "Lying checker" });
      const chooseOption = vi.spyOn(config.hands, "chooseOption");
      const proposal =
        entry.kind === "text"
          ? { tool: "type" as const, ref: "c0", text: "A friend referred me" }
          : { tool: "select" as const, ref: "c0", option: "Referral" };
      const result = await executeApplyProposal(
        proposal,
        observationOf(source).signature,
        {
          config,
          now,
          guardState: createApplyGuardState(),
          checkWrittenAnswer,
        },
      );
      expect(checkWrittenAnswer).not.toHaveBeenCalled();
      if (entry.expected) {
        expect(result).toMatchObject({
          kind: "filled",
          filled: {
            answer: { value: entry.expected, sourceId: "listingDiscovery" },
          },
        });
        if (entry.kind !== "text")
          expect(chooseOption).toHaveBeenCalledWith("c0", entry.expected);
      } else {
        expect(result.kind).toBe("suggestion");
        expect(chooseOption).not.toHaveBeenCalled();
      }
    },
  );
  test.each(["prepare_only", "autonomous_submit"] as const)(
    "own-words replay: %s hands writing to the person before any checker or write",
    async (mode) => {
      for (const rule of ownWords.rules) {
        const source = rawPage({
          bodyText: "Page introduction. ".repeat(450) + rule,
          controls: [
            rawControl({
              index: 0,
              tagName: "textarea",
              label: ownWords.question,
              required: true,
            }),
          ],
        });
        const fillText = vi.fn();
        const checkWrittenAnswer = vi.fn();
        const { config } = configFor(source, {
          authority: { mode },
          hands: { fillText },
        });
        const result = await executeApplyProposal(
          { tool: "type", ref: "c0", text: ownWords.proposed },
          observationOf(source).signature,
          {
            config,
            now,
            guardState: createApplyGuardState(),
            checkWrittenAnswer,
          },
        );
        expect(result).toMatchObject({
          kind: "suggestion",
          question: { prompt: ownWords.question },
        });
        expect(fillText).not.toHaveBeenCalled();
        expect(checkWrittenAnswer).not.toHaveBeenCalled();
      }
    },
  );

  test("own-words replay: the person's saved wording is used unchanged", async () => {
    const source = rawPage({
      bodyText: ownWords.rules[0],
      controls: [
        rawControl({
          index: 0,
          tagName: "textarea",
          label: ownWords.question,
          required: true,
        }),
      ],
    });
    const { config } = configFor(source);
    config.sources.reusableAnswers = [
      {
        id: "own-answer",
        kind: "other",
        label: ownWords.question,
        question: ownWords.question,
        answer: "My own answer.",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const result = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "My own answer." },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(result.kind).toBe("filled");
    expect(source.controls[0].value).toBe("My own answer.");
  });

  test.each(["type", "upload"] as const)(
    "own-words replay: %s never drafts a letter",
    async (tool) => {
      const source = rawPage({
        bodyText: ownWords.rules[1],
        controls: [
          rawControl({
            index: 0,
            label: "Cover letter",
            required: true,
            ...(tool === "upload"
              ? { inputType: "file" }
              : { tagName: "textarea" }),
          }),
        ],
      });
      const { config } = configFor(source);
      const provide = vi.fn();
      config.letters = {
        preference: {
          tone: "plain_professional",
          length: "short",
          language: "en",
          sample: null,
        },
        provide,
      };
      const result = await executeApplyProposal(
        tool === "type"
          ? { tool, ref: "c0", text: ownWords.proposed }
          : { tool, ref: "c0", documentId: "letter" },
        observationOf(source).signature,
        { config, now, guardState: createApplyGuardState() },
      );
      expect(result).toMatchObject({
        kind: "suggestion",
        question: { prompt: "Cover letter" },
      });
      expect(provide).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    "does not write unsupported personal experience (required=%s)",
    async (required) => {
      const source = rawPage({
        controls: [
          rawControl({
            index: 0,
            tagName: "textarea",
            required,
            label:
              "Tell me about a feature you built using an AI coding assistant",
          }),
        ],
      });
      const fillText = vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          observedValue: "written",
        }),
      );
      const { config } = configFor(source, { hands: { fillText } });
      const checkWrittenAnswer = vi.fn(() =>
        Promise.resolve({
          supported: false,
          reason:
            "No supplied applicant fact says they used an AI coding assistant.",
        }),
      );
      const result = await executeApplyProposal(
        {
          tool: "type",
          ref: "c0",
          text: "I use an AI coding assistant every day.",
          groundedIn: ["general industry practice"],
        },
        observationOf(source).signature,
        {
          config,
          now,
          guardState: createApplyGuardState(),
          checkWrittenAnswer,
        },
      );
      expect(checkWrittenAnswer).toHaveBeenCalledOnce();
      expect(fillText).not.toHaveBeenCalled();
      expect(result.kind).toBe("suggestion");
      if (result.kind !== "suggestion")
        throw new Error("Expected grounded-answer handoff");
      expect(result.question !== null).toBe(required);
      expect(result.note).toContain("continue with the other fields");
    },
  );

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
        checkWrittenAnswer: () =>
          Promise.resolve({
            supported: true,
            reason: "Motivation, without unsupported personal history.",
          }),
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

  test("a value the person stored goes in as that fact; anything else waits for the fact check", async () => {
    const page = rawPage({
      controls: [rawControl({ index: 0, label: "Email", inputType: "email" })],
    });
    const { config, hands } = configFor(page);
    const fillText = vi.spyOn(hands, "fillText");
    const observation = observationOf(page);

    const stored = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "robin.ashford@example.test" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(stored).toMatchObject({
      kind: "filled",
      filled: {
        answer: { sourceId: "profile.email", sourceKind: "profile" },
      },
    });

    // Without a fact check, a value that is not one of the person's facts
    // is never typed; it is left for them.
    const other = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "someone.else@example.test" },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(other.kind).toBe("suggestion");
    expect(fillText).toHaveBeenCalledTimes(1);
    expect(fillText).toHaveBeenCalledWith("c0", "robin.ashford@example.test");
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
          checkWrittenAnswer,
        },
      );

      expect(outcome.kind).toBe("filled");
      expect(checkWrittenAnswer).not.toHaveBeenCalled();
      expect(fillText).toHaveBeenCalledWith("c0", typed);
    },
  );

  test("does not add unsupported technologies to a technical-skills answer", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "textarea",
          label: "Which technical skills would you bring?",
        }),
      ],
    });
    const { config, hands } = configFor(page);
    config.sources.profile.skills = ["React", "TypeScript", "Design Systems"];
    const fillText = vi.spyOn(hands, "fillText");
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      {
        tool: "type",
        ref: "c0",
        text: "I improve CI/CD and support distributed teams.",
      },
      observation.signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer: () =>
          Promise.resolve({
            supported: false,
            reason: "Nothing on file shows CI/CD work.",
          }),
      },
    );

    expect(outcome.kind).toBe("suggestion");
    if (outcome.kind === "suggestion") {
      expect(outcome.note).toContain("Nothing on file shows CI/CD work.");
    }
    expect(fillText).not.toHaveBeenCalled();
  });

  test.each([
    { tool: "set_checkbox", required: true },
    { tool: "click", required: true },
    { tool: "set_checkbox", required: false },
    { tool: "click", required: false },
  ] as const)(
    "an unapproved declaration stays unticked through $tool (required=$required)",
    async ({ tool, required }) => {
      const page = rawPage({
        controls: [
          rawControl({
            index: 0,
            inputType: "checkbox",
            label:
              "I certify that the information I have given is true and complete",
            required,
          }),
        ],
      });
      const { config, hands } = configFor(page);
      const setToggle = vi.spyOn(hands, "setToggle");
      const clickElement = vi.spyOn(hands, "clickElement");
      const observation = observationOf(page);

      const outcome = await executeApplyProposal(
        tool === "click"
          ? { tool: "click", ref: "c0" }
          : { tool: "set_checkbox", ref: "c0", checked: true },
        observation.signature,
        { config, now, guardState: createApplyGuardState() },
      );

      // Not a pause: the run carries on and hands the box back with the
      // finished form. Stopping here left the rest of the form empty.
      expect(outcome.kind).toBe("suggestion");
      if (outcome.kind === "suggestion") {
        if (required) expect(outcome.question?.prompt).toContain("I certify");
        else expect(outcome.question).toBeNull();
        expect(outcome.note).toMatch(/carry on/i);
      }
      expect(setToggle).not.toHaveBeenCalled();
      expect(clickElement).not.toHaveBeenCalled();
    },
  );

  test("a declaration the person answered Yes to earlier is ticked from that saved answer", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          inputType: "checkbox",
          label:
            "I certify that the information I have given is true and complete",
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    config.sources.reusableAnswers = [
      {
        id: "saved_certify",
        kind: "other",
        label:
          "I certify that the information I have given is true and complete",
        question:
          "I certify that the information I have given is true and complete",
        answer: "Yes, I agree",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const setToggle = vi.spyOn(hands, "setToggle");
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "set_checkbox", ref: "c0", checked: true },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("filled");
    if (outcome.kind === "filled") {
      expect(outcome.filled.answer.sourceKind).toBe("answer_library");
      expect(outcome.filled.answer.provenanceLabel).toBe(
        "your answer to this question",
      );
      // The record shows what the box shows, so the review finds it.
      expect(outcome.filled.answer.value).toBe("Yes");
    }
    expect(setToggle).toHaveBeenCalledWith("c0", true);
  });

  test("ticks each option the person chose for a required checkbox group", async () => {
    const page = rawPage({
      controls: ["Communication", "Planning", "Budgeting"].map((label, index) =>
        rawControl({
          index,
          inputType: "checkbox",
          name: "skills",
          label,
          // Like the replica sites: the group is required, its boxes are not.
          groupLabel: "Select your skills",
        }),
      ),
    });
    const { config, hands } = configFor(page);
    // The person's one-use answer from Needs you, as the run receives it.
    config.sources.reusableAnswers = [
      {
        id: "application_request_skills_question_skills",
        kind: "other",
        label: "Select your skills",
        question: "Select your skills",
        answer: JSON.stringify(["Communication", "Planning"]),
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const setToggle = vi.spyOn(hands, "setToggle");
    const checkWrittenAnswer = vi.fn(() =>
      Promise.resolve({ supported: false, reason: "Not in the facts." }),
    );
    const observation = observationOf(page);

    const chosen = await executeApplyProposal(
      { tool: "set_checkbox", ref: "c1", checked: true },
      observation.signature,
      { config, now, guardState: createApplyGuardState(), checkWrittenAnswer },
    );
    expect(chosen.kind).toBe("filled");
    if (chosen.kind === "filled") {
      expect(chosen.filled.answer.value).toBe("Planning");
      expect(chosen.filled.answer.sourceKind).toBe("answer_library");
    }
    expect(setToggle).toHaveBeenCalledWith("c1", true);
    expect(checkWrittenAnswer).not.toHaveBeenCalled();

    const uncheck = await executeApplyProposal(
      { tool: "set_checkbox", ref: "c1", checked: false },
      observation.signature,
      { config, now, guardState: createApplyGuardState(), checkWrittenAnswer },
    );
    expect(uncheck.kind).toBe("filled");
    expect(setToggle).toHaveBeenLastCalledWith("c1", true);

    // An option the person did not choose is not entered.
    const other = await executeApplyProposal(
      { tool: "set_checkbox", ref: "c2", checked: true },
      observation.signature,
      { config, now, guardState: createApplyGuardState(), checkWrittenAnswer },
    );
    expect(other.kind).not.toBe("filled");
    expect(setToggle).not.toHaveBeenCalledWith("c2", true);
  });

  test.each([
    [
      "truthfulness_certification",
      "I certify that the information I have given is true and complete",
    ],
    ["background_check_consent", "I consent to a background check"],
  ] as const)(
    "a %s declaration approved in Settings keeps that source",
    async (kind, label) => {
      const page = rawPage({
        controls: [
          rawControl({
            index: 0,
            inputType: "checkbox",
            label,
          }),
        ],
      });
      const { config } = configFor(page, {
        authority: {
          preApprovedAttestationKinds: [kind],
        },
      });
      // A saved "Yes" does not change why the box was ticked.
      config.sources.reusableAnswers = [
        {
          id: "saved_declaration",
          kind: "other",
          label,
          question: label,
          answer: "Yes, I agree",
          roleFamilies: [],
          proofEntryIds: [],
        },
      ];
      const observation = observationOf(page);

      const outcome = await executeApplyProposal(
        { tool: "set_checkbox", ref: "c0", checked: true },
        observation.signature,
        { config, now, guardState: createApplyGuardState() },
      );

      expect(outcome.kind).toBe("filled");
      if (outcome.kind === "filled") {
        expect(outcome.filled.answer.provenanceLabel).toBe(
          "your Settings (on by default)",
        );
        expect(outcome.filled.answer.value).toBe("Yes");
      }
    },
  );

  test.each(["set_checkbox", "click"] as const)(
    "a radio choice the facts do not support is not made, through %s",
    async (tool) => {
      const page = rawPage({
        controls: [
          rawControl({
            index: 0,
            inputType: "radio",
            name: "authorized",
            value: "internal_yes",
            label: "Yes",
            groupLabel: "Are you legally authorized to work in this country?",
            required: true,
          }),
          rawControl({
            index: 1,
            inputType: "radio",
            name: "authorized",
            value: "internal_no",
            label: "No",
            groupLabel: "Are you legally authorized to work in this country?",
            required: true,
          }),
        ],
      });
      const { config, hands } = configFor(page);
      const setToggle = vi.spyOn(hands, "setToggle");
      const checkWrittenAnswer = vi.fn((_question: string, answer: string) =>
        Promise.resolve(
          answer === "Yes"
            ? {
                supported: true,
                reason: "The profile says they may work here.",
              }
            : {
                supported: false,
                reason: "The profile says they may work here.",
              },
        ),
      );
      const observation = observationOf(page);
      const deps = {
        config,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer,
      };

      const outcome = await executeApplyProposal(
        tool === "click"
          ? { tool: "click", ref: "c1" }
          : { tool: "set_checkbox", ref: "c1", checked: true },
        observation.signature,
        deps,
      );

      expect(outcome.kind).toBe("suggestion");
      if (outcome.kind !== "suggestion") throw new Error("Expected a note.");
      expect(outcome.note).toContain("do not support it");
      expect(setToggle).not.toHaveBeenCalled();

      const groundedOutcome = await executeApplyProposal(
        tool === "click"
          ? { tool: "click", ref: "c0" }
          : { tool: "set_checkbox", ref: "c0", checked: true },
        observation.signature,
        deps,
      );

      expect(groundedOutcome).toMatchObject({
        kind: "filled",
        filled: {
          answer: {
            value: "Yes",
            sourceKind: "generated",
            provenanceLabel: "chosen on the form by Job Finder",
          },
        },
      });
      expect(setToggle).toHaveBeenCalledOnce();
    },
  );

  test.each(["application_request_a_salary", "answer_memory_salary"])(
    "pay with disclosure off uses only this application's answer (%s)",
    async (id) => {
      const page = rawPage({
        controls: [
          rawControl({ index: 0, label: "Expected salary", required: true }),
        ],
      });
      const { config, hands } = configFor(page);
      const fillText = vi.spyOn(hands, "fillText");
      config.sources.reusableAnswers = [
        {
          id,
          kind: "salary_expectation",
          label: "Expected salary",
          question: "Expected salary",
          answer: "90000 EUR",
          roleFamilies: [],
          proofEntryIds: [],
        },
      ];
      const outcome = await executeApplyProposal(
        { tool: "type", ref: "c0", text: "90000 EUR" },
        observationOf(page).signature,
        { config, now, guardState: createApplyGuardState() },
      );
      if (id.startsWith("application_")) {
        expect(outcome).toMatchObject({
          kind: "filled",
          filled: { answer: { value: "90000 EUR" } },
        });
        expect(fillText).toHaveBeenCalledWith("c0", "90000 EUR");
      } else {
        expect(outcome.kind).toBe("suggestion");
        expect(fillText).not.toHaveBeenCalled();
      }
    },
  );

  test.each([false, true])(
    "salary currency obeys pay privacy and prefers this application's earlier answer (%s)",
    async (ownAnswer) => {
      const page = rawPage({
        controls: [
          rawControl({ index: 0, label: "Expected salary", required: true }),
          rawControl({
            index: 1,
            label: "Currency",
            required: true,
            tagName: "select",
            options: ["EUR", "GBP"],
          }),
        ],
      });
      const { config, hands } = configFor(page);
      const chooseOption = vi.spyOn(hands, "chooseOption");
      config.sources.reusableAnswers = [
        {
          id: "other_job_currency",
          kind: "other",
          label: "Currency",
          question: "Currency",
          answer: "EUR",
          roleFamilies: [],
          proofEntryIds: [],
        },
        ...(ownAnswer
          ? [
              {
                id: "application_this_currency",
                kind: "other" as const,
                label: "Currency",
                question: "Currency",
                answer: "GBP",
                roleFamilies: [],
                proofEntryIds: [],
              },
            ]
          : []),
      ];
      const outcome = await executeApplyProposal(
        { tool: "select", ref: "c1", option: ownAnswer ? "GBP" : "EUR" },
        observationOf(page).signature,
        {
          config,
          now,
          guardState: createApplyGuardState(),
          // Even a classifier that overlooks the linked currency cannot override
          // the salary question's pay permission for this page.
          classifyQuestions: () =>
            Promise.resolve(
              new Map([
                [
                  "Expected salary",
                  { asksAboutPay: true, declarationKind: null },
                ],
                [
                  "Currency",
                  {
                    asksAboutPay: false,
                    declarationKind: null,
                    answerTags: {
                      kind: "salary" as const,
                      country: null,
                      sourceId: ownAnswer
                        ? "answerLibrary.application_this_currency"
                        : "answerLibrary.other_job_currency",
                    },
                  },
                ],
              ]),
            ),
        },
      );
      if (ownAnswer) {
        expect(outcome).toMatchObject({
          kind: "filled",
          filled: {
            answer: {
              value: "GBP",
              sourceId: "answerLibrary.application_this_currency",
            },
          },
        });
        expect(chooseOption).toHaveBeenCalledWith("c1", "GBP");
      } else {
        expect(outcome.kind).toBe("suggestion");
        expect(chooseOption).not.toHaveBeenCalled();
      }
    },
  );

  test("an application pay answer permits only the exact value for its question", async () => {
    const page = rawPage({
      controls: [
        rawControl({ index: 0, label: "Expected salary", required: true }),
      ],
    });
    const { config, hands } = configFor(page);
    const fillText = vi.spyOn(hands, "fillText");
    config.sources.reusableAnswers = [
      {
        id: "application_request_a_salary",
        kind: "salary_expectation",
        label: "Expected salary",
        question: "Expected salary",
        answer: "90000 EUR",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    for (const text of ["95000 EUR", "EUR"]) {
      const outcome = await executeApplyProposal(
        { tool: "type", ref: "c0", text },
        observationOf(page).signature,
        { config, now, guardState: createApplyGuardState() },
      );
      expect(outcome.kind).toBe("filled");
      expect(fillText).toHaveBeenLastCalledWith("c0", "90000 EUR");
    }
    config.sources.reusableAnswers = config.sources.reusableAnswers.map(
      (answer) => ({ ...answer, question: "Current salary" }),
    );
    expect(
      (
        await executeApplyProposal(
          { tool: "type", ref: "c0", text: "90000 EUR" },
          observationOf(page).signature,
          { config, now, guardState: createApplyGuardState() },
        )
      ).kind,
    ).toBe("suggestion");
    expect(fillText).toHaveBeenCalledTimes(2);
  });

  test("pay is left to the person unless they said otherwise", async () => {
    const page = rawPage({
      controls: [
        rawControl({ index: 0, label: "Expected salary", required: true }),
      ],
    });
    const { config } = configFor(page);
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "90000" },
      observation.signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer: () =>
          Promise.resolve({ supported: true, reason: "Saved pay answer." }),
      },
    );

    expect(outcome.kind).toBe("suggestion");
    if (outcome.kind === "suggestion") {
      expect(outcome.answer).toBeNull();
      expect(outcome.note).toContain("pay");
      expect(outcome.note).toContain("needs the person");
    }
  });

  test.each([
    {
      name: "text pay answer",
      control: rawControl({
        index: 0,
        label: "Expected salary",
        required: true,
      }),
      proposal: { tool: "type" as const, ref: "c0", text: "90000" },
    },
    {
      name: "select pay answer",
      control: rawControl({
        index: 0,
        tagName: "select",
        inputType: "select-one",
        label: "Expected salary",
        options: ["80000", "90000"],
        required: true,
      }),
      proposal: { tool: "select" as const, ref: "c0", option: "90000" },
    },
    {
      name: "radio office preference",
      control: rawControl({
        index: 0,
        inputType: "radio",
        name: "office",
        value: "London",
        label: "London",
        groupLabel: "Which office would you prefer?",
        required: true,
      }),
      proposal: { tool: "set_checkbox" as const, ref: "c0", checked: true },
    },
  ])(
    "leaves an unsourced $name for the person",
    async ({ control, proposal }) => {
      const page = rawPage({ controls: [control] });
      const { config, hands } = configFor(page);
      const fillText = vi.spyOn(hands, "fillText");
      const chooseOption = vi.spyOn(hands, "chooseOption");
      const setToggle = vi.spyOn(hands, "setToggle");

      const outcome = await executeApplyProposal(
        proposal,
        observationOf(page).signature,
        { config, now, guardState: createApplyGuardState() },
      );

      expect(outcome.kind).toBe("suggestion");
      if (outcome.kind === "suggestion") {
        expect(outcome.question?.prompt).toBeTruthy();
        expect(outcome.note).toContain("person's answer");
      }
      expect(fillText).not.toHaveBeenCalled();
      expect(chooseOption).not.toHaveBeenCalled();
      expect(setToggle).not.toHaveBeenCalled();
    },
  );

  test("a saved pay answer stays private when pay disclosure is set to pause", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "select",
          inputType: "select-one",
          label: "Expected salary",
          options: ["80000", "90000"],
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    config.sources.reusableAnswers = [
      ...config.sources.reusableAnswers,
      {
        id: "pay",
        kind: "salary_expectation",
        label: "Expected pay",
        question: "Expected salary",
        answer: "90000",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const chooseOption = vi.spyOn(hands, "chooseOption");

    const outcome = await executeApplyProposal(
      { tool: "select", ref: "c0", option: "90000" },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("suggestion");
    if (outcome.kind === "suggestion") {
      expect(outcome.question?.suggestedAnswers[0]?.text).toBe("90000");
    }
    expect(chooseOption).not.toHaveBeenCalled();
  });

  test("an optional preference stays empty and asks for the person's answer", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "select",
          inputType: "select-one",
          label: "Which office would you prefer?",
          options: ["Leeds", "Bristol"],
          required: false,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    const chooseOption = vi.spyOn(hands, "chooseOption");

    const outcome = await executeApplyProposal(
      { tool: "select", ref: "c0", option: "Bristol" },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("suggestion");
    if (outcome.kind === "suggestion") {
      expect(outcome.question).toMatchObject({
        prompt: "Which office would you prefer?",
        answerOptions: ["Leeds", "Bristol"],
      });
      expect(outcome.note).toContain("carry on with the rest");
    }
    expect(chooseOption).not.toHaveBeenCalled();
  });

  test("a question nothing can answer goes to the person with its exact wording", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "select",
          label: "Which of our office locations would you prefer?",
          options: ["Leeds", "Bristol"],
          required: true,
        }),
      ],
    });
    const { config } = configFor(page);
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "select", ref: "c0", option: "Leeds" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("suggestion");
    if (outcome.kind === "suggestion") {
      // The exact question is recorded, so the person gets its own words.
      expect(outcome.question?.prompt).toBe(
        "Which of our office locations would you prefer?",
      );
      expect(outcome.question?.answerOptions).toEqual(["Leeds", "Bristol"]);
    }
  });

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

  test("the send button is never pressed when the run may only prepare", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "Email",
          inputType: "email",
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
    const { config, hands } = configFor(page);
    const clickAction = vi.spyOn(hands, "clickAction");
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "submit_application", ref: "a0" },
      observation.signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("refused");
    expect(clickAction).not.toHaveBeenCalled();
  });
});

describe("submit preflight", () => {
  const sendableAuthority = authority({
    mode: "autonomous_submit",
    submitAuthorized: true,
    allowedOrigins: ["https://apply.example.test"],
  });

  test("stops before sending on an employer origin outside the saved authority", () => {
    const observation = observationOf(
      rawPage({
        url: "https://employer.example-ats.test/form",
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
      }),
    );

    const result = runSubmitPreflight({
      observation,
      proposedActionRef: "a0",
      authority: sendableAuthority,
    });

    expect(result).toEqual({
      ok: false,
      reason:
        "Job Finder is not authorized to send an application on https://employer.example-ats.test. The form is still available for review.",
    });
  });

  test("stops when a required answer is still empty", () => {
    const observation = observationOf(
      rawPage({
        controls: [rawControl({ index: 0, label: "Email", required: true })],
        actions: [
          {
            index: 0,
            label: "Submit application",
            visible: true,
            disabled: false,
          },
        ],
      }),
    );

    const result = runSubmitPreflight({
      observation,
      proposedActionRef: "a0",
      authority: sendableAuthority,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Email");
    }
  });

  test("stops when a file the form asks for is not attached", () => {
    const observation = observationOf(
      rawPage({
        controls: [
          rawControl({
            index: 0,
            label: "Email",
            required: true,
            value: "robin@example.test",
          }),
          rawControl({
            index: 1,
            label: "Resume",
            inputType: "file",
            required: true,
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
      }),
    );

    const result = runSubmitPreflight({
      observation,
      proposedActionRef: "a0",
      authority: sendableAuthority,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not attached");
    }
  });

  test("stops when there is still a step after this one", () => {
    const observation = observationOf(
      rawPage({
        stepLabel: "Step 1 of 2",
        controls: [
          rawControl({
            index: 0,
            label: "Email",
            required: true,
            value: "robin@example.test",
          }),
        ],
        actions: [
          { index: 0, label: "Next", visible: true, disabled: false },
          {
            index: 1,
            label: "Submit application",
            visible: true,
            disabled: false,
          },
        ],
      }),
    );

    const result = runSubmitPreflight({
      observation,
      proposedActionRef: "a1",
      authority: sendableAuthority,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("another step");
    }
  });

  test("passes on a complete final screen with authority", () => {
    const observation = observationOf(
      rawPage({
        stepLabel: "Step 2 of 2",
        controls: [
          rawControl({
            index: 0,
            label: "Email",
            required: true,
            value: "robin@example.test",
          }),
          rawControl({
            index: 1,
            label: "Resume",
            inputType: "file",
            required: true,
            value: "resume.pdf",
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
      }),
    );

    const result = runSubmitPreflight({
      observation,
      proposedActionRef: "a0",
      authority: sendableAuthority,
    });

    expect(result.ok).toBe(true);
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

  test("leaves an optional letter blank when settings allow only required letters", async () => {
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
      { tool: "type", ref: "c0", text: "A generated letter" },
      observation.signature,
      {
        config: {
          ...config,
          writing: {
            coverLetterPolicy: "when_required",
            writtenAnswerLength: "short",
            preApprovedDeclarations: [],
          },
        },
        now,
        guardState: createApplyGuardState(),
      },
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("optional");
    }
    expect(fillText).not.toHaveBeenCalled();
  });

  test("hands a required letter to the person when settings say never", async () => {
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
    const { config } = configFor(page);
    const observation = observationOf(page);

    const outcome = await executeApplyProposal(
      { tool: "upload", ref: "c0", documentId: "letter" },
      observation.signature,
      {
        config: {
          ...config,
          writing: {
            coverLetterPolicy: "never",
            writtenAnswerLength: "short",
            preApprovedDeclarations: [],
          },
        },
        now,
        guardState: createApplyGuardState(),
      },
    );

    expect(outcome.kind).toBe("paused");
    if (outcome.kind === "paused") {
      expect(outcome.pause.code).toBe("document_needs_you");
      expect(outcome.pause.question?.prompt).toContain("Cover letter");
    }
  });

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
      { tool: "type", ref: "c0", text: "" },
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

  test("a generic click cannot approve a final button while a required field is empty", async () => {
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

    expect(outcome.kind).toBe("refused");
    expect(clickElement).not.toHaveBeenCalled();
  });
});

/**
 * A form that saves each answer as it is typed.
 *
 * The guard refuses every one of those saves, so nothing leaves the page. What
 * changed is what happens next: the run keeps filling and writes the blocked
 * save down, and only stops when the form will not go on without it.
 */
describe("a site that saves as you go", () => {
  const savedAttempt = {
    kind: "fetch" as const,
    method: "POST",
    url: "https://boards.example.test/applications/autosave",
    at: "2026-09-14T10:00:01.000Z",
    carriedPreparedValue: true,
  };

  function safetyThatBlocksOneSave() {
    let handedOut = false;
    return {
      readBlockedAttempt: () => {
        if (handedOut) return Promise.resolve(null);
        handedOut = true;
        return Promise.resolve(savedAttempt);
      },
      registerPreparedValue: () => Promise.resolve(),
      openIntermediateWriteWindow: () => Promise.resolve(),
      closeIntermediateWriteWindow: () => Promise.resolve(),
      checkServiceWorker: () => Promise.resolve(null),
    };
  }

  test("a blocked background save during an answer does not stop the run", async () => {
    // The field keeps the answer, so the blocked save changed nothing.
    const page = rawPage({
      controls: [rawControl({ index: 0, label: "First Name" })],
    });
    const filled = rawPage({
      controls: [rawControl({ index: 0, label: "First Name", value: "Robin" })],
    });
    let reads = 0;
    const { config } = configFor(page, {
      hands: {
        observe: () => {
          reads += 1;
          return Promise.resolve(observationOf(reads === 1 ? page : filled));
        },
      },
    });
    const guardState = createApplyGuardState();

    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "Robin" },
      observationOf(page).signature,
      {
        config: { ...config, safety: safetyThatBlocksOneSave() },
        now,
        guardState,
      },
    );

    expect(outcome.kind).toBe("filled");
    expect(guardState.notes).toEqual([
      "Blocked a background save to boards.example.test while filling First Name.",
    ]);
    expect(guardState.blockedSaveCount).toBe(1);
  });

  test.each([
    "Next",
    "Continue",
    "Save and continue",
    "Save",
    "Done",
    "Absenden",
    // Outside a form, or once a field holds an answer, these are the
    // person's too; see the Fill presses below for where they are not.
    "Add another",
    "Accept",
    "Apply",
    "✓",
    "",
  ])("in Fill, %j is never pressed: the person gets it", async (label) => {
    const page = rawPage({
      controls: [rawControl({ index: 0, label: "First Name", value: "Robin" })],
      actions: [{ index: 0, label, visible: true, disabled: false }],
    });
    let pressed = 0;
    const { config } = configFor(page, {
      hands: {
        clickElement: () => {
          pressed += 1;
          return Promise.resolve({ ok: true, observedValue: "clicked" });
        },
      },
    });
    const outcome = await executeApplyProposal(
      { tool: "click", ref: "a0" },
      observationOf(page).signature,
      {
        config: {
          ...config,
          intermediateWritesAuthorized: false,
          safety: safetyThatBlocksOneSave(),
        },
        now,
        guardState: createApplyGuardState(),
      },
    );
    expect(pressed).toBe(0);
    // A label the run reads as the send ends at Ready; anything else is
    // handed to the person.
    if (outcome.kind !== "ready_to_send") {
      expect(outcome.kind).toBe("paused");
      if (outcome.kind === "paused")
        expect(outcome.pause.blocker?.nextActionLabel).toMatch(
          /on the site, then continue$/u,
        );
    }
  });

  test("in Fill with the site's field saves allowed, Next is still the person's", async () => {
    const page = rawPage({
      controls: [rawControl({ index: 0, label: "First Name", value: "Robin" })],
      actions: [{ index: 0, label: "Next", visible: true, disabled: false }],
    });
    let pressed = 0;
    const { config } = configFor(page, {
      hands: {
        clickElement: () => {
          pressed += 1;
          return Promise.resolve({ ok: true, observedValue: "clicked" });
        },
      },
    });
    const outcome = await executeApplyProposal(
      { tool: "click", ref: "a0" },
      observationOf(page).signature,
      {
        config: {
          ...config,
          intermediateWritesAuthorized: true,
          pressesFormButtons: false,
          safety: safetyThatBlocksOneSave(),
        },
        now,
        guardState: createApplyGuardState(),
      },
    );
    expect(pressed).toBe(0);
    expect(outcome.kind).toBe("paused");
  });

  test.each([
    ["https://apply.example.test/api/submit?applicationId=42", 0],
    ["https://apply.example.test/form/step-2", 0],
    // The form it was started on, and this same page, are its own to open.
    ["https://apply.example.test/form#questions", 1],
  ])("in Fill, a link to %s is pressed %i times", async (href, presses) => {
    const page = rawPage({
      links: [
        {
          index: 0,
          label: "Continue",
          href,
          target: "",
          visible: true,
          topOffset: 10,
        },
      ],
    });
    let pressed = 0;
    const { config } = configFor(page, {
      hands: {
        clickElement: () => {
          pressed += 1;
          return Promise.resolve({ ok: true, observedValue: "clicked" });
        },
      },
    });
    const outcome = await executeApplyProposal(
      { tool: "click", ref: "l0" },
      observationOf(page).signature,
      {
        config: {
          ...config,
          intermediateWritesAuthorized: false,
          safety: safetyThatBlocksOneSave(),
        },
        now,
        guardState: createApplyGuardState(),
      },
    );
    expect(pressed).toBe(presses);
    if (!presses) expect(outcome.kind).toBe("paused");
  });

  test("in Fill, a picker's option is still pressed: it answers a field", async () => {
    const page = rawPage({
      clickables: [
        {
          index: 0,
          label: "Portugal",
          role: "option",
          tagName: "li",
          visible: true,
          topOffset: 0,
        },
      ],
    });
    let pressed = 0;
    const { config } = configFor(page, {
      hands: {
        clickElement: () => {
          pressed += 1;
          return Promise.resolve({ ok: true, observedValue: "clicked" });
        },
      },
    });
    await executeApplyProposal(
      { tool: "click", ref: "e0" },
      observationOf(page).signature,
      {
        config: {
          ...config,
          intermediateWritesAuthorized: false,
          safety: safetyThatBlocksOneSave(),
        },
        now,
        guardState: createApplyGuardState(),
      },
    );
    expect(pressed).toBe(1);
  });

  describe("in Fill, presses that only help it fill", () => {
    const fillPresses = async (
      page: RawApplyPage,
      refs: string[],
      options: {
        guardState?: ReturnType<typeof createApplyGuardState>;
        continuation?: boolean;
      } = {},
    ) => {
      const pressed: string[] = [];
      const { config } = configFor(page, {
        hands: {
          clickElement: (ref) => {
            pressed.push(ref);
            return Promise.resolve({ ok: true, observedValue: "clicked" });
          },
        },
      });
      const guardState = options.guardState ?? createApplyGuardState();
      const outcomes = [];
      for (const ref of refs)
        outcomes.push(
          await executeApplyProposal(
            { tool: "click", ref },
            observationOf(page).signature,
            {
              config: {
                ...config,
                intermediateWritesAuthorized: false,
                safety: safetyThatBlocksOneSave(),
                application: {
                  ...config.application,
                  ...(options.continuation
                    ? { continuation: { sourceUrls: [] } }
                    : {}),
                },
              },
              now,
              guardState,
            },
          ),
        );
      return { pressed, outcomes };
    };
    const banner = (labels: string[], section = "Cookie preferences") =>
      labels.map((label, index) => ({
        index,
        label,
        visible: true,
        disabled: false,
        section,
      }));

    test("a cookie banner is dismissed with Reject, whichever button was asked for", async () => {
      const page = rawPage({ actions: banner(["Accept all", "Reject all"]) });
      const { pressed, outcomes } = await fillPresses(page, ["a0"]);
      expect(pressed).toEqual(["a1"]);
      expect(outcomes[0]?.kind).toBe("moved");
    });

    test("a banner without Reject is dismissed with Necessary only, else Accept", async () => {
      const necessary = rawPage({
        actions: banner(["Accept all cookies", "Necessary cookies only"]),
      });
      expect((await fillPresses(necessary, ["a0"])).pressed).toEqual(["a1"]);
      const acceptOnly = rawPage({
        actions: banner(["OK"], "We use cookies to run this site."),
      });
      expect((await fillPresses(acceptOnly, ["a0"])).pressed).toEqual(["a0"]);
    });

    test("Accept outside a cookie banner is the person's", async () => {
      const page = rawPage({ actions: banner(["Accept"], "Offer details") });
      const { pressed, outcomes } = await fillPresses(page, ["a0"]);
      expect(pressed).toEqual([]);
      expect(outcomes[0]?.kind).toBe("paused");
    });

    test("the button that opens the form is pressed once, before anything is filled", async () => {
      const listing = () =>
        rawPage({
          bodyText: "Platform Engineer. About the role.",
          actions: [
            { index: 0, label: "Apply now", visible: true, disabled: false },
          ],
        });
      const first = await fillPresses(listing(), ["a0", "a0"]);
      expect(first.pressed).toEqual(["a0"]);
      expect(first.outcomes.map((outcome) => outcome.kind)).toEqual([
        "moved",
        // The second time it reads as the send, and nothing is ready.
        "refused",
      ]);

      const filled = createApplyGuardState();
      filled.fieldWrites = 1;
      const afterFilling = await fillPresses(listing(), ["a0"], {
        guardState: filled,
      });
      expect(afterFilling.pressed).toEqual([]);

      const continued = await fillPresses(listing(), ["a0"], {
        continuation: true,
      });
      expect(continued.pressed).toEqual([]);
    });

    test("an Apply button that would submit a form is not an opener", async () => {
      const page = rawPage({
        actions: [
          {
            index: 0,
            label: "Apply",
            visible: true,
            disabled: false,
            formAction: "https://apply.example.test/form",
            formMethod: "POST",
          },
        ],
      });
      const { pressed, outcomes } = await fillPresses(page, ["a0"]);
      expect(pressed).toEqual([]);
      expect(outcomes[0]?.kind).toBe("paused");
    });

    test("Add another inside the form adds one row, and the next waits for it to be filled", async () => {
      const page = rawPage({
        controls: [rawControl({ index: 0, label: "Job title" })],
        actions: [
          {
            index: 0,
            label: "+ Add another work history entry",
            visible: true,
            disabled: false,
            section: "Work history",
            inForm: true,
          },
        ],
      });
      const guardState = createApplyGuardState();
      const twice = await fillPresses(page, ["a0", "a0"], { guardState });
      expect(twice.pressed).toEqual(["a0"]);
      expect(twice.outcomes[1]?.kind).toBe("paused");

      guardState.fieldWrites += 1;
      expect((await fillPresses(page, ["a0"], { guardState })).pressed).toEqual(
        ["a0"],
      );
    });

    test("an Add button outside the form, or one that saves, is the person's", async () => {
      const page = rawPage({
        controls: [rawControl({ index: 0, label: "Job title" })],
        actions: [
          { index: 0, label: "Add", visible: true, disabled: false },
          {
            index: 1,
            label: "Add to favourites",
            visible: true,
            disabled: false,
            inForm: true,
          },
          {
            index: 2,
            label: "Add and continue",
            visible: true,
            disabled: false,
            inForm: true,
          },
        ],
      });
      const { pressed } = await fillPresses(page, ["a0", "a1", "a2"]);
      expect(pressed).toEqual([]);
    });
  });

  test("a press shuts the upload window first, so it cannot carry the selected file", async () => {
    const page = rawPage({
      actions: [{ index: 0, label: "Done", visible: true, disabled: false }],
    });
    const events: string[] = [];
    const { config } = configFor(page, {
      hands: {
        clickElement: () => {
          events.push("press");
          return Promise.resolve({ ok: true, observedValue: "clicked" });
        },
      },
    });
    await executeApplyProposal(
      { tool: "click", ref: "a0" },
      observationOf(page).signature,
      {
        config: {
          ...config,
          safety: {
            ...safetyThatBlocksOneSave(),
            readBlockedAttempt: () => Promise.resolve(null),
            closeUploadWindow: () => {
              events.push("close upload");
              return Promise.resolve();
            },
          },
        },
        now,
        guardState: createApplyGuardState(),
      },
    );
    expect(events).toEqual(["close upload", "press"]);
  });

  test("the page sending the form itself still stops everything", async () => {
    const page = rawPage({
      controls: [rawControl({ index: 0, label: "First Name" })],
    });
    const { config } = configFor(page);

    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "Robin" },
      observationOf(page).signature,
      {
        config: {
          ...config,
          safety: {
            ...safetyThatBlocksOneSave(),
            readBlockedAttempt: () =>
              Promise.resolve({
                ...savedAttempt,
                kind: "form_submit" as const,
              }),
          },
        },
        now,
        guardState: createApplyGuardState(),
      },
    );

    expect(outcome.kind).toBe("paused");
    if (outcome.kind === "paused") {
      expect(outcome.pause.summary).toContain(
        "tried to send the application on its own",
      );
    }
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

  test("the phone country the model picks is checked like any other answer", async () => {
    const page = rawPage({ controls: [phoneCountry, phoneNumber] });
    const { config, hands } = configFor(page);
    const chooseOption = vi.spyOn(hands, "chooseOption");
    const checkWrittenAnswer = vi.fn(() =>
      Promise.resolve({
        supported: true,
        reason: "The phone number on file is a UK number.",
      }),
    );

    const outcome = await executeApplyProposal(
      { tool: "select", ref: "c0", option: "United Kingdom +44" },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState(), checkWrittenAnswer },
    );

    expect(outcome.kind).toBe("filled");
    expect(checkWrittenAnswer).toHaveBeenCalledOnce();
    expect(chooseOption).toHaveBeenCalledWith("c0", "United Kingdom +44");
  });

  test("recorded listing provenance overrides proposed and saved sourcing stories", async () => {
    const sourceQuestion =
      "How did you hear about this job? Select an option Job board Company website Referral Other";
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "select",
          inputType: "select-one",
          label: sourceQuestion,
          options: [
            "Select an option",
            "Job board",
            "Company website",
            "Referral",
            "Other",
          ],
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    config.sources.listingDiscovery = {
      label: "Job board",
      url: "https://listing.example.test/42",
    };
    config.sources.reusableAnswers = [
      {
        id: "saved_source",
        kind: "other",
        label: sourceQuestion,
        question: sourceQuestion,
        answer: "Job board",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const chooseOption = vi.spyOn(hands, "chooseOption");

    const other = await executeApplyProposal(
      { tool: "select", ref: "c0", option: "Other" },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    // Without a fact check, a choice that is not the saved one is not made.
    expect(other.kind).toBe("filled");

    const outcome = await executeApplyProposal(
      { tool: "select", ref: "c0", option: "Job board" },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("filled");
    expect(chooseOption).toHaveBeenCalledTimes(2);
    expect(chooseOption).toHaveBeenCalledWith("c0", "Job board");
    if (outcome.kind === "filled") {
      expect(outcome.filled.answer).toMatchObject({
        value: "Job board",
        sourceKind: "posting",
      });
    }
  });

  test("a grounded choice that is not offered stays for the person", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "select",
          inputType: "select-one",
          label: "How did you hear about this job?",
          options: ["Referral", "Other"],
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    config.sources.reusableAnswers = [
      {
        id: "saved_source",
        kind: "other",
        label: "How did you hear about this job?",
        question: "How did you hear about this job?",
        answer: "Job board",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const chooseOption = vi.spyOn(hands, "chooseOption");

    const outcome = await executeApplyProposal(
      { tool: "select", ref: "c0", option: "Other" },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState() },
    );

    expect(outcome.kind).toBe("suggestion");
    if (outcome.kind === "suggestion") {
      expect(outcome.question?.suggestedAnswers).toEqual([]);
    }
    expect(chooseOption).not.toHaveBeenCalled();
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

describe("a button that opens a new tab", () => {
  test("the run goes where the tab was going, in this tab, and says so", async () => {
    const listing = rawPage({
      url: "https://remoteok.test/remote-jobs/staff-engineer",
      actions: [{ index: 0, label: "Apply", visible: true, disabled: false }],
    });
    const employerForm = rawPage({
      url: "https://jobs.employer.test/apply/123",
      controls: [rawControl({ index: 0, label: "First Name" })],
    });
    let popupHandedOut = false;
    let onEmployerSite = false;
    const navigated: string[] = [];
    const { config } = configFor(listing, {
      hands: {
        observe: () =>
          Promise.resolve(
            observationOf(onEmployerSite ? employerForm : listing),
          ),
        navigate: (url) => {
          navigated.push(url);
          onEmployerSite = true;
          return Promise.resolve({ ok: true, url });
        },
      },
    });
    const withSafety: ApplyAgentConfig = {
      ...config,
      safety: {
        readBlockedAttempt: () => {
          if (popupHandedOut) return Promise.resolve(null);
          popupHandedOut = true;
          return Promise.resolve({
            kind: "popup_open" as const,
            method: "GET",
            url: "https://jobs.employer.test/apply/123",
            at: "2026-09-14T10:00:01.000Z",
          });
        },
        registerPreparedValue: () => Promise.resolve(),
        openIntermediateWriteWindow: () => Promise.resolve(),
        closeIntermediateWriteWindow: () => Promise.resolve(),
        checkServiceWorker: () => Promise.resolve(null),
      },
    };

    const outcome = await executeApplyProposal(
      { tool: "click", ref: "a0" },
      observationOf(listing).signature,
      {
        config: withSafety,
        now: () => new Date("2026-09-14T10:00:00.000Z"),
        guardState: createApplyGuardState(),
      },
    );

    expect(navigated).toEqual(["https://jobs.employer.test/apply/123"]);
    expect(outcome.kind).toBe("moved");
    if (outcome.kind === "moved") {
      expect(outcome.note).toContain('"Apply"');
      expect(outcome.note).toContain("new tab");
      expect(outcome.note).toContain("https://jobs.employer.test/apply/123");
      expect(outcome.observation.url).toBe(
        "https://jobs.employer.test/apply/123",
      );
    }
  });
});

describe("Round 2 application recovery", () => {
  test.each([true, false])(
    "the model maps saved prose to an option only with a supported fact check (%s)",
    async (supported) => {
      const page = rawPage({
        controls: [
          rawControl({
            index: 0,
            tagName: "select",
            label: "Do you need visa sponsorship in Germany?",
            required: true,
            options: ["Yes", "No"],
          }),
        ],
      });
      const { config, hands } = configFor(page);
      config.sources.reusableAnswers = [
        {
          id: "sponsorship",
          kind: "visa_sponsorship",
          label: "Sponsorship",
          question: "Do you need visa sponsorship in Germany?",
          answer:
            "I will need employer sponsorship after my student permit ends.",
          proofEntryIds: [],
          roleFamilies: [],
          applicationScope: {
            hiringCountry: "DE",
            resultId: null,
            applicationRecordId: null,
            location: null,
          },
        },
      ];
      config.sources.posting.location = "Berlin, Germany";
      const choose = vi.spyOn(hands, "chooseOption");
      const check = vi.fn(() =>
        Promise.resolve({
          supported,
          reason: "Permit conditions need clarification.",
        }),
      );
      const outcome = await executeApplyProposal(
        { tool: "select", ref: "c0", option: "Yes" },
        observationOf(page).signature,
        {
          config,
          now,
          guardState: createApplyGuardState(),
          checkWrittenAnswer: check,
        },
      );
      expect(check).toHaveBeenCalledWith(
        "Do you need visa sponsorship in Germany?",
        "Yes",
      );
      expect(choose).toHaveBeenCalledTimes(supported ? 1 : 0);
      expect(outcome.kind).toBe(supported ? "filled" : "suggestion");
    },
  );

  test("an old upload must be replaced before advancing a retained form", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          inputType: "file",
          label: "Resume",
          value: "C:\\fakepath\\original.docx",
        }),
      ],
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
      ],
    });
    const { config, hands } = configFor(page);
    hands.uploadFile = (_ref, file) => {
      page.controls[0].value = file.name;
      return Promise.resolve({ ok: true, observedValue: file.name });
    };
    config.sources.documents = [
      {
        id: "approved",
        kind: "resume",
        label: "Your CV",
        fileName: "approved.pdf",
        mimeType: "application/pdf",
        loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
      },
    ];
    const click = vi.spyOn(hands, "clickElement");
    expect(
      await executeApplyProposal(
        { tool: "click", ref: "a0" },
        observationOf(page).signature,
        { config, now, guardState: createApplyGuardState() },
      ),
    ).toMatchObject({ kind: "refused" });
    expect(click).not.toHaveBeenCalled();
    expect(
      await executeApplyProposal(
        { tool: "upload", ref: "c0", documentId: "approved" },
        observationOf(page).signature,
        { config, now, guardState: createApplyGuardState() },
      ),
    ).toMatchObject({
      kind: "attached",
      attachment: { fileName: "approved.pdf" },
    });
    expect((await hands.observe()).controls[0]?.value).toBe("approved.pdf");
    expect(
      await executeApplyProposal(
        { tool: "click", ref: "a0" },
        observationOf(page).signature,
        { config, now, guardState: createApplyGuardState() },
      ),
    ).toMatchObject({ kind: "moved" });
    expect(click).toHaveBeenCalledOnce();
  });

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

describe("the model's answers stand when the person's facts support them (ADR 0041)", () => {
  const deps = (
    config: ApplyAgentConfig,
    supported: boolean,
    reason = "checked",
  ) => {
    const checkWrittenAnswer = vi.fn(() =>
      Promise.resolve({ supported, reason }),
    );
    return {
      checkWrittenAnswer,
      deps: {
        config,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer,
      },
    };
  };

  test("text matching a stored fact goes in as that fact without a check", async () => {
    const page = rawPage({
      controls: [rawControl({ index: 0, label: "Email", inputType: "email" })],
    });
    const { config } = configFor(page);
    const { deps: run, checkWrittenAnswer } = deps(config, true);
    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "robin.ashford@example.test" },
      observationOf(page).signature,
      run,
    );
    expect(checkWrittenAnswer).not.toHaveBeenCalled();
    if (outcome.kind !== "filled") throw new Error("Expected a fill");
    expect(outcome.filled.answer.sourceKind).toBe("profile");
  });

  test("the model's text replaces a stored fact the question was not asking for", async () => {
    // Read by keywords this is the person's own email; the model saw it asks
    // for a referee's.
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "Email",
          inputType: "email",
          groupLabel: "Referee",
        }),
      ],
    });
    const fillText = vi.fn((_ref: string, value: string) => {
      page.controls[0].value = value;
      return Promise.resolve({ ok: true as const, observedValue: value });
    });
    const { config } = configFor(page, { hands: { fillText } });
    config.sources.reusableAnswers = [];
    const { deps: run, checkWrittenAnswer } = deps(config, true);
    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "referee@example.test" },
      observationOf(page).signature,
      run,
    );
    expect(checkWrittenAnswer).toHaveBeenCalledOnce();
    expect(fillText).toHaveBeenCalledWith("c0", "referee@example.test");
    if (outcome.kind !== "filled") throw new Error("Expected a fill");
    expect(outcome.filled.answer.value).toBe("referee@example.test");
  });

  test("an unsupported answer is not written, and the reason is given", async () => {
    const page = rawPage({
      controls: [rawControl({ index: 0, label: "Email", inputType: "email" })],
    });
    const fillText = vi.fn();
    const { config } = configFor(page, { hands: { fillText } });
    const { deps: run } = deps(
      config,
      false,
      "That is not the applicant's email.",
    );
    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "someone.else@example.test" },
      observationOf(page).signature,
      run,
    );
    expect(fillText).not.toHaveBeenCalled();
    if (outcome.kind !== "suggestion") throw new Error("Expected a note");
    expect(outcome.note).toContain("That is not the applicant's email.");
  });

  test("the model chooses a role-context option once the check supports it", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "select",
          label: "Which role family is this application for?",
          required: true,
          options: ["Engineering", "Design", "Other"],
        }),
      ],
    });
    const { config, hands } = configFor(page);
    const choose = vi.spyOn(hands, "chooseOption");
    const { deps: run, checkWrittenAnswer } = deps(config, true);
    const outcome = await executeApplyProposal(
      { tool: "select", ref: "c0", option: "Other" },
      observationOf(page).signature,
      run,
    );
    expect(checkWrittenAnswer).toHaveBeenCalledOnce();
    expect(choose).toHaveBeenCalledWith("c0", "Other");
    expect(outcome.kind).toBe("filled");
  });

  test("pay the person keeps to themselves is left for them whatever the model chose", async () => {
    const page = rawPage({
      controls: [
        rawControl({ index: 0, label: "Expected salary", required: true }),
      ],
    });
    const fillText = vi.fn();
    const { config } = configFor(page, { hands: { fillText } });
    const { deps: run, checkWrittenAnswer } = deps(config, true);
    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "60000" },
      observationOf(page).signature,
      run,
    );
    expect(checkWrittenAnswer).not.toHaveBeenCalled();
    expect(fillText).not.toHaveBeenCalled();
    expect(outcome.kind).not.toBe("filled");
  });
});

describe("the model reads which questions ask about pay or are declarations (ADR 0041)", () => {
  const classified = (
    entries: Record<
      string,
      { asksAboutPay: boolean; declarationKind: string | null }
    >,
  ) =>
    vi.fn(() =>
      Promise.resolve(
        new Map(
          Object.entries(entries).map(([prompt, value]) => [
            prompt,
            value as {
              asksAboutPay: boolean;
              declarationKind: null | "truthfulness_certification";
            },
          ]),
        ),
      ),
    );

  test("holds a pay question no keyword list would catch while pay stays private", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "What package would make this move worth it for you?",
          required: true,
        }),
      ],
    });
    const fillText = vi.fn();
    const { config } = configFor(page, { hands: { fillText } });
    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "70,000 EUR" },
      observationOf(page).signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        classifyQuestions: classified({
          "What package would make this move worth it for you?": {
            asksAboutPay: true,
            declarationKind: null,
          },
        }),
        checkWrittenAnswer: () =>
          Promise.resolve({ supported: true, reason: "ok" }),
      },
    );
    expect(fillText).not.toHaveBeenCalled();
    expect(outcome.kind).not.toBe("filled");
  });

  test("leaves a declaration the model recognised unticked until the person approves it", async () => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          inputType: "checkbox",
          label: "Everything above is accurate to the best of my knowledge",
          required: true,
        }),
      ],
    });
    const setToggle = vi.fn();
    const { config } = configFor(page, { hands: { setToggle } });
    const outcome = await executeApplyProposal(
      { tool: "set_checkbox", ref: "c0", checked: true },
      observationOf(page).signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        classifyQuestions: classified({
          "Everything above is accurate to the best of my knowledge": {
            asksAboutPay: false,
            declarationKind: "truthfulness_certification",
          },
        }),
      },
    );
    expect(setToggle).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("suggestion");
  });

  test("keeps the keyword check when the model cannot be asked", async () => {
    const page = rawPage({
      controls: [
        rawControl({ index: 0, label: "Expected salary", required: true }),
      ],
    });
    const fillText = vi.fn();
    const { config } = configFor(page, { hands: { fillText } });
    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "60000" },
      observationOf(page).signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        classifyQuestions: () => Promise.reject(new Error("model unavailable")),
        checkWrittenAnswer: () =>
          Promise.resolve({ supported: true, reason: "ok" }),
      },
    );
    expect(fillText).not.toHaveBeenCalled();
    expect(outcome.kind).not.toBe("filled");
  });
});

describe("one-use answers and compatible originals", () => {
  test.each([
    {
      label: "Background-check consent",
      groupLabel: "Required declarations",
      inputType: "checkbox",
      answer: "Yes",
      tool: "set_checkbox",
    },
    {
      label: "Annual salary expectation",
      groupLabel: "Compensation",
      inputType: "number",
      answer: "60000",
      tool: "type",
    },
    {
      label: "Analysis experience",
      groupLabel: "Experience",
      inputType: "number",
      answer: "0",
      tool: "type",
    },
  ])(
    "applies an exact one-job $label answer with global approval off",
    async ({ label, groupLabel, inputType, answer, tool }) => {
      const source = rawPage({
        controls: [
          rawControl({
            index: 0,
            label,
            groupLabel,
            inputType,
            required: true,
          }),
        ],
      });
      const { config, hands } = configFor(source, {
        authority: { salaryDisclosure: "answer_from_profile" },
      });
      config.sources.reusableAnswers = [
        {
          id: "application_once",
          kind: "other",
          label,
          question: `${groupLabel} — ${label}`,
          answer,
          roleFamilies: [],
          proofEntryIds: [],
        },
      ];
      hands.fillText = vi.fn(hands.fillText);
      hands.setToggle = vi.fn(hands.setToggle);
      const outcome = await executeApplyProposal(
        tool === "type"
          ? { tool: "type", ref: "c0", text: answer }
          : { tool: "set_checkbox", ref: "c0", checked: true },
        observationOf(source).signature,
        { config, now, guardState: createApplyGuardState() },
      );
      expect(outcome.kind).toBe("filled");
      expect(
        tool === "type" ? hands.fillText : hands.setToggle,
      ).toHaveBeenCalledOnce();
      const unrelated = await executeApplyProposal(
        { tool: "set_checkbox", ref: "c0", checked: true },
        observationOf(source).signature,
        {
          config: configFor(source).config,
          now,
          guardState: createApplyGuardState(),
        },
      );
      if (tool === "set_checkbox") expect(unrelated.kind).toBe("suggestion");
    },
  );

  test("uses saved expected salary without disclosing current pay", async () => {
    const source = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: "Expected compensation",
          inputType: "number",
          required: true,
        }),
      ],
    });
    const { config } = configFor(source, {
      authority: { salaryDisclosure: "answer_from_profile" },
    });
    config.sources.reusableAnswers = [
      {
        id: "pay",
        kind: "salary_expectation",
        label: "Expected compensation",
        question: "Expected compensation",
        answer: "EUR 60,000 gross per year",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const classifyQuestions = () =>
      Promise.resolve(
        new Map([
          [
            "Expected compensation",
            {
              asksAboutPay: true,
              asksCurrentPay: false,
              declarationKind: null,
              answerTags: {
                kind: "salary" as const,
                country: null,
                sourceId: "answerLibrary.pay",
              },
            },
          ],
        ]),
      );
    const checkWrittenAnswer = vi.fn(() =>
      Promise.resolve({
        supported: true,
        reason: "60000 is the amount of the saved expected annual salary.",
      }),
    );
    const result = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "60000" },
      observationOf(source).signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        classifyQuestions,
        checkWrittenAnswer,
      },
    );
    expect(result.kind).toBe("suggestion");
    expect(checkWrittenAnswer).not.toHaveBeenCalled();
    source.controls[0].label = "Current compensation";
    config.authority.salaryDisclosure = "pause_for_user";
    const current = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "60000" },
      observationOf(source).signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        classifyQuestions: () =>
          Promise.resolve(
            new Map([
              [
                "Current compensation",
                {
                  asksAboutPay: true,
                  asksCurrentPay: true,
                  declarationKind: null,
                },
              ],
            ]),
          ),
        checkWrittenAnswer,
      },
    );
    expect(current.kind).toBe("suggestion");
    expect(checkWrittenAnswer).not.toHaveBeenCalled();
  });

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

test.each([
  "Expected compensation",
  "Current compensation",
  "Previous compensation",
])("keeps %s private even with an exact saved answer", async (label) => {
  const source = rawPage({
    controls: [rawControl({ index: 0, label, required: true })],
  });
  const { config, hands } = configFor(source);
  config.sources.reusableAnswers = [
    {
      id: "saved_pay",
      kind: "other",
      label,
      question: label,
      answer: "60000",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  hands.fillText = vi.fn(hands.fillText);
  const result = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "60000" },
    observationOf(source).signature,
    {
      config,
      now,
      guardState: createApplyGuardState(),
      classifyQuestions: () =>
        Promise.resolve(
          new Map([
            [
              label,
              {
                asksAboutPay: true,
                asksCurrentPay: label !== "Expected compensation",
                declarationKind: null,
                answerTags: {
                  kind: "salary" as const,
                  country: null,
                  sourceId: "answerLibrary.saved_pay",
                },
              },
            ],
          ]),
        ),
    },
  );
  expect(result).toMatchObject({
    kind: "suggestion",
    answer: { value: "60000" },
    question: {
      note: "Job Finder leaves pay questions to you. Answer it yourself if you want to.",
    },
  });
  expect(hands.fillText).not.toHaveBeenCalled();
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

test("a saved generic eligibility answer is checked again for this hiring country", async () => {
  const page = rawPage({
    controls: [
      rawControl({
        index: 0,
        tagName: "select",
        label: "Are you authorized to work here?",
        options: ["Yes", "No"],
        required: true,
      }),
    ],
  });
  const { config, hands } = configFor(page);
  config.sources.posting.location = "Worldwide remote";
  config.application.resultId = "current_result";
  config.sources.reusableAnswers = [
    {
      id: "canadian_answer",
      applicationScope: {
        resultId: "other_result",
        applicationRecordId: "other_application",
        location: "Toronto, Canada",
      },
      kind: "work_authorization",
      label: "Canada authorization",
      question: "Are you authorized to work here?",
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const choose = vi.spyOn(hands, "chooseOption");
  const check = vi.fn(() =>
    Promise.resolve({
      supported: false,
      reason:
        "Which country will hire you? Canadian work rights do not establish worldwide permission.",
    }),
  );
  const outcome = await executeApplyProposal(
    { tool: "select", ref: "c0", option: "Yes" },
    observationOf(page).signature,
    {
      config,
      now,
      guardState: createApplyGuardState(),
      checkWrittenAnswer: check,
      classifyQuestions: () =>
        Promise.resolve(
          new Map([
            [
              "Are you authorized to work here?",
              {
                asksAboutPay: false,
                eligibilityKind: "work_authorization" as const,
                declarationKind: null,
              },
            ],
          ]),
        ),
    },
  );
  expect(check).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
  expect(outcome.kind).toBe("suggestion");
});

test("private current salary is not filled or suggested from expected pay", async () => {
  const page = rawPage({
    controls: [
      rawControl({ index: 0, label: "Current salary", required: true }),
    ],
  });
  const { config, hands } = configFor(page);
  config.sources.reusableAnswers = [
    {
      id: "pay",
      kind: "salary_expectation",
      label: "Expected pay",
      question: "Expected pay",
      answer: "EUR 60000",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const fill = vi.spyOn(hands, "fillText");
  const check = vi.fn(() =>
    Promise.resolve({ supported: true, reason: "checked" }),
  );
  const outcome = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "60000" },
    observationOf(page).signature,
    {
      config,
      now,
      guardState: createApplyGuardState(),
      checkWrittenAnswer: check,
      classifyQuestions: () =>
        Promise.resolve(
          new Map([
            [
              "Current salary",
              {
                asksAboutPay: true,
                asksCurrentPay: true,
                declarationKind: null,
              },
            ],
          ]),
        ),
    },
  );
  expect(fill).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ kind: "suggestion", answer: null });
});

test.each([true, false])(
  "checks eligibility checkboxes even if classified as a routine declaration (checked=%s)",
  async (checked) => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          inputType: "checkbox",
          label: "I certify that I am authorized to work in the hiring country",
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    config.authority.preApprovedAttestationKinds = [
      "truthfulness_certification",
    ];
    const toggle = vi.spyOn(hands, "setToggle");
    const check = vi.fn(() =>
      Promise.resolve({
        supported: false,
        reason: "The hiring country and permit conditions need your review.",
      }),
    );
    const outcome = await executeApplyProposal(
      { tool: "set_checkbox", ref: "c0", checked },
      observationOf(page).signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer: check,
        classifyQuestions: () =>
          Promise.resolve(
            new Map([
              [
                "I certify that I am authorized to work in the hiring country",
                {
                  asksAboutPay: false,
                  eligibilityKind: "work_authorization" as const,
                  declarationKind: "truthfulness_certification" as const,
                },
              ],
            ]),
          ),
      },
    );
    expect(check).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("suggestion");
  },
);

test.each([
  ["Yes", "retained_result", "Worldwide", true],
  ["No", "retained_result", "Worldwide", true],
  ["Yes", "earlier_result", "Worldwide", true],
  ["Yes", "earlier_result", "Different location", false],
] as const)(
  "eligibility choice %s from %s in %s is final=%s",
  async (answer, resultId, location, final) => {
    const page = rawPage({
      controls: [
        rawControl({
          index: 0,
          tagName: "select",
          label: "Are you authorized to work here?",
          options: ["Yes", "No"],
          required: true,
        }),
      ],
    });
    const { config, hands } = configFor(page);
    config.application.resultId = "retained_result";
    config.application.applicationRecordId = "application";
    config.sources.posting.location = "Worldwide";
    config.sources.reusableAnswers = [
      {
        id: "own_answer",
        kind: "work_authorization",
        label: "Are you authorized to work here?",
        question: "Are you authorized to work here?",
        answer,
        roleFamilies: [],
        proofEntryIds: [],
        applicationScope: {
          resultId,
          applicationRecordId: "application",
          location,
        },
      },
    ];
    const check = vi.fn(() =>
      Promise.resolve({
        supported: false,
        reason: "Hiring country is unknown",
      }),
    );
    const choose = vi.spyOn(hands, "chooseOption");
    const outcome = await executeApplyProposal(
      { tool: "select", ref: "c0", option: answer },
      observationOf(page).signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer: check,
      },
    );
    expect(outcome.kind).toBe(final ? "filled" : "suggestion");
    if (final) {
      expect(choose).toHaveBeenCalledWith("c0", answer);
      expect(check).not.toHaveBeenCalled();
    } else {
      expect(choose).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalled();
    }
  },
);

test.each([false, true])(
  "a rejected or unavailable check explains the question (unavailable=%s)",
  async (unavailable) => {
    const page = rawPage({
      controls: [
        rawControl({ index: 0, label: "Why this role?", required: true }),
      ],
    });
    const { config } = configFor(page);
    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: "I led an unsupported project" },
      observationOf(page).signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer: () =>
          unavailable
            ? Promise.reject(new Error("incomplete: max_output_tokens"))
            : Promise.resolve({
                supported: false,
                reason: "That project is not in your resume.",
              }),
      },
    );
    expect(outcome.kind).toBe("suggestion");
    if (outcome.kind === "suggestion") {
      expect(outcome.question?.note).toContain(
        unavailable ? "could not check this answer" : "That project",
      );
      expect(outcome.question?.note).not.toContain("max_output_tokens");
    }
  },
);

test("an optional letter that needs review pauses with its draft and reason", async () => {
  const page = rawPage({
    controls: [
      rawControl({ index: 0, label: "Cover letter", tagName: "textarea" }),
    ],
  });
  const { config, hands } = configFor(page);
  config.writing = {
    coverLetterPolicy: "when_possible",
    writtenAnswerLength: "short",
    preApprovedDeclarations: [],
  };
  config.letters = {
    preference: {
      tone: "direct",
      length: "short",
      language: null,
      sample: null,
    },
    provide: () =>
      Promise.resolve({
        ok: false,
        reason: "Agree how to handle the location mismatch before sending.",
        draftText: "Please accommodate my location.",
      }),
  };
  const write = vi.spyOn(hands, "fillText");
  const outcome = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "Letter" },
    observationOf(page).signature,
    { config, now, guardState: createApplyGuardState() },
  );
  expect(outcome.kind).toBe("paused");
  if (outcome.kind === "paused") {
    expect(outcome.pause.reviewDraft?.text).toBe(
      "Please accommodate my location.",
    );
    expect(outcome.pause.reviewDraft?.reason).toContain("location mismatch");
  }
  expect(write).not.toHaveBeenCalled();
});

test("Prepare again uses all four of this application's answers over different model proposals", async () => {
  const fields = [
    { label: "Years of analysis experience", answer: "4", proposed: "0" },
    { label: "Expected salary", answer: "62000", proposed: "50000" },
    {
      label: "Are you willing to relocate?",
      answer: "No",
      proposed: "Yes",
      tagName: "select",
      options: ["Yes", "No"],
    },
    {
      label: "Do you require visa sponsorship?",
      answer: "Yes",
      proposed: "No",
      tagName: "select",
      options: ["Yes", "No"],
    },
  ];
  const page = rawPage({
    controls: fields.map((field, index) =>
      rawControl({
        index,
        label: field.label,
        tagName: field.tagName ?? "input",
        options: field.options ?? [],
        required: true,
      }),
    ),
  });
  const { config, hands } = configFor(page);
  config.application.applicationRecordId = "application_same";
  config.sources.reusableAnswers = fields.map((field, index) => ({
    id: `application_once_${index}`,
    kind: "other",
    label: field.label,
    question: field.label,
    answer: field.answer,
    roleFamilies: [],
    proofEntryIds: [],
    applicationScope: {
      applicationRecordId: "application_same",
      resultId: "previous",
      location: null,
    },
  }));
  const fill = vi.spyOn(hands, "fillText");
  const select = vi.spyOn(hands, "chooseOption");
  const checkWrittenAnswer = vi.fn(() =>
    Promise.resolve({ supported: false, reason: "No profile fact." }),
  );
  for (const [index, field] of fields.entries()) {
    const outcome = await executeApplyProposal(
      field.options
        ? { tool: "select", ref: `c${index}`, option: field.proposed }
        : { tool: "type", ref: `c${index}`, text: field.proposed },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState(), checkWrittenAnswer },
    );
    expect(outcome.kind).toBe("filled");
    expect(field.options ? select : fill).toHaveBeenLastCalledWith(
      `c${index}`,
      field.answer,
    );
  }
  expect(checkWrittenAnswer).not.toHaveBeenCalled();
  const other = configFor(page).config;
  other.application.applicationRecordId = "application_other";
  other.sources.reusableAnswers = config.sources.reusableAnswers;
  // Even if supplied, one-time answers belong only to the original application.
  for (const [index, field] of fields.entries()) {
    const outcome = await executeApplyProposal(
      field.options
        ? { tool: "select", ref: `c${index}`, option: field.proposed }
        : { tool: "type", ref: `c${index}`, text: field.proposed },
      observationOf(page).signature,
      {
        config: other,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer,
      },
    );
    expect(outcome.kind).toBe("suggestion");
  }
});

test("Prepare again uses the person's No for a checkbox and the saved sibling radio", async () => {
  const page = rawPage({
    controls: [
      rawControl({
        index: 0,
        inputType: "checkbox",
        label: "I agree to a background check",
        required: true,
      }),
      rawControl({
        index: 1,
        inputType: "radio",
        name: "relocation",
        groupLabel: "Willing to relocate",
        label: "Yes",
        value: "yes",
      }),
      rawControl({
        index: 2,
        inputType: "radio",
        name: "relocation",
        groupLabel: "Willing to relocate",
        label: "No",
        value: "no",
      }),
    ],
  });
  const { config, hands } = configFor(page);
  config.sources.reusableAnswers = [
    {
      id: "application_once_check",
      kind: "other",
      label: "I agree to a background check",
      question: "I agree to a background check",
      answer: "No",
      roleFamilies: [],
      proofEntryIds: [],
    },
    {
      id: "application_once_relocate",
      kind: "other",
      label: "Willing to relocate",
      question: "Willing to relocate",
      answer: "No",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const toggle = vi.spyOn(hands, "setToggle");
  for (const ref of ["c0", "c1"]) {
    const outcome = await executeApplyProposal(
      { tool: "set_checkbox", ref, checked: true },
      observationOf(page).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(outcome.kind).toBe("filled");
  }
  expect(toggle.mock.calls).toEqual([
    ["c0", false],
    ["c2", true],
  ]);
});

test("conflicting hours produce review wording and never enter it before the person's decision", async () => {
  const page = rawPage({
    controls: [
      rawControl({
        index: 0,
        tagName: "textarea",
        label: "Why this role?",
        required: true,
      }),
    ],
  });
  const { config, hands } = configFor(page);
  const fill = vi.spyOn(hands, "fillText");
  const observation = observationOf(page);
  const wording =
    "I can work 20–30 hours per week from Toronto. Can this role support those hours and location?";
  const outcome = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "I am available full-time in Boston." },
    observation.signature,
    {
      config,
      now,
      guardState: createApplyGuardState(),
      checkWrittenAnswer: () =>
        Promise.resolve({
          supported: false,
          reason: "This job's hours and location conflict with your limits.",
          reviewWording: wording,
        }),
    },
  );
  expect(fill).not.toHaveBeenCalled();
  expect(outcome.kind).toBe("suggestion");
  if (outcome.kind === "suggestion")
    expect(outcome.question?.suggestedAnswers[0]).toMatchObject({
      text: wording,
      sourceKind: "prior_answer",
      sourceId: "review.c0",
    });
});

test("uncertain eligibility shows the posting and permit facts beside the question", async () => {
  const page = rawPage({
    controls: [
      rawControl({
        index: 0,
        tagName: "select",
        label: "Are you authorized to work here?",
        required: true,
        options: ["Yes", "No"],
      }),
    ],
  });
  const { config, hands } = configFor(page);
  config.sources.posting.location = "Berlin, Germany";
  config.sources.profile.workEligibility.limitedWorkPermissions = [
    {
      country: "Germany",
      conditions: "20 hours during term",
      requiresFutureSponsorship: true,
    },
  ];
  const select = vi.spyOn(hands, "chooseOption");
  const observation = observationOf(page);
  const outcome = await executeApplyProposal(
    { tool: "select", ref: "c0", option: "No" },
    observation.signature,
    {
      config,
      now,
      guardState: createApplyGuardState(),
      checkWrittenAnswer: () =>
        Promise.resolve({
          supported: false,
          reason: "Germany's student permit may not cover this full-time job.",
        }),
    },
  );
  expect(select).not.toHaveBeenCalled();
  expect(outcome.kind).toBe("suggestion");
  if (outcome.kind === "suggestion") {
    expect(outcome.question?.note).toContain("Berlin, Germany");
    expect(outcome.question?.note).toContain("20 hours during term");
    expect(outcome.question?.note).toContain("sponsorship needed later");
  }
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
        : { tool: "type", ref: "c0", text: "wrong model text" },
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

test("an answer reused from another question names the saved answer it came from", async () => {
  const page = rawPage({
    controls: [
      rawControl({
        index: 0,
        label: "Why would you like this role?",
        required: true,
      }),
    ],
  });
  const { config } = configFor(page);
  config.sources.reusableAnswers = [
    {
      id: "saved_motivation",
      label: "Platform work motivation",
      question: "Why platform engineering?",
      answer: "I enjoy building dependable platforms.",
      kind: "other",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const outcome = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "I enjoy building dependable platforms." },
    observationOf(page).signature,
    { config, now, guardState: createApplyGuardState() },
  );
  expect(outcome.kind).toBe("filled");
  if (outcome.kind === "filled")
    expect(outcome.filled.answer.provenanceLabel).toBe(
      'your saved answer "Platform work motivation"',
    );
});

test("the model's hiring-country question cannot copy residence without a check", async () => {
  const page = rawPage({
    controls: [
      rawControl({
        index: 0,
        tagName: "select",
        label: "Where would you be employed?",
        options: ["United Kingdom", "Canada"],
        required: true,
      }),
    ],
  });
  const { config, hands } = configFor(page);
  config.sources.profile.currentCountry = "United Kingdom";
  const choose = vi.spyOn(hands, "chooseOption");
  const check = vi.fn(() =>
    Promise.resolve({
      supported: false,
      reason: "Confirm which country will employ you for this role.",
    }),
  );
  const outcome = await executeApplyProposal(
    {
      tool: "select",
      ref: "c0",
      option: "United Kingdom",
      storedFactId: "profile.currentCountry",
    },
    observationOf(page).signature,
    {
      config,
      now,
      guardState: createApplyGuardState(),
      checkWrittenAnswer: check,
      classifyQuestions: () =>
        Promise.resolve(
          new Map([
            [
              "Where would you be employed?",
              {
                asksAboutPay: false,
                asksHiringCountry: true,
                declarationKind: null,
              },
            ],
          ]),
        ),
    },
  );
  expect(check).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
  expect(outcome.kind).toBe("suggestion");
});

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

describe("an unconfirmed short value is offered back to the person", () => {
  test.each([
    {
      label: "Preferred start date",
      inputType: "date",
      value: "2026-11-20",
      offered: false,
    },
    {
      label: "Why do you want this job?",
      inputType: "text",
      value: "I have led three platform migrations at scale.",
      offered: false,
    },
    {
      label: "Are you legally authorized to work in this country?",
      inputType: "text",
      value: "Yes",
      offered: false,
    },
  ])("$label", async ({ label, inputType, value, offered }) => {
    const page = rawPage({
      controls: [rawControl({ index: 0, label, inputType, required: true })],
    });
    const { config, hands } = configFor(page);
    const fillText = vi.spyOn(hands, "fillText");
    const observation = observationOf(page);
    const outcome = await executeApplyProposal(
      { tool: "type", ref: "c0", text: value },
      observation.signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer: () =>
          Promise.resolve({
            supported: false,
            reason: "Your facts give a 30-day notice period, not a date.",
          }),
      },
    );
    expect(fillText).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("suggestion");
    if (outcome.kind !== "suggestion") return;
    const suggested = outcome.question?.suggestedAnswers.map(
      (answer) => answer.text,
    );
    if (offered) expect(suggested).toEqual([value]);
    else expect(suggested ?? []).not.toContain(value);
  });
});

test.each(githubReplay.fields)(
  "GitHub replay: $label gets the field's requested format",
  async (field) => {
    const source = rawPage({
      controls: [
        rawControl({
          index: 0,
          label: field.label,
          placeholder: field.placeholder,
          hint: field.hint,
          required: true,
        }),
      ],
    });
    const { config } = configFor(source);
    config.sources.profile.githubUrl = githubReplay.url;
    const result = await executeApplyProposal(
      {
        tool: "type",
        ref: "c0",
        text: githubReplay.url,
        storedFactId: "profile.githubUrl",
      },
      observationOf(source).signature,
      { config, now, guardState: createApplyGuardState() },
    );
    expect(result.kind).toBe("filled");
    expect(source.controls[0].value).toBe(field.expected);
  },
);

test("GitHub replay: a repository address gives its owner to a username field", async () => {
  const source = rawPage({
    controls: [
      rawControl({ index: 0, label: "GitHub username", required: true }),
    ],
  });
  const { config } = configFor(source);
  config.sources.profile.githubUrl = githubReplay.repositoryUrl;
  const result = await executeApplyProposal(
    {
      tool: "type",
      ref: "c0",
      text: githubReplay.repositoryUrl,
      storedFactId: "profile.githubUrl",
    },
    observationOf(source).signature,
    { config, now, guardState: createApplyGuardState() },
  );
  expect(result.kind).toBe("filled");
  expect(source.controls[0].value).toBe(githubReplay.username);
});

test("GitHub replay: the username fact is no answer to a field that wants the address", async () => {
  const source = rawPage({
    controls: [rawControl({ index: 0, label: "GitHub URL", required: true })],
  });
  const { config, hands } = configFor(source);
  config.sources.profile.githubUrl = githubReplay.url;
  const fillText = vi.spyOn(hands, "fillText");
  const result = await executeApplyProposal(
    {
      tool: "type",
      ref: "c0",
      text: githubReplay.username,
      storedFactId: "profile.githubUrl#username",
    },
    observationOf(source).signature,
    { config, now, guardState: createApplyGuardState() },
  );
  expect(result.kind).not.toBe("filled");
  expect(fillText).not.toHaveBeenCalled();
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

  test("the handover lists the form's own choices and a refused choice is not tried again", async () => {
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
    expect(first.kind).toBe("suggestion");
    if (first.kind === "suggestion")
      expect(first.question?.answerOptions).toEqual(pickerReplay.options);
    const second = await propose();
    expect(second.kind).toBe("suggestion");
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

  test("refusals from earlier runs hold: after two, only the person's answer is tried", async () => {
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
          checkWrittenAnswer: () =>
            Promise.resolve({ supported: true, reason: "Plausible." }),
        },
      );
    // Without that history the same checked choice would be tried.
    expect((await invent(createApplyGuardState())).kind).toBe("filled");
    expect(chooseOption).toHaveBeenCalledTimes(1);
    chooseOption.mockClear();
    expect((await invent(createApplyGuardState(earlier))).kind).toBe(
      "suggestion",
    );
    expect(chooseOption).not.toHaveBeenCalled();

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

describe("typed answer permissions", () => {
  test.each(typedReplay.workday.questions)(
    "Workday reuses the explicit UK profile for $kind without a checker or a second question",
    async (row) => {
      const page = rawPage({
        controls: [
          rawControl({
            index: 0,
            tagName: "select",
            label: row.label,
            groupLabel: typedReplay.workday.group,
            required: true,
            options: ["Yes", "No"],
          }),
        ],
      });
      const { config, hands } = configFor(page);
      config.sources.posting.location = typedReplay.workday.location;
      config.sources.profile.workEligibility.authorizedWorkCountries =
        typedReplay.workday.authorizedWorkCountries;
      config.sources.profile.workEligibility.requiresVisaSponsorship = false;
      const choose = vi.spyOn(hands, "chooseOption");
      const check = vi
        .fn()
        .mockResolvedValue({ supported: true, reason: "lying checker" });
      const catalog = answerSourceCatalog(config.sources);
      const source = catalog.find((source) => source.purpose === row.kind)!;
      const prompt = `${typedReplay.workday.group} — ${row.label}`;
      const reading = {
        asksAboutPay: false,
        declarationKind: null,
        eligibilityKind:
          row.kind === "work_auth"
            ? ("work_authorization" as const)
            : ("visa_sponsorship" as const),
        answerTags: {
          kind: row.kind as ApplyAnswerTags["kind"],
          country: "GB",
          sourceId: source.id,
        },
      };
      const outcome = await executeApplyProposal(
        { tool: "select", ref: "c0", option: row.answer },
        observationOf(page).signature,
        {
          config,
          now,
          guardState: createApplyGuardState(),
          checkWrittenAnswer: check,
          classifyQuestions: () =>
            Promise.resolve(new Map([[prompt, reading]])),
        },
      );
      expect(outcome.kind).toBe("filled");
      expect(choose).toHaveBeenCalledWith("c0", row.answer);
      expect(check).not.toHaveBeenCalled();
    },
  );
  test.each(typedReplay.gated)(
    "$kind: $question is refused even with a lying checker and a similarly valued source",
    async (row) => {
      for (const sourceId of [
        null,
        "profile.currentCountry",
        "profile.skills.0",
        "missing",
      ]) {
        const page = rawPage({
          controls: [
            rawControl({ index: 0, label: row.question, required: true }),
          ],
        });
        const { config, hands } = configFor(page);
        config.sources.profile.currentCountry = "Kosovo";
        config.sources.profile.skills = ["Playwright"];
        const fill = vi.spyOn(hands, "fillText");
        const check = vi
          .fn()
          .mockResolvedValue({ supported: true, reason: "lying checker" });
        const outcome = await executeApplyProposal(
          {
            tool: "type",
            ref: "c0",
            text:
              sourceId === "profile.currentCountry" ? "Kosovo" : "Playwright",
          },
          observationOf(page).signature,
          {
            config,
            now,
            guardState: createApplyGuardState(),
            checkWrittenAnswer: check,
            classifyQuestions: () =>
              Promise.resolve(
                new Map([
                  [
                    row.question,
                    {
                      asksAboutPay: false,
                      declarationKind: null,
                      answerTags: {
                        kind: row.kind as ApplyAnswerTags["kind"],
                        country: null,
                        sourceId,
                      },
                    },
                  ],
                ]),
              ),
          },
        );
        expect(outcome.kind).toBe("suggestion");
        expect(fill).not.toHaveBeenCalled();
        expect(check).not.toHaveBeenCalled();
      }
    },
  );
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
