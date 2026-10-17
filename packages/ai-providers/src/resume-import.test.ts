import { describe, expect, test } from "vitest";
import type { ResumeDocumentBundle } from "@nestor/contracts";
import {
  sanitizeStageCandidates,
  selectBlocksForResumeImportStage,
} from "./resume-import";
import { buildDeterministicResumeImportStageExtraction } from "./deterministic/resume-import";
import { createPreferences, createProfile } from "./test-fixtures";

const bundle: ResumeDocumentBundle = {
  id: "bundle_1",
  runId: "run_1",
  sourceResumeId: "resume_1",
  sourceFileKind: "pdf",
  primaryParserKind: "pdfjs_text",
  parserKinds: ["pdfjs_text"],
  createdAt: "2026-04-10T00:00:00.000Z",
  warnings: [],
  languageHints: [],
  pages: [],
  fullText: null,
  blocks: [
    {
      id: "b1",
      pageNumber: 1,
      readingOrder: 0,
      text: "Elian Morava",
      kind: "paragraph",
      sectionHint: "identity",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b2",
      pageNumber: 1,
      readingOrder: 1,
      text: "Address: Prishtina, Kosovo (Home)",
      kind: "paragraph",
      sectionHint: "contact",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b3",
      pageNumber: 1,
      readingOrder: 2,
      text: "SKILLS",
      kind: "heading",
      sectionHint: "skills",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b4",
      pageNumber: 1,
      readingOrder: 3,
      text: "React, Next.js, TypeScript",
      kind: "paragraph",
      sectionHint: "skills",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b5",
      pageNumber: 1,
      readingOrder: 4,
      text: "WORK EXPERIENCE",
      kind: "heading",
      sectionHint: "experience",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b6",
      pageNumber: 1,
      readingOrder: 5,
      text: "NORTHLANE – PRISHTINA, KOSOVO",
      kind: "heading",
      sectionHint: "identity",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b7",
      pageNumber: 1,
      readingOrder: 6,
      text: "SENIOR FULL-STACK SOFTWARE ENGINEER – 07/2023 – Current",
      kind: "paragraph",
      sectionHint: "summary",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b8",
      pageNumber: 2,
      readingOrder: 0,
      text: "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO",
      kind: "heading",
      sectionHint: "identity",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b9",
      pageNumber: 2,
      readingOrder: 1,
      text: ".NET CONSULTANT – 01/2022 – Current",
      kind: "paragraph",
      sectionHint: "identity",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b10",
      pageNumber: 2,
      readingOrder: 2,
      text: ".NET DEVELOPER – TERRA-NO – 01/2019 – 07/2019 – PRISHTINA, KOSOVO",
      kind: "paragraph",
      sectionHint: "summary",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b11",
      pageNumber: 3,
      readingOrder: 0,
      text: "TECHNICAL SUPPORT AGENT – BYTE BY BYTE – 06/2017 – 12/2017 – PRISHTINA, KOSOVO",
      kind: "paragraph",
      sectionHint: "summary",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b12",
      pageNumber: 3,
      readingOrder: 1,
      text: "EDUCATION AND TRAINING",
      kind: "heading",
      sectionHint: "education",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b13",
      pageNumber: 3,
      readingOrder: 2,
      text: "BACHELOR'S DEGREE, COMPUTER SCIENCE Kolegji Arbana (Arbana College)",
      kind: "paragraph",
      sectionHint: "education",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b14",
      pageNumber: 3,
      readingOrder: 3,
      text: "LANGUAGE SKILLS",
      kind: "heading",
      sectionHint: "skills",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
    {
      id: "b15",
      pageNumber: 3,
      readingOrder: 4,
      text: "ENGLISH C2 C2 C2 C2 C2",
      kind: "heading",
      sectionHint: "languages",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
  ],
};

describe("selectBlocksForResumeImportStage", () => {
  test("keeps full experience ranges even when company markers were misclassified", () => {
    const selected = selectBlocksForResumeImportStage(bundle, "experience");
    const texts = selected.map((block) => block.text);

    expect(texts).toContain("NORTHLANE – PRISHTINA, KOSOVO");
    expect(texts).toContain("BRIDGEWAY L.L.C – PRISHTINA, KOSOVO");
    expect(texts).toContain(".NET CONSULTANT – 01/2022 – Current");
    expect(texts).toContain(
      ".NET DEVELOPER – TERRA-NO – 01/2019 – 07/2019 – PRISHTINA, KOSOVO",
    );
    expect(texts).toContain(
      "TECHNICAL SUPPORT AGENT – BYTE BY BYTE – 06/2017 – 12/2017 – PRISHTINA, KOSOVO",
    );
    expect(texts).not.toContain("EDUCATION AND TRAINING");
  });

  test("keeps skills, education, and language ranges for background extraction", () => {
    const selected = selectBlocksForResumeImportStage(bundle, "background");
    const texts = selected.map((block) => block.text);

    expect(texts).toContain("SKILLS");
    expect(texts).toContain("React, Next.js, TypeScript");
    expect(texts).toContain("EDUCATION AND TRAINING");
    expect(texts).toContain("LANGUAGE SKILLS");
    expect(texts).toContain("ENGLISH C2 C2 C2 C2 C2");
    expect(texts).not.toContain("BRIDGEWAY L.L.C – PRISHTINA, KOSOVO");
  });

  test("adds confidence breakdowns during candidate sanitation", () => {
    const result = sanitizeStageCandidates(
      {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: bundle,
      },
      {
        stage: "identity_summary",
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Test",
        candidates: [
          {
            target: { section: "identity", key: "fullName", recordId: null },
            label: "Full name",
            value: "Elian Morava",
            normalizedValue: "Elian Morava",
            valuePreview: "Elian Morava",
            evidenceText: "Elian Morava",
            sourceBlockIds: ["b1"],
            confidence: 0.98,
            notes: [],
            alternatives: [],
            conflictChoices: [],
            visualEvidence: [],
          },
        ],
        notes: [],
      },
    );

    expect(result.candidates[0]?.confidenceBreakdown?.overall).toBeGreaterThan(
      0.8,
    );
    expect(result.candidates[0]?.confidenceBreakdown?.recommendation).toBe(
      "auto_apply",
    );
  });

  test("grounds deterministic summary and years-of-experience candidates from experience text", () => {
    const result = buildDeterministicResumeImportStageExtraction(
      {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: {
          ...bundle,
          blocks: [
            {
              id: "b1",
              pageNumber: 1,
              readingOrder: 0,
              text: "Noah Brenner",
              kind: "heading",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.96,
            },
            {
              id: "b2",
              pageNumber: 1,
              readingOrder: 1,
              text: "Senior Software Engineer",
              kind: "paragraph",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.92,
            },
            {
              id: "b3",
              pageNumber: 1,
              readingOrder: 2,
              text: "Senior Software Engineer with 10+ years of experience building secure, scalable healthcare and SaaS platforms with C#,.NET, ASP.NET Core, REST APIs, MongoDB, SQL Server, and cloud-native services on Azure and AWS. Proven record",
              kind: "paragraph",
              sectionHint: "summary",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b4",
              pageNumber: 1,
              readingOrder: 3,
              text: "delivering microservices, third-party integrations, CI/CD automation, observability, and production support in Agile teams.",
              kind: "paragraph",
              sectionHint: "summary",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b5",
              pageNumber: 1,
              readingOrder: 4,
              text: "EXPERIENCE",
              kind: "heading",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b6",
              pageNumber: 1,
              readingOrder: 5,
              text: "10+ years of experience building secure, scalable healthcare and SaaS platforms.",
              kind: "paragraph",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
          ],
          fullText: [
            "Noah Brenner",
            "Senior Software Engineer",
            "Senior Software Engineer with 10+ years of experience building secure, scalable healthcare and SaaS platforms with C#,.NET, ASP.NET Core, REST APIs, MongoDB, SQL Server, and cloud-native services on Azure and AWS. Proven record",
            "delivering microservices, third-party integrations, CI/CD automation, observability, and production support in Agile teams.",
            "EXPERIENCE",
            "10+ years of experience building secure, scalable healthcare and SaaS platforms.",
          ].join("\n"),
        },
      },
      "Test provider",
    );

    const summaryCandidate = result.candidates.find(
      (candidate) => candidate.target.key === "summary",
    );
    const yearsCandidate = result.candidates.find(
      (candidate) => candidate.target.key === "yearsExperience",
    );

    expect(summaryCandidate?.sourceBlockIds.length).toBeGreaterThan(0);
    expect(summaryCandidate?.evidenceText).toContain("10+ years of experience");
    expect(yearsCandidate?.sourceBlockIds.length).toBeGreaterThan(0);
    expect(yearsCandidate?.evidenceText).toContain("10+");
  });

  test("keeps degree evidence when school and degree occupy separate document blocks", () => {
    const result = buildDeterministicResumeImportStageExtraction(
      {
        stage: "background",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: {
          ...bundle,
          blocks: [
            {
              id: "education_heading",
              pageNumber: 1,
              readingOrder: 0,
              text: "Education",
              kind: "heading",
              sectionHint: "education",
              bbox: null,
              sourceParserKinds: ["mammoth"],
              sourceConfidence: 0.95,
            },
            {
              id: "education_school",
              pageNumber: 1,
              readingOrder: 1,
              text: "Technical University of Berlin",
              kind: "paragraph",
              sectionHint: "education",
              bbox: null,
              sourceParserKinds: ["mammoth"],
              sourceConfidence: 0.95,
            },
            {
              id: "education_degree",
              pageNumber: 1,
              readingOrder: 2,
              text: "Bachelor of Science in Computer Science",
              kind: "paragraph",
              sectionHint: "education",
              bbox: null,
              sourceParserKinds: ["mammoth"],
              sourceConfidence: 0.95,
            },
          ],
          fullText: [
            "Education",
            "Technical University of Berlin",
            "Bachelor of Science in Computer Science",
          ].join("\n"),
          primaryParserKind: "mammoth",
          parserKinds: ["mammoth"],
          sourceFileKind: "docx",
        },
      },
      "Test provider",
    );

    const educationCandidate = result.candidates.find(
      (candidate) => candidate.target.section === "education",
    );

    expect(educationCandidate?.value).toMatchObject({
      schoolName: "Technical University of Berlin",
      degree: "Bachelor of Science in Computer Science",
    });
    expect(educationCandidate?.sourceBlockIds).toEqual([
      "education_school",
      "education_degree",
    ]);
    expect(educationCandidate?.evidenceText).toContain(
      "Bachelor of Science in Computer Science",
    );
  });
  test("grounds derived years-of-experience candidates from dated experience ranges when no explicit years text exists", () => {
    const result = buildDeterministicResumeImportStageExtraction(
      {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: {
          ...bundle,
          blocks: [
            {
              id: "b1",
              pageNumber: 1,
              readingOrder: 0,
              text: "Owen Mercer",
              kind: "heading",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.96,
            },
            {
              id: "b2",
              pageNumber: 1,
              readingOrder: 1,
              text: "Senior Software Engineer",
              kind: "paragraph",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.92,
            },
            {
              id: "b3",
              pageNumber: 1,
              readingOrder: 2,
              text: "Experienced Staff Engineer with a focus on leading complex, high-impact initiatives across full-stack systems.",
              kind: "paragraph",
              sectionHint: "summary",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b4",
              pageNumber: 1,
              readingOrder: 3,
              text: "EXPERIENCE",
              kind: "heading",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b5",
              pageNumber: 1,
              readingOrder: 4,
              text: "EdSights, Remote, NY — Staff/Senior Software Engineer",
              kind: "heading",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b6",
              pageNumber: 1,
              readingOrder: 5,
              text: "Sep 2021 – Feb 2026",
              kind: "paragraph",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b7",
              pageNumber: 1,
              readingOrder: 6,
              text: "Agile Thought, Tampa, FL — Senior Software Developer",
              kind: "heading",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b8",
              pageNumber: 1,
              readingOrder: 7,
              text: "Jul 2019 - Sep 2021",
              kind: "paragraph",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b9",
              pageNumber: 1,
              readingOrder: 8,
              text: "Agile Thought, Tampa, FL — Software Developer",
              kind: "heading",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
            {
              id: "b10",
              pageNumber: 1,
              readingOrder: 9,
              text: "Sep 2016 - Jul 2019",
              kind: "paragraph",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
          ],
          fullText: [
            "Owen Mercer",
            "Senior Software Engineer",
            "Experienced Staff Engineer with a focus on leading complex, high-impact initiatives across full-stack systems.",
            "EXPERIENCE",
            "EdSights, Remote, NY — Staff/Senior Software Engineer",
            "Sep 2021 – Feb 2026",
            "Agile Thought, Tampa, FL — Senior Software Developer",
            "Jul 2019 - Sep 2021",
            "Agile Thought, Tampa, FL — Software Developer",
            "Sep 2016 - Jul 2019",
          ].join("\n"),
        },
      },
      "Test provider",
    );

    const yearsCandidate = result.candidates.find(
      (candidate) => candidate.target.key === "yearsExperience",
    );

    expect(yearsCandidate?.value).toBeGreaterThanOrEqual(9);
    expect(yearsCandidate?.sourceBlockIds.length).toBeGreaterThan(0);
    expect(yearsCandidate?.evidenceText).toContain("2021");
  });

  test("falls back to summary evidence for years-of-experience when the experience section has no explicit years phrase", () => {
    const result = buildDeterministicResumeImportStageExtraction(
      {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: {
          ...bundle,
          blocks: [
            {
              id: "b1",
              pageNumber: 1,
              readingOrder: 0,
              text: "Jamie Rivers",
              kind: "heading",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 0.98,
            },
            {
              id: "b2",
              pageNumber: 1,
              readingOrder: 1,
              text: "Staff Frontend Engineer",
              kind: "paragraph",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 0.96,
            },
            {
              id: "b3",
              pageNumber: 1,
              readingOrder: 2,
              text: "Summary",
              kind: "heading",
              sectionHint: "summary",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 0.96,
            },
            {
              id: "b4",
              pageNumber: 1,
              readingOrder: 3,
              text: "Staff frontend engineer with 12 years of experience building React, TypeScript, and design system foundations for product teams.",
              kind: "paragraph",
              sectionHint: "summary",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 0.94,
            },
            {
              id: "b5",
              pageNumber: 1,
              readingOrder: 4,
              text: "Experience",
              kind: "heading",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 0.94,
            },
            {
              id: "b6",
              pageNumber: 1,
              readingOrder: 5,
              text: "Signal Systems",
              kind: "paragraph",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 0.94,
            },
            {
              id: "b7",
              pageNumber: 1,
              readingOrder: 6,
              text: "Staff Frontend Engineer",
              kind: "experience_header",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 0.94,
            },
          ],
          fullText: [
            "Jamie Rivers",
            "Staff Frontend Engineer",
            "Summary",
            "Staff frontend engineer with 12 years of experience building React, TypeScript, and design system foundations for product teams.",
            "Experience",
            "Signal Systems",
            "Staff Frontend Engineer",
          ].join("\n"),
        },
      },
      "Test provider",
    );

    const yearsCandidate = result.candidates.find(
      (candidate) => candidate.target.key === "yearsExperience",
    );

    expect(yearsCandidate?.value).toBe(12);
    expect(yearsCandidate?.sourceBlockIds).toEqual(["b4"]);
    expect(yearsCandidate?.evidenceText).toContain("12 years of experience");
  });

  test("extracts focused evidence snippets from relaxed candidates while preserving raw-first order", () => {
    const longSummary = [
      "Senior software engineer with platform modernization experience across distributed systems and cloud migration programs.",
      "Partners with product, security, and infrastructure teams to deliver resilient releases.",
    ].join(" ");
    const result = buildDeterministicResumeImportStageExtraction(
      {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: {
          ...bundle,
          blocks: [
            {
              id: "b1",
              pageNumber: 1,
              readingOrder: 0,
              text: "Jordan Avery",
              kind: "heading",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.96,
            },
            {
              id: "b2",
              pageNumber: 1,
              readingOrder: 1,
              text: `${longSummary.split(" ").slice(0, 8).join(" ")} ${"Additional delivery detail ".repeat(40)}`,
              kind: "paragraph",
              sectionHint: "summary",
              bbox: null,
              sourceParserKinds: ["local_pdf_layout"],
              sourceConfidence: 0.88,
            },
          ],
          fullText: ["Jordan Avery", longSummary].join("\n"),
        },
      },
      "Test provider",
    );

    const summaryCandidate = result.candidates.find(
      (candidate) => candidate.target.key === "summary",
    );

    expect(summaryCandidate?.sourceBlockIds).toEqual(["b2"]);
    expect(summaryCandidate?.evidenceText).toContain(
      "Senior software engineer with platform modernization experience",
    );
    expect(summaryCandidate?.evidenceText?.endsWith("...")).toBe(false);
  });
});
