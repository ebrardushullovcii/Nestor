import {
  CandidateProfileSchema,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createApplySystemPrompt } from "./apply-prompts";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import { createApplyGuardState, executeApplyProposal } from "./policy-executor";
import type { ApplyAgentConfig, ApplyPageHands } from "./types";
function nameControl(): RawApplyControl {
  return {
    index: 0,
    tagName: "input",
    inputType: "text",
    role: "",
    id: "f0",
    name: "f0",
    label: "Full name",
    groupLabel: "",
    placeholder: "",
    autocomplete: "",
    required: true,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value: "Robin Ashford",
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
  };
}

function page(overrides: Partial<RawApplyPage> = {}): RawApplyPage {
  return {
    url: "https://apply.example.test/form",
    title: "Apply",
    bodyText: "Apply for the role",
    controls: [nameControl()],
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
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

function hands(source: RawApplyPage): ApplyPageHands {
  return {
    observe: () =>
      Promise.resolve(
        buildApplyFormObservation(source, "2026-09-14T10:00:00.000Z"),
      ),
    navigate: () =>
      Promise.resolve({ ok: true, url: "https://apply.example.test/form" }),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    goBack: () =>
      Promise.resolve({ ok: true, url: "https://apply.example.test/form" }),
    readText: () => Promise.resolve("Apply for the role"),
    fillText: (ref, value) => {
      const control = source.controls.find(
        (entry) => (entry.ref ?? `c${entry.index}`) === ref,
      );
      if (!control)
        return Promise.resolve({
          ok: false,
          error: "Stale control; observe again.",
        });
      if (control) control.value = value;
      return Promise.resolve({ ok: true, observedValue: value });
    },
    chooseOption: (_ref, option) =>
      Promise.resolve({ ok: true, observedValue: option }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () =>
      Promise.resolve({ ok: true, url: "https://apply.example.test/form" }),
  };
}

function config(
  source: RawApplyPage,
  overrides: Partial<ApplyAgentConfig> = {},
): ApplyAgentConfig {
  return {
    hands: hands(source),
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "candidate_test",
        firstName: "Robin",
        lastName: "Ashford",
        fullName: "Robin Ashford",
        headline: "Platform engineer",
        summary: "Builds dependable internal tools.",
        currentLocation: "Manchester",
        workEligibility: {
          authorizedWorkCountries: ["United Kingdom", "Germany"],
        },
        yearsExperience: 8,
        baseResume: {
          id: "resume_test",
          fileName: "resume.txt",
          uploadedAt: "2026-09-01T09:00:00.000Z",
          textContent: "8 years of platform engineering.",
          textUpdatedAt: "2026-09-01T09:00:00.000Z",
          extractionStatus: "ready",
        },
      }),
      resumeText: null,
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
    now: () => new Date("2026-09-14T10:00:00.000Z"),
    // Most of these tests walk a form step by step, which only Send for me
    // does; Fill in for me's own tests turn this off.
    intermediateWritesAuthorized: true,
    ...overrides,
  };
}

function model(
  calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>,
): LLMClient {
  let index = 0;
  return {
    chatWithTools: vi.fn(async () => {
      await Promise.resolve();
      const call = calls[index++];
      if (!call) throw new Error("Unexpected model turn");
      return {
        content: "",
        toolCalls: [
          {
            id: call.id ?? `call_${index}`,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      };
    }),
  };
}
const done = { name: "finish", args: { reason: "Finished", forPerson: [] } };

test("a failed mailbox attempt hands off its kept form, with no saved-answer question", async () => {
  const formUrl = "https://apply.example.test/verify";
  const source = page({
    url: "https://mail.google.com/mail/u/0/",
    controls: [],
    tabs: [
      {
        id: "form",
        url: formUrl,
        title: "Verify email",
        active: false,
        primary: true,
      },
      {
        id: "tab1",
        url: "https://mail.google.com/mail/u/0/",
        title: "Inbox",
        active: true,
        primary: false,
      },
    ],
  });
  const input = config(source);
  input.hands.closeAuxiliaryTabs = () => {
    source.url = formUrl;
    source.tabs = [
      {
        id: "form",
        url: formUrl,
        title: "Verify email",
        active: true,
        primary: true,
      },
    ];
    return Promise.resolve();
  };
  const result = await runApplyAgent(
    input,
    model([
      {
        name: "finish",
        args: {
          reason: "The mailbox attempt could not retrieve the emailed code.",
          needsPerson: true,
          forPerson: [
            {
              onPage: "mfa",
              instructions:
                "Enter the emailed code on this open application form.",
            },
          ],
        },
      },
    ]),
  );
  expect(result.finalUrl).toBe(formUrl);
  expect(result.pauses[0]?.blocker?.code).toBe("multi_factor_required");
  expect(result.pauses[0]?.question).toBeNull();
});

test.each(["type", "fill_fields"])(
  "%s enters an emailed code without retaining it as an answer",
  async (tool) => {
    const secret = randomBytes(5).toString("hex");
    const source = page({
      controls: [
        {
          ...nameControl(),
          autocomplete: "one-time-code",
          label: "Verification code",
          value: "",
        },
      ],
    });
    const input = config(source);
    const write = { tool: "type", ref: "c0", text: secret };
    const result = await runApplyAgent(
      input,
      model([
        { name: tool, args: tool === "type" ? write : { fields: [write] } },
        done,
      ]),
    );
    expect(source.controls[0]?.value === secret).toBe(true);
    expect(result.filled).toEqual([]);
    expect(result.reviewFilled).toEqual([]);
    expect(JSON.stringify(result).includes(secret)).toBe(false);
  },
);

test.each([
  "prepare_only",
  "confirm_before_submit",
  "autonomous_submit",
] as const)(
  "%s receives mailbox facts, required agreement instructions and the vault account tool",
  async (mode) => {
    const input = config(page());
    input.authority.mode = mode;
    input.authority.preApprovedAttestationKinds = ["terms_acceptance"];
    input.hands.readMailboxAccounts = () =>
      Promise.resolve([
        {
          email: "synthetic@example.test",
          url: "https://mail.google.com/mail/u/0/",
        },
      ]);
    const client = model([done]);
    await runApplyAgent(input, client);
    const prompt = createApplySystemPrompt(input);
    for (const removed of [
      "You work in one tab",
      "This does not permit accepting a legal declaration",
      "If the banner offers only opt-in, leave it for the person",
      "If this job conflicts, ask how the person wants to handle that conflict",
    ])
      expect(prompt).not.toContain(removed);
    expect(prompt).toContain("including arbitration");
    const call = vi.mocked(client.chatWithTools).mock.calls[0];
    expect(JSON.stringify(call[0])).toContain("synthetic@example.test");
    expect(JSON.stringify(call[0])).toContain("are signed in in this browser");
    expect(call[1].map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining([
        "open_tab",
        "switch_tab",
        "close_tab",
        "generate_account_login",
      ]),
    );
  },
);
test.each(["prepare_only", "autonomous_submit"] as const)(
  "%s receives the real instruction and both labelled resume documents",
  async (mode) => {
    const input = config(page());
    input.authority.mode = mode;
    input.sources.preferences = {
      approvalMode: "review_before_submit",
      humanReviewRequired: true,
    } as unknown as NonNullable<ApplyAgentConfig["sources"]["preferences"]>;
    input.sources.resumeText =
      "Selected tailored resume: Optimizely and A/B testing.";
    const client = model([done]);
    await runApplyAgent(input, client);
    const prompt = JSON.stringify(
      vi.mocked(client.chatWithTools).mock.calls[0][0],
    );
    expect(prompt).not.toContain("approvalMode");
    expect(prompt).not.toContain("humanReviewRequired");
    expect(prompt).toContain(mode);
    expect(prompt).toContain("Original imported resume");
    expect(prompt).toContain("8 years of platform engineering");
    expect(prompt).toContain("Selected resume being sent");
    expect(prompt).toContain("Optimizely and A/B testing");
  },
);

test("a stale planned ref names every unattempted batch entry and leaves them untouched", async () => {
  const source = page({
    controls: [0, 1, 2].map((index) => ({
      ...nameControl(),
      index,
      value: "",
    })),
  });
  const input = config(source);
  const write = input.hands.fillText;
  input.hands.fillText = async (ref, value) => {
    const result = await write(ref, value);
    source.controls = source.controls.filter((entry) => entry.index !== 1);
    return result;
  };
  const client = model([
    {
      name: "fill_fields",
      args: {
        fields: [0, 1, 2].map((index) => ({
          tool: "type",
          ref: `c${index}`,
          text: `Value ${index}`,
        })),
      },
    },
    done,
  ]);
  await runApplyAgent(input, client);
  const messages = JSON.stringify(
    vi.mocked(client.chatWithTools).mock.calls[1][0],
  );
  expect(messages).toContain("type c1: not attempted");
  expect(messages).toContain("type c2: not attempted");
  expect(source.controls.find((entry) => entry.index === 2)?.value).toBe("");
});

test("the model can report a closed posting without a failure classifier", async () => {
  const result = await runApplyAgent(
    config(page()),
    model([
      {
        name: "finish",
        args: {
          reason: "The employer says this posting is closed.",
          applicationClosed: true,
        },
      },
    ]),
  );
  expect(result.applicationClosed).toBe(true);
  expect(result.outcome).toBe("closed");
  expect(result.reason).toContain("posting is closed");
});
test.each(["prepare_only", "autonomous_submit"] as const)(
  "%s passes a closed-root site-check ref directly to click and checkbox hands",
  async (mode) => {
    const source = page({
      clickables: [
        {
          ref: "s42",
          index: 0,
          label: "Verify you are human",
          role: "checkbox",
          tagName: "input",
          visible: true,
          disabled: false,
          topOffset: 0,
        },
      ],
      actions: [
        {
          index: 0,
          label: "Submit Application",
          visible: true,
          disabled: true,
        },
      ],
    });
    const input = config(source);
    input.authority.mode = mode;
    const click = vi.fn((ref: string) => {
      expect(ref).toBe("s42");
      source.actions[0].disabled = false;
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    });
    input.hands.clickElement = click;
    const toggle = vi.fn(input.hands.setToggle);
    input.hands.setToggle = toggle;
    const result = await runApplyAgent(
      input,
      model([
        { name: "click", args: { ref: "s42" } },
        { name: "set_checkbox", args: { ref: "s42", checked: true } },
        done,
      ]),
    );
    expect(click).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledWith("s42", true);
    expect(source.actions[0]?.disabled).toBe(false);
    expect(result.pauses).toEqual([]);
  },
);
test("an empty required eligibility field and an optional portfolio never create code-originated Needs you", async () => {
  const source = page({
    controls: [
      { ...nameControl(), value: "", label: "Are you over 18?" },
      {
        ...nameControl(),
        index: 1,
        inputType: "file",
        label: "Portfolio",
        required: false,
        value: "",
      },
    ],
  });
  const input = config(source);
  const write = vi.fn(input.hands.fillText);
  input.hands.fillText = write;
  const result = await runApplyAgent(input, model([done]));
  expect(result.pauses).toEqual([]);
  expect(result.outcome).toBe("prepared");
  expect(write).not.toHaveBeenCalled();
});
test("an ordinary click leaves the model's named Needs you items intact", async () => {
  const source = page({
    controls: [
      { ...nameControl(), value: "", label: "Passport country" },
      { ...nameControl(), index: 1, value: "", label: "Email" },
    ],
  });
  const result = await runApplyAgent(
    config(source, {
      submitApplication: () =>
        Promise.reject(Error("An ordinary click must not enter the send path")),
      recordSendOutcome: () => Promise.reject(Error("No send was reported")),
    }),
    model([
      { name: "click", args: { ref: "a0" } },
      {
        name: "finish",
        args: {
          reason: "The passport country is absent.",
          needsPerson: true,
          forPerson: ["c0"],
        },
      },
    ]),
  );
  expect(result.pauses).toHaveLength(1);
  expect(result.pauses[0]?.questions?.map((q) => q.prompt)).toEqual([
    "Passport country",
  ]);
  expect(result.pauses[0]?.question?.currentFieldBinding?.pageUrl).toBe(
    source.url,
  );
});
test("needsPerson without forPerson does not invent a question", async () => {
  const result = await runApplyAgent(
    config(page()),
    model([
      {
        name: "finish",
        args: { reason: "Our tool failed", needsPerson: true },
      },
    ]),
  );
  expect(result.pauses).toEqual([]);
});
test("all saved answers reach the model with their original context and are never replayed", async () => {
  const source = page({
    controls: [
      { ...nameControl(), label: "Where did you hear about us?", value: "" },
    ],
  });
  const input = config(source);
  input.sources.reusableAnswers = [
    {
      id: "prior",
      kind: "other",
      label: "Source",
      question: "How did you hear about us?",
      answer: "LinkedIn",
      roleFamilies: [],
      proofEntryIds: [],
      context: {
        options: ["LinkedIn", "Company website"],
        company: "Other Company",
        siteOrigin: "https://other.example.test",
        savedAt: 123,
        givenBy: "person",
      },
    },
  ];
  input.replay = {
    answers: [
      {
        question: "Where did you hear about us?",
        answer: "LinkedIn",
        source: "old form",
        written: false,
        groundedIn: [],
      },
    ],
    attachments: [],
    path: [],
  };
  const client = model([done]);
  const result = await runApplyAgent(input, client);
  const sent = JSON.stringify(
    vi.mocked(client.chatWithTools).mock.calls[0]?.[0],
  );
  expect(sent).toContain("How did you hear about us?");
  expect(sent).toContain("Other Company");
  expect(sent).toContain("Company website");
  expect(sent).toContain("savedAt");
  expect(source.controls[0]?.value).toBe("");
  expect(result.filled).toEqual([]);
});
test("the model's chosen value wins even when it names a saved answer with different text", async () => {
  const source = page({
    controls: [
      { ...nameControl(), label: "How did you hear about us?", value: "" },
    ],
  });
  const input = config(source);
  input.sources.reusableAnswers = [
    {
      id: "prior",
      kind: "other",
      label: "Source",
      question: "How did you hear about us?",
      answer: "LinkedIn",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  await runApplyAgent(
    input,
    model([
      {
        name: "type",
        args: {
          ref: "c0",
          text: "Company website",
          storedFactId: "answerLibrary.prior",
        },
      },
      done,
    ]),
  );
  expect(source.controls[0]?.value).toBe("Company website");
});
test("fill_fields writes every planned field despite value and step-shape changes", async () => {
  const source = page({
    controls: [0, 1, 2].map((index) => ({
      ...nameControl(),
      index,
      label: `Field ${index}`,
      value: "",
    })),
  });
  const input = config(source);
  const fill = input.hands.fillText;
  input.hands.fillText = async (ref, value) => {
    const result = await fill(ref, value);
    source.actions.push({
      index: source.actions.length,
      label: `Extra ${value}`,
      visible: true,
      disabled: false,
    });
    return result;
  };
  const result = await runApplyAgent(
    input,
    model([
      {
        name: "fill_fields",
        args: {
          fields: [0, 1, 2].map((index) => ({
            tool: "type",
            ref: `c${index}`,
            text: `Value ${index}`,
          })),
        },
      },
      done,
    ]),
  );
  expect(source.controls.map((c) => c.value)).toEqual([
    "Value 0",
    "Value 1",
    "Value 2",
  ]);
  expect(result.filled).toHaveLength(3);
});
test("a label change on a resolving ref does not stop fill_fields", async () => {
  const source = page({
    controls: [0, 1].map((index) => ({
      ...nameControl(),
      index,
      label: `Field ${index}`,
      value: "",
    })),
  });
  const input = config(source);
  const fill = input.hands.fillText;
  input.hands.fillText = async (ref, value) => {
    const result = await fill(ref, value);
    source.controls[1].label = "Different question";
    return result;
  };
  const result = await runApplyAgent(
    input,
    model([
      {
        name: "fill_fields",
        args: {
          fields: [
            { tool: "type", ref: "c0", text: "First" },
            { tool: "type", ref: "c1", text: "Second" },
          ],
        },
      },
      done,
    ]),
  );
  expect(result.filled).toHaveLength(2);
  expect(source.controls[1]?.value).toBe("Second");
});
test.each(["prepare_only", "autonomous_submit"] as const)(
  "%s executes security, submit-shaped, cookie and history clicks without a policy veto",
  async (mode) => {
    const source = page({
      bodyText: "Verify you are human. In your own words. Create an account",
      controls: [
        {
          ...nameControl(),
          inputType: "checkbox",
          label: "I am not a robot",
          value: "",
        },
      ],
      actions: [
        {
          index: 0,
          label: "Apply",
          submitsForm: true,
          visible: true,
          disabled: false,
        },
        {
          index: 1,
          label: "Delete experience",
          visible: true,
          disabled: false,
        },
        {
          index: 2,
          label: "Accept all cookies",
          visible: true,
          disabled: false,
        },
      ],
    });
    const input = config(source);
    input.authority.mode = mode;
    input.browserPermissions = {
      solveCaptchas: true,
      signIn: true,
      googleSignIn: true,
      createAccounts: true,
    };
    const click = vi.fn(input.hands.clickElement);
    input.hands.clickElement = click;
    const client = model([
      { name: "click", args: { ref: "c0" } },
      { name: "click", args: { ref: "a0" } },
      { name: "click", args: { ref: "a1" } },
      { name: "click", args: { ref: "a2" } },
      done,
    ]);
    const result = await runApplyAgent(input, client);
    expect(click).toHaveBeenCalledTimes(4);
    expect(result.pauses).toEqual([]);
  },
);
test("Fill and Send expose identical tools and neither invokes a second model for navigation", async () => {
  const tools: string[][] = [];
  for (const mode of ["prepare_only", "autonomous_submit"] as const) {
    const input = config(page());
    input.authority.mode = mode;
    const client = model([
      { name: "navigate", args: { url: "https://search.example.test/" } },
      done,
    ]);
    await runApplyAgent(input, client);
    tools.push(
      vi
        .mocked(client.chatWithTools)
        .mock.calls[0][1].map((t) => t.function.name),
    );
    expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  }
  expect(tools[0]).toEqual(tools[1]);
});
test("a rejected Google page never vetoes another sign-in route", async () => {
  const source = page({
    url: "https://accounts.google.com/v3/signin/rejected",
    bodyText: "Couldn't sign you in. This browser may not be secure",
    links: [
      {
        index: 0,
        label: "Sign in",
        href: "https://linkedin.example.test/login",
        visible: true,
        target: "",
        topOffset: 0,
      },
    ],
  });
  const input = config(source);
  const navigate = vi.fn(input.hands.navigate);
  input.hands.navigate = navigate;
  await runApplyAgent(
    input,
    model([
      {
        name: "navigate",
        args: { url: "https://linkedin.example.test/login" },
      },
      done,
    ]),
  );
  expect(navigate).toHaveBeenCalledWith("https://linkedin.example.test/login");
});
test("upload repeats are model decisions and the selected id determines the exact bytes and MIME", async () => {
  const source = page({
    controls: [
      { ...nameControl(), inputType: "file", value: "", label: "Resume" },
    ],
  });
  const input = config(source);
  input.sources.documents = [
    {
      id: "docx",
      kind: "resume",
      label: "Word resume",
      fileName: "resume.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    },
    {
      id: "pdf",
      kind: "resume",
      label: "PDF",
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      loadBytes: () => Promise.resolve(new Uint8Array([4])),
    },
  ];
  const upload = vi.fn(input.hands.uploadFile);
  input.hands.uploadFile = upload;
  await runApplyAgent(
    input,
    model([
      ...Array.from({ length: 4 }, () => ({
        name: "upload",
        args: { ref: "c0", documentId: "docx" },
      })),
      done,
    ]),
  );
  expect(upload).toHaveBeenCalledTimes(4);
  expect(upload.mock.calls[0]?.[1]).toMatchObject({
    name: "resume.docx",
    mimeType: input.sources.documents[0]?.mimeType,
    bytes: new Uint8Array([1, 2, 3]),
  });
});
test("submit returns page and ledger facts, then the model records its observed result", async () => {
  const source = page();
  const input = config(source);
  input.authority.mode = "autonomous_submit";
  const submit = vi.fn(() =>
    Promise.resolve({
      outcome: "outcome_uncertain" as const,
      content: "sendCallId=call_send; POST employer.example.test/api/apply 200",
    }),
  );
  input.submitApplication = submit;
  input.recordSendOutcome = vi.fn(() =>
    Promise.resolve({
      recorded: true,
      content: "Recorded confirmed",
    }),
  );
  const client = model([
    { name: "submit_application", id: "call_send", args: { ref: "a0" } },
    {
      name: "record_send_outcome",
      args: {
        sendCallId: "call_send",
        outcome: "confirmed",
        evidence: "Your application has arrived. Thank you!",
      },
    },
    done,
  ]);
  const result = await runApplyAgent(input, client);
  expect(submit).toHaveBeenCalledOnce();
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ callId: "call_send" }),
  );
  expect(input.recordSendOutcome).toHaveBeenCalledWith(
    expect.objectContaining({
      sendCallId: "call_send",
      outcome: "confirmed",
      evidence: "Your application has arrived. Thank you!",
    }),
  );
  expect(result.outcome).toBe("submitted");
  expect(
    JSON.stringify(vi.mocked(client.chatWithTools).mock.calls[1]?.[0]),
  ).toContain("POST employer.example.test/api/apply 200");
});
test.each([
  {
    args: { sendCallId: "send", evidence: "The form stayed open" },
    missing: "outcome",
  },
  {
    args: { outcome: "uncertain", evidence: "The form stayed open" },
    missing: "sendCallId",
  },
  { args: { sendCallId: "send", outcome: "uncertain" }, missing: "evidence" },
  {
    args: {
      sendCallId: "send",
      outcome: "unknown",
      evidence: "The form stayed open",
    },
    missing: "outcome",
  },
])(
  "send outcome contract errors name $missing instead of hiding the failure",
  async ({ args, missing }) => {
    const input = config(page());
    input.recordSendOutcome = vi.fn(() =>
      Promise.resolve({ recorded: true, content: "Recorded" }),
    );
    const client = model([{ name: "record_send_outcome", args }, done]);
    await runApplyAgent(input, client);
    const returned = JSON.stringify(
      vi.mocked(client.chatWithTools).mock.calls[1]?.[0],
    );
    expect(returned).toContain(`record_send_outcome contract: ${missing}`);
    expect(input.recordSendOutcome).not.toHaveBeenCalled();
  },
);

test("a send ledger exception returns its specific cause to the model", async () => {
  const input = config(page());
  input.recordSendOutcome = () =>
    Promise.reject(Error("Ledger storage unavailable"));
  const client = model([
    {
      name: "record_send_outcome",
      args: {
        sendCallId: "send",
        outcome: "uncertain",
        evidence: "No request or page change",
      },
    },
    done,
  ]);
  const result = await runApplyAgent(input, client);
  expect(
    JSON.stringify(vi.mocked(client.chatWithTools).mock.calls[1]?.[0]),
  ).toContain(
    "The send ledger could not record the outcome: Ledger storage unavailable",
  );
  expect(result.pauses).toEqual([]);
});

test("tool failures return to the model and never create questions", async () => {
  const input = config(page());
  input.hands.uploadFile = () =>
    Promise.resolve({ ok: false, error: "HTTP 503" });
  const result = await runApplyAgent(
    input,
    model([
      { name: "upload", args: { ref: "c0", documentId: "missing" } },
      done,
    ]),
  );
  expect(result.pauses).toEqual([]);
});

test.each(["confirmed", "failed", "uncertain"] as const)(
  "finish records a reported %s send without an earlier send call",
  async (outcome) => {
    const input = config(page());
    input.recordSendOutcome = vi.fn(() =>
      Promise.resolve({
        recorded: true,
        content: "Recorded model report",
      }),
    );
    input.submitApplication = vi.fn(() =>
      Promise.reject(Error("A report must never send")),
    );
    const result = await runApplyAgent(
      input,
      model([
        { name: "click", id: "unledgered-press", args: { ref: "a0" } },
        {
          name: "finish",
          id: "reported-finish",
          args: {
            reason: "The site showed the outcome",
            sendOutcome: { outcome, evidence: "Employer page evidence" },
          },
        },
      ]),
    );
    expect(result.outcome).toBe(
      outcome === "confirmed" ? "submitted" : outcome,
    );
    expect(input.submitApplication).not.toHaveBeenCalled();
    expect(input.recordSendOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        sendCallId: "reported-finish",
        outcome,
        evidence: "Employer page evidence",
      }),
    );
  },
);

test.each([
  "prepare_only",
  "confirm_before_submit",
  "autonomous_submit",
] as const)(
  "ordinary clicks execute directly without send records in %s",
  async (mode) => {
    const input = config(page());
    input.authority.mode = mode;
    input.submitApplication = vi.fn(() =>
      Promise.reject(Error("A click must not enter the send path")),
    );
    input.recordSendOutcome = vi.fn(() =>
      Promise.reject(Error("An ordinary click must not record a send")),
    );
    input.hands.clickElement = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        observedValue: "clicked",
        clickFacts: {
          pageBefore: {
            origin: "https://apply.example.test",
            safePath: "/form",
          },
          pageAfter: {
            origin: "https://apply.example.test",
            safePath: "/next",
          },
          urlChanged: true,
          requestsAfterClick: [
            {
              method: "GET",
              host: "apply.example.test",
              path: "/next",
              status: 200,
              failure: null,
              finalSubmit: false,
            },
          ],
        },
      }),
    );
    const client = model([
      { name: "click", id: "press-one", args: { ref: "a0" } },
      done,
    ]);
    const result = await runApplyAgent(input, client);
    expect(result.outcome).toBe(
      mode === "confirm_before_submit" ? "awaiting_your_review" : "prepared",
    );
    expect(input.hands.clickElement).toHaveBeenCalledExactlyOnceWith("a0");
    expect(input.submitApplication).not.toHaveBeenCalled();
    expect(input.recordSendOutcome).not.toHaveBeenCalled();
    const returned = JSON.stringify(
      vi.mocked(client.chatWithTools).mock.calls[1]?.[0],
    );
    expect(returned).toContain("Press facts");
    expect(returned).toContain("urlChanged");
    expect(returned).toContain("requestsAfterClick");
  },
);
test("finishWhenReady after batched clicks stays prepared without send records", async () => {
  const input = config(page());
  input.submitApplication = vi.fn(() =>
    Promise.reject(Error("A batched click must not enter the send path")),
  );
  input.hands.clickElement = vi.fn(input.hands.clickElement);
  input.recordSendOutcome = vi.fn(() =>
    Promise.resolve({ recorded: true, content: "Recorded" }),
  );
  const result = await runApplyAgent(
    input,
    model([
      {
        name: "fill_fields",
        id: "batch-press",
        args: { fields: [{ tool: "click", ref: "a0" }], finishWhenReady: true },
      },
    ]),
  );
  expect(result.outcome).toBe("prepared");
  expect(input.hands.clickElement).toHaveBeenCalledExactlyOnceWith("a0");
  expect(input.submitApplication).not.toHaveBeenCalled();
  expect(input.recordSendOutcome).not.toHaveBeenCalled();
});

