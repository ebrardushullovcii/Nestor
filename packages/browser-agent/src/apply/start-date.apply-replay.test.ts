import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { classifyAnswerPermission } from "./answer-source-catalog";
import { createApplyGuardState, executeApplyProposal } from "./policy-executor";
import {
  hasStartDateValue,
  relativeStartDate,
  startDateAnswer,
} from "./start-date";
import type {
  ApplyAgentConfig,
  ApplyFormControl,
  ApplyFormObservation,
  ApplyPageHands,
} from "./types";

const now = () => new Date(2026, 10, 15, 8);
const question = "When could you start?";
function fixture(answer = "Immediately", current = "", saved = true) {
  const control: ApplyFormControl = {
    ref: "start",
    kind: "date",
    dateInputType: "date",
    label: question,
    groupLabel: "",
    placeholder: "Pick date...",
    required: true,
    disabled: false,
    readOnly: false,
    visible: true,
    value: current,
    checked: false,
    options: [],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: "availability",
    answerControlType: "date",
    attestationKind: null,
    answered: !!current,
  };
  const observation: ApplyFormObservation = {
    signature: "synthetic",
    url: "https://apply.example.test/form",
    origin: "https://apply.example.test",
    title: "Application",
    observedAt: now().toISOString(),
    bodyTextExcerpt: question,
    controls: [control],
    actions: [],
    links: [],
    clickables: [],
    headings: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    blocker: null,
    step: { label: null, index: null, total: null },
  };
  const fillText = vi.fn((_ref: string, value: string) => {
    control.value = value;
    return Promise.resolve({ ok: true as const, observedValue: value });
  });
  const unexpected = () => Promise.reject(new Error("Unexpected page action"));
  const hands: ApplyPageHands = {
    fillText,
    observe: () => Promise.resolve(observation),
    readText: () => Promise.resolve(question),
    wait: () => Promise.resolve(),
    navigate: unexpected,
    goBack: unexpected,
    followLink: unexpected,
    chooseOption: unexpected,
    setToggle: unexpected,
    clickElement: unexpected,
    clickAction: unexpected,
    uploadFile: unexpected,
    scroll: unexpected,
  };
  const config: ApplyAgentConfig = {
    hands,
    siteLabel: "Synthetic employer",
    application: {
      jobId: "1",
      applicationId: "1",
      startingUrl: observation.url!,
    },
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        fullName: "Synthetic Applicant",
        yearsExperience: 1,
        baseResume: {
          id: "resume",
          fileName: "synthetic.pdf",
          uploadedAt: now().toISOString(),
        },
      }),
      resumeText: null,
      documents: [],
      posting: {
        title: "Engineer",
        company: "Synthetic",
        location: "Remote",
        description: "",
      },
      reusableAnswers: saved
        ? [
            {
              id: "available",
              kind: "availability",
              label: question,
              question,
              answer,
              roleFamilies: [],
              proofEntryIds: [],
            },
          ]
        : [],
    },
  };
  const tags = {
    kind: "other",
    sourceId: saved
      ? "answerLibrary.available"
      : "profile.workEligibility.noticePeriodDays",
    country: null,
  } as const;
  const deps = {
    config,
    now,
    guardState: createApplyGuardState(),
    classifyQuestions: () =>
      Promise.resolve(
        new Map([
          [
            question,
            { asksAboutPay: false, declarationKind: null, answerTags: tags },
          ],
        ]),
      ),
  };
  return { config, control, observation, fillText, tags, deps };
}

