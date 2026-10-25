import { CandidateProfileSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  buildCoverLetterRequest,
  coverLetterPolicyAllows,
  coverLetterDeliveryFor,
  detectPostingLanguage,
  isCoverLetterControl,
  looksLikeUsableLetter,
  requiredLetterFileType,
} from "./cover-letter";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

/**
 * The letter that goes with one application.
 *
 * The rules worth holding: the same request whether the form wants a file or a
 * box, never a language the posting did not ask for, and never a letter with a
 * gap in it where a person was supposed to fill something in.
 */

function control(overrides: Partial<ApplyFormControl> = {}): ApplyFormControl {
  return {
    ref: "c0",
    kind: "long_text",
    label: "",
    groupLabel: "",
    placeholder: "",
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    value: "",
    checked: false,
    options: [],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: "other",
    answerControlType: "text",
    attestationKind: null,
    answered: false,
    ...overrides,
  };
}

function sources(description: string): ApplyAnswerSources {
  return {
    profile: CandidateProfileSchema.parse({
      id: "candidate_test",
      firstName: "Robin",
      lastName: "Ashford",
      fullName: "Robin Ashford",
      headline: "Platform engineer",
      summary: "Builds dependable internal tools.",
      currentLocation: "Manchester",
      yearsExperience: 8,
      baseResume: {
        id: "resume_test",
        fileName: "resume.txt",
        uploadedAt: "2026-09-01T09:00:00.000Z",
        textContent: "Resume",
        textUpdatedAt: "2026-09-01T09:00:00.000Z",
        extractionStatus: "ready",
      },
    }),
    resumeText: "Robin Ashford. 8 years of platform engineering.",
    posting: {
      title: "Platform Engineer",
      company: "Northwind Tools",
      location: "Manchester",
      description,
    },
    reusableAnswers: [],
    documents: [],
  };
}

describe("the letter one application sends", () => {
  test("a file field and a text box are the same request", () => {
    const fileField = control({
      kind: "file",
      label: "Cover letter",
      questionKind: "cover_letter",
    });
    const textBox = control({
      label: "Why do you want to work here?",
      questionKind: "cover_letter",
    });

    expect(isCoverLetterControl(fileField)).toBe(true);
    expect(isCoverLetterControl(textBox)).toBe(true);
    expect(coverLetterDeliveryFor(fileField)).toBe("file");
    expect(coverLetterDeliveryFor(textBox)).toBe("text");
  });

  test("the saved letter policy distinguishes required and optional fields", () => {
    const required = control({ label: "Cover letter", required: true });
    const optional = control({ label: "Cover letter", required: false });

    expect(coverLetterPolicyAllows(required, "when_required")).toBe(true);
    expect(coverLetterPolicyAllows(optional, "when_required")).toBe(false);
    expect(coverLetterPolicyAllows(optional, "when_possible")).toBe(true);
    expect(coverLetterPolicyAllows(required, "never")).toBe(false);
  });

  test("a form that names one file type is taken at its word", () => {
    expect(
      requiredLetterFileType(
        control({ kind: "file", label: "Cover letter (PDF only)" }),
      ),
    ).toBe("pdf");
    expect(
      requiredLetterFileType(
        control({ kind: "file", label: "Cover letter (Word document)" }),
      ),
    ).toBe("docx");
    // Offered a choice, the form is left to decide nothing.
    expect(
      requiredLetterFileType(
        control({ kind: "file", label: "Cover letter (PDF or DOCX)" }),
      ),
    ).toBeNull();
  });

  test("the posting's language is followed, and only when it is clear", () => {
    expect(
      detectPostingLanguage(
        "Wir suchen eine Person mit Erfahrung und Freude an der Arbeit mit uns bei einem Team das fur Qualitat steht und das Produkt",
      ),
    ).toBe("German");
    expect(detectPostingLanguage("Own the internal platform.")).toBeNull();
  });

  test("a saved preference overrides the posting's language", () => {
    const request = buildCoverLetterRequest({
      sources: sources(
        "Wir suchen eine Person und wir arbeiten mit einem Team fur das Produkt",
      ),
      preference: {
        tone: "plain_professional",
        length: "standard",
        language: "English",
        sample: null,
      },
    });
    expect(request.language).toBe("English");
    expect(request.prompt).toContain("Write it in English.");
  });

  test("the letter is told exactly what it may be built from", () => {
    const request = buildCoverLetterRequest({
      sources: sources("Own the internal platform."),
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: "I have always liked building tools that other people rely on.",
      },
    });

    expect(request.groundedIn.join("\n")).toContain(
      "Resume sent with this application",
    );
    expect(request.groundedIn.join("\n")).toContain("Saved sample letter");
    expect(request.prompt).toContain('"headline": "Platform engineer"');
    expect(request.prompt).toContain('"yearsExperience": 8');
    expect(request.groundedIn.join("\n")).not.toContain("{\n");
    expect(request.groundedIn).toContain(
      "Profile summary: Builds dependable internal tools.",
    );
    expect(request.prompt).toContain("About 120 words");
    expect(request.prompt).toContain("Direct and brief");
    expect(request.prompt).toContain("Match the voice, not the content");
    expect(request.prompt).toContain("Do not state anything else as fact");
    expect(request.prompt).toContain(
      "must be supported by their resume or profile",
    );
    expect(request.prompt).toContain(
      "never turn a job requirement into a claim that the person has done it",
    );
  });

  test("a letter with a gap where a person should have typed is refused", () => {
    const body = "Dear hiring team, ".padEnd(260, "I have built platforms. ");
    expect(looksLikeUsableLetter(body)).toBe(true);
    expect(looksLikeUsableLetter(`${body} [Your name here]`)).toBe(false);
    expect(looksLikeUsableLetter(`${body} {{company}}`)).toBe(false);
    expect(looksLikeUsableLetter("Too short.")).toBe(false);
  });
});