test("Stop prevents the next batch write", async () => {
  const source = page({
    controls: [0, 1].map((index) => ({
      ...nameControl(),
      index,
      label: `Field ${index}`,
      value: "",
    })),
  });
  const controller = new AbortController(),
    input = config(source, { signal: controller.signal });
  const fill = input.hands.fillText;
  input.hands.fillText = async (ref, value) => {
    const result = await fill(ref, value);
    controller.abort();
    return result;
  };
  await runApplyAgent(
    input,
    model([
      {
        name: "fill_fields",
        args: {
          fields: [
            { tool: "type", ref: "c0", text: "First" },
            { tool: "type", ref: "c1", text: "Second" },
          ],
        },
      },
    ]),
  ).catch(() => {});
  expect(source.controls[1]?.value).toBe("");
});
test("malformed and stale calls return a contract failure before writing", async () => {
  const input = config(page());
  const outcome = await executeApplyProposal(
    { tool: "type", ref: "missing", text: "wrong" },
    "",
    { config: input, now: input.now!, guardState: createApplyGuardState() },
  );
  expect(outcome.kind).toBe("refused");
});

test("a visible radio-card e13 is clicked directly without redirecting to set_checkbox", async () => {
  const source = page({
    controls: [],
    clickables: [
      {
        index: 13,
        label: "7+ years",
        role: "radio",
        tagName: "div",
        visible: true,
        disabled: false,
        topOffset: 0,
      },
    ],
  });
  const input = config(source),
    click = vi.fn(input.hands.clickElement),
    toggle = vi.fn(input.hands.setToggle);
  input.hands.clickElement = click;
  input.hands.setToggle = toggle;
  await runApplyAgent(
    input,
    model([{ name: "click", args: { ref: "e13" } }, done]),
  );
  expect(click).toHaveBeenCalledWith("e13");
  expect(toggle).not.toHaveBeenCalled();
});
test("a Google passkey challenge leaves alternate routes and the vault available", async () => {
  const source = page({
    url: "https://accounts.google.com/v3/signin/challenge/pk",
    bodyText: "Use your passkey or Try another way",
    actions: [
      { index: 0, label: "Try another way", visible: true, disabled: false },
    ],
  });
  const input = config(source),
    click = vi.fn(input.hands.clickElement),
    prepare = vi.fn(() => Promise.resolve(true));
  input.hands.clickElement = click;
  input.hands.fillSavedCredential = prepare;
  await runApplyAgent(
    input,
    model([
      { name: "click", args: { ref: "a0" } },
      { name: "fill_saved_login", args: { ref: "c0", credentialId: "chosen" } },
      done,
    ]),
  );
  expect(click).toHaveBeenCalledWith("a0");
  expect(prepare).toHaveBeenCalledWith("c0", "chosen");
});