test.each([
  ["Immediately", "2026-11-15"],
  ["in two weeks", "2026-11-29"],
  ["30 days", "2026-12-15"],
])(
  "a saved %s becomes a real start date and survives continuation",
  async (answer, date) => {
    const f = fixture(answer);
    const run = () =>
      executeApplyProposal(
        { tool: "type", ref: "start", text: answer },
        f.observation.signature,
        f.deps,
      );
    expect(await run()).toMatchObject({
      kind: "filled",
      filled: { answer: { value: date, sourceKind: "answer_library" } },
    });
    expect(f.fillText).toHaveBeenCalledExactlyOnceWith("start", date);
    expect(await run()).toMatchObject({
      kind: "filled",
      filled: { answer: { value: date } },
    });
    expect(f.fillText).toHaveBeenCalledTimes(1);
    expect(
      classifyAnswerPermission({
        control: f.control,
        controls: [f.control],
        tags: f.tags,
        sources: f.config.sources,
        answer: date,
        pageInstructions: "",
        now: now(),
      }).kind,
    ).toBe("literal");
    expect(
      classifyAnswerPermission({
        control: f.control,
        controls: [f.control],
        tags: f.tags,
        sources: f.config.sources,
        answer: answer,
        pageInstructions: "",
        now: now(),
      }).kind,
    ).toBe("needs_you");
  },
);

test("a person-picked date is not replaced by Immediately on continue", async () => {
  const f = fixture("Immediately", "11/15/2026");
  expect(
    await executeApplyProposal(
      { tool: "type", ref: "start", text: "Immediately" },
      f.observation.signature,
      f.deps,
    ),
  ).toMatchObject({
    kind: "filled",
    filled: { answer: { value: "11/15/2026" } },
  });
  expect(f.fillText).not.toHaveBeenCalled();
});

test("a different valid date is preserved, but not invented as evidence", async () => {
  const f = fixture("Immediately", "2026-12-01");
  expect(
    (
      await executeApplyProposal(
        { tool: "type", ref: "start", text: "Immediately" },
        f.observation.signature,
        f.deps,
      )
    ).kind,
  ).toBe("suggestion");
  expect(f.control.value).toBe("2026-12-01");
  expect(f.fillText).not.toHaveBeenCalled();
});

test("a recorded notice period supplies the date; missing or vague availability does not", async () => {
  const f = fixture("", "", false);
  f.config.sources.profile.workEligibility.noticePeriodDays = 14;
  expect(
    await executeApplyProposal(
      { tool: "type", ref: "start", text: "Immediately" },
      f.observation.signature,
      f.deps,
    ),
  ).toMatchObject({
    kind: "filled",
    filled: { answer: { value: "2026-11-29" } },
  });
  const unknown = fixture("after we discuss the offer");
  expect(
    (
      await executeApplyProposal(
        { tool: "type", ref: "start", text: "Immediately" },
        unknown.observation.signature,
        unknown.deps,
      )
    ).kind,
  ).toBe("suggestion");
  expect(unknown.fillText).not.toHaveBeenCalled();
});

test("calendar arithmetic crosses daylight saving, leap days and years", () => {
  expect(relativeStartDate("in two weeks", new Date(2026, 9, 20, 8))).toBe(
    "2026-11-03",
  );
  expect(relativeStartDate("1 day", new Date(2028, 1, 28, 8))).toBe(
    "2028-02-29",
  );
  expect(relativeStartDate("in two weeks", new Date(2026, 11, 25, 8))).toBe(
    "2027-01-08",
  );
});

test("a past date already in the resumed field is replaced by today plus notice", async () => {
  const f = fixture("", "2026-11-01", false);
  f.config.sources.profile.workEligibility.availableStartDate = "2026-11-01";
  f.config.sources.profile.workEligibility.noticePeriodDays = 14;
  expect(
    await executeApplyProposal(
      { tool: "type", ref: "start", text: "2026-11-01" },
      f.observation.signature,
      f.deps,
    ),
  ).toMatchObject({
    kind: "filled",
    filled: { answer: { value: "2026-11-29" } },
  });
  expect(f.fillText).toHaveBeenCalledExactlyOnceWith("start", "2026-11-29");
});

test("stale saved answers and profile dates cannot defeat usable notice", () => {
  const f = fixture("2026-11-01");
  f.config.sources.profile.workEligibility.availableStartDate = "2026-11-02";
  f.config.sources.profile.workEligibility.noticePeriodDays = 14;
  expect(
    startDateAnswer(f.control, f.config.sources, [f.control], now()),
  ).toEqual({
    id: "profile.workEligibility.noticePeriodDays",
    value: "2026-11-29",
  });
  f.config.sources.profile.workEligibility.noticePeriodDays = null;
  expect(
    startDateAnswer(f.control, f.config.sources, [f.control], now()),
  ).toBeNull();
  expect(
    classifyAnswerPermission({
      control: f.control,
      controls: [f.control],
      tags: f.tags,
      sources: f.config.sources,
      answer: "2026-11-01",
      pageInstructions: "",
      now: now(),
    }).kind,
  ).toBe("needs_you");
});