test("letter request supplies current date and role dates, and asks for posting-specific examples", () => {
  const profile = sources("Research and accessible prototyping.").profile;
  profile.experiences = [
    {
      id: "warehouse",
      companyName: "Example logistics",
      title: "Warehouse manager",
      startDate: "2019-01",
      isCurrent: true,
      endDate: null,
      isDraft: false,
      summary: null,
      achievements: [],
      skills: [],
      domainTags: [],
      companyUrl: null,
      employmentType: null,
      location: null,
      workMode: [],
      peopleManagementScope: null,
      ownershipScope: null,
    },
  ];
  const request = buildCoverLetterRequest({
    sources: {
      profile,
      resumeText: null,
      posting: {
        title: "Designer",
        company: "Example",
        location: "Remote",
        description: "Research and accessible prototyping.",
      },
      reusableAnswers: [],
      documents: [],
    },
    preference: {
      length: "short",
      tone: "plain_professional",
      language: null,
      sample: null,
    },
    today: "2026-10-02",
  });
  expect(request.prompt).toContain("Today: 2026-10-02");
  expect(request.prompt).toContain('"startDate": "2019-01"');
  expect(request.prompt).toContain('"isCurrent": true');
  expect(request.prompt).toContain("two or three supported examples");
  expect(request.prompt).toContain("omit the duration");
});

test("letter input makes accepted contacts and role constraints authoritative", () => {
  const input = sources("Full-time contract work in Boston.");
  input.profile.email = "accepted@example.test";
  input.reusableAnswers = [
    ...input.reusableAnswers,
    {
      id: "availability",
      kind: "availability",
      label: "Availability",
      question: "Availability",
      answer: "20–30 hours, London only",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  input.profile.narrative.nextChapterSummary = "A senior in-house role";
  input.resumeText =
    "Robin Ashford. Old contact rejected@example.test. Built internal tools.";
  const request = buildCoverLetterRequest({
    sources: input,
    preference: {
      tone: "formal",
      length: "detailed",
      language: "French",
      sample: null,
    },
  });
  expect(request.prompt).toContain('"email": "accepted@example.test"');
  expect(request.prompt).toContain("20–30 hours, London only");
  expect(request.prompt).toContain("incompatible generic career goal");
  expect(request.prompt).toContain(
    "current saved profile name and contact details",
  );
  expect(request.groundedIn.join("\n")).not.toContain("rejected@example.test");
});

test("review evidence has single stops and the letter prompt excludes pay and trims the resume", () => {
  const applicant = sources("Build tools").profile;
  applicant.proofBank = CandidateProfileSchema.parse({
    ...applicant,
    proofBank: [
      { id: "proof", title: "Reporting.", claim: "Cut reporting time." },
    ],
  }).proofBank;
  applicant.answerBank.salaryExpectations = "PRIVATE_PAY_SENTINEL";
  applicant.answerBank.customAnswers = [
    {
      id: "pay",
      kind: "salary_expectation",
      label: "Current pay?",
      question: "Current pay?",
      answer: "PRIVATE_HISTORY_SENTINEL",
      proofEntryIds: [],
      roleFamilies: [],
    },
  ];
  const request = buildCoverLetterRequest({
    sources: {
      profile: applicant,
      resumeText: "A".repeat(8_000) + "RESUME_TAIL_SENTINEL",
      posting: {
        title: "Engineer",
        company: "Synthetic",
        location: "Remote",
        description: "Build tools",
      },
      reusableAnswers: applicant.answerBank.customAnswers,
      documents: [],
    },
    preference: {
      tone: "direct",
      length: "short",
      language: null,
      sample: null,
    },
  });
  expect(request.prompt).not.toMatch(
    /PRIVATE_PAY_SENTINEL|PRIVATE_HISTORY_SENTINEL|RESUME_TAIL_SENTINEL/,
  );
  expect(request.prompt).toContain("Do not ask the employer to accommodate");
  expect(request.groundedIn.join(" ")).not.toContain("..");
});