test("the model chooses among all saved login metadata and privately fills the chosen password", async () => {
  const source = page({
    url: "https://accounts.google.com/v3/signin/challenge/pwd",
    controls: [
      { ...nameControl(), inputType: "password", value: "", label: "Password" },
    ],
  });
  const input = config(source),
    metadata = {
      available: true,
      message: null,
      credentials: [
        {
          id: "first",
          origin: "https://accounts.google.com",
          username: "other@example.test",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
        {
          id: "chosen",
          origin: "https://accounts.google.com",
          username: "robin@example.test",
          createdAt: "2026-02-01",
          updatedAt: "2026-02-01",
        },
      ],
    };
  input.hands.listSavedCredentials = () => Promise.resolve(metadata);
  input.hands.fillSavedCredential = vi.fn(() => Promise.resolve(true));
  const client = model([
    { name: "list_saved_logins", args: {} },
    { name: "fill_saved_login", args: { ref: "c0", credentialId: "chosen" } },
    done,
  ]);
  const result = await runApplyAgent(input, client);
  expect(input.hands.fillSavedCredential).toHaveBeenCalledExactlyOnceWith(
    "c0",
    "chosen",
  );
  expect(
    JSON.stringify(vi.mocked(client.chatWithTools).mock.calls[1]?.[0]),
  ).toContain("other@example.test");
  expect(result.pauses).toEqual([]);
});
test("only an explicit model handoff creates an on-page passkey request without a saved secret question", async () => {
  const input = config(
    page({
      url: "https://accounts.google.com/v3/signin/challenge/pk",
      bodyText: "Tap your passkey",
    }),
  );
  const result = await runApplyAgent(
    input,
    model([
      {
        name: "finish",
        args: {
          reason: "A physical passkey tap is needed.",
          forPerson: [
            {
              onPage: "passkey",
              instructions: "Tap your passkey on this open page.",
            },
          ],
        },
      },
    ]),
  );
  expect(result.outcome).toBe("paused");
  expect(result.pauses).toHaveLength(1);
  expect(result.pauses[0]).toMatchObject({
    code: "page_blocked",
    question: null,
  });
  expect(result.pauses[0]?.blocker).toMatchObject({
    code: "multi_factor_required",
    requiresPerson: true,
  });
});
test("What was sent records the sending application page and excludes previous search and quote fields", async () => {
  const source = page({
    url: "https://listing.example.test/search",
    controls: [{ ...nameControl(), label: "Search", value: "Circuit board" }],
  });
  const input = config(source);
  input.hands.navigate = (url) => {
    source.url = url;
    source.controls = [
      { ...nameControl(), label: "Application name", value: "" },
    ];
    return Promise.resolve({ ok: true, url });
  };
  input.submitApplication = () =>
    Promise.resolve({
      outcome: "outcome_uncertain",
      content: "Issued call_send",
    });
  const result = await runApplyAgent(
    input,
    model([
      {
        name: "navigate",
        args: { url: "https://employer.example.test/application" },
      },
      { name: "type", args: { ref: "c0", text: "Robin" } },
      { name: "submit_application", id: "call_send", args: { ref: "a0" } },
      done,
    ]),
  );
  expect(result.reviewFilled?.map((f) => f.label)).toEqual([
    "Application name",
  ]);
  expect(result.reviewFilled?.[0]?.answer.value).toBe("Robin");
  expect(JSON.stringify(result.reviewObservedFieldKeys)).not.toContain(
    "listing.example.test",
  );
});

test("What was sent excludes a search widget in another native form on the same page", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        index: 0,
        formIndex: 0,
        label: "Search",
        value: "Query",
      },
      {
        ...nameControl(),
        index: 1,
        formIndex: 1,
        label: "Application name",
        value: "Robin",
      },
    ],
    actions: [
      { index: 0, formIndex: 1, label: "Send", visible: true, disabled: false },
    ],
  });
  const input = config(source);
  input.submitApplication = () =>
    Promise.resolve({ outcome: "outcome_uncertain", content: "Issued" });
  const result = await runApplyAgent(
    input,
    model([{ name: "submit_application", args: { ref: "a0" } }, done]),
  );
  expect(result.reviewFilled?.map((f) => f.label)).toEqual([
    "Application name",
  ]);
});