test("a future profile date wins over a saved relative notice answer", () => {
  const f = fixture("two weeks");
  f.config.sources.profile.workEligibility.availableStartDate = "2026-12-20";
  expect(
    startDateAnswer(f.control, f.config.sources, [f.control], now())?.value,
  ).toBe("2026-12-20");
});

test("a stale date's source tag cannot veto the calculated notice-period replacement", async () => {
  const f = fixture("", "2026-11-01", false);
  f.config.sources.profile.workEligibility.availableStartDate = "2026-11-01";
  f.config.sources.profile.workEligibility.noticePeriodDays = 14;
  const deps = {
    ...f.deps,
    classifyQuestions: () =>
      Promise.resolve(
        new Map([
          [
            question,
            {
              asksAboutPay: false,
              declarationKind: null,
              answerTags: {
                ...f.tags,
                sourceId: "profile.workEligibility.availableStartDate",
              },
            },
          ],
        ]),
      ),
  };
  expect(
    await executeApplyProposal(
      { tool: "type", ref: "start", text: "2026-11-01" },
      f.observation.signature,
      deps,
    ),
  ).toMatchObject({
    kind: "filled",
    filled: { answer: { value: "2026-11-29" } },
  });
});

test.each(["Available now", "Immediately"])(
  "explicit %s uses today; a future saved date wins over notice",
  (answer) => {
    const f = fixture(answer);
    f.config.sources.profile.workEligibility.noticePeriodDays = 14;
    expect(
      startDateAnswer(f.control, f.config.sources, [f.control], now())?.value,
    ).toBe("2026-11-15");
    f.config.sources.reusableAnswers = [];
    f.config.sources.profile.workEligibility.availableStartDate = "2026-12-20";
    expect(
      startDateAnswer(f.control, f.config.sources, [f.control], now())?.value,
    ).toBe("2026-12-20");
  },
);

test("today and notice use the person's calendar day across time zones", () => {
  const f = fixture("Immediately");
  f.config.sources.profile.timeZone = "Pacific/Kiritimati";
  const instant = new Date("2026-11-15T12:30:00Z");
  expect(
    startDateAnswer(f.control, f.config.sources, [f.control], instant)?.value,
  ).toBe("2026-11-16");
  f.control.value = "2026-11-15";
  expect(hasStartDateValue(f.control, instant, f.config.sources.profile)).toBe(
    false,
  );
  f.config.sources.reusableAnswers = [];
  f.config.sources.profile.workEligibility.noticePeriodDays = 14;
  expect(
    startDateAnswer(f.control, f.config.sources, [f.control], instant)?.value,
  ).toBe("2026-11-30");
  f.config.sources.profile.timeZone = "America/Los_Angeles";
  expect(
    startDateAnswer(
      f.control,
      f.config.sources,
      [f.control],
      new Date("2026-11-15T01:00:00Z"),
    )?.value,
  ).toBe("2026-11-28");
});

test.each([
  ["DD/MM/YYYY", "16/11/2026"],
  ["MM-DD-YYYY", "11-16-2026"],
])(
  "a text date uses the form's %s format and the same permission check",
  (format, answer) => {
    const f = fixture("Immediately");
    f.control.kind = "text";
    delete f.control.dateInputType;
    f.control.placeholder = format;
    f.config.sources.profile.timeZone = "Pacific/Kiritimati";
    const instant = new Date("2026-11-15T12:30:00Z");
    expect(
      startDateAnswer(f.control, f.config.sources, [f.control], instant)?.value,
    ).toBe(answer);
    expect(
      classifyAnswerPermission({
        control: f.control,
        controls: [f.control],
        tags: f.tags,
        sources: f.config.sources,
        answer,
        pageInstructions: "",
        now: instant,
      }).kind,
    ).toBe("literal");
  },
);