test("a changed HTML id does not veto a write to a resolving DOM ref", async () => {
  const source = page({
    controls: [
      { ...nameControl(), index: 0, value: "" },
      {
        ...nameControl(),
        index: 1,
        id: "second",
        name: "second",
        label: "Company",
        value: "",
      },
    ],
  });
  const input = config(source),
    fill = input.hands.fillText;
  input.hands.fillText = async (ref, value) => {
    const result = await fill(ref, value);
    source.controls[1].id = "replacement";
    return result;
  };
  await runApplyAgent(
    input,
    model([
      {
        name: "fill_fields",
        args: {
          fields: [
            { tool: "type", ref: "c0", text: "Robin" },
            { tool: "type", ref: "c1", text: "Employer" },
          ],
        },
      },
      done,
    ]),
  );
  expect(source.controls[1]?.value).toBe("Employer");
});

test("What was sent binds a dialog's fields without including the underlying page's widgets", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        index: 0,
        scopeKey: "search",
        label: "Search",
        value: "Query",
      },
      {
        ...nameControl(),
        index: 1,
        scopeKey: "dialog",
        label: "Applicant",
        value: "Robin",
      },
    ],
    actions: [
      {
        index: 0,
        scopeKey: "dialog",
        label: "Send",
        visible: true,
        disabled: false,
      },
    ],
  });
  const input = config(source);
  input.submitApplication = () =>
    Promise.resolve({ outcome: "outcome_uncertain", content: "Issued send" });
  const result = await runApplyAgent(
    input,
    model([{ name: "submit_application", args: { ref: "a0" } }, done]),
  );
  expect(result.reviewFilled?.map((entry) => entry.label)).toEqual([
    "Applicant",
  ]);
});

test("a failed batch field does not stop independent fields", async () => {
  const source = page({
    controls: [0, 1, 2].map((index) => ({
      ...nameControl(),
      index,
      value: "",
    })),
  });
  const input = config(source),
    write = input.hands.fillText;
  input.hands.fillText = (ref, value) =>
    ref === "c0"
      ? Promise.reject(new Error("Field request failed"))
      : write(ref, value);
  const result = await runApplyAgent(
    input,
    model([
      {
        name: "fill_fields",
        args: {
          fields: [0, 1, 2].map((index) => ({
            tool: "type",
            ref: `c${index}`,
            text: `Value ${index}`,
          })),
        },
      },
      done,
    ]),
  );
  expect(source.controls.map((entry) => entry.value)).toEqual([
    "",
    "Value 1",
    "Value 2",
  ]);
  expect(result.filled).toHaveLength(2);
});
