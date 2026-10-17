import { describe, expect, test } from "vitest";
import type { ResumeDocumentBlock } from "@nestor/contracts";

import { createPreferences, createProfile } from "../test-fixtures";
import { selectBlocksForResumeImportStage } from "../resume-import";
import { buildDeterministicResumeImportStageExtraction } from "./resume-import";
import { buildDeterministicResumeProfileExtraction } from "./resume-parser";

const JUNIOR_RESUME = [
  "DEVON PARK",
  "Junior Software Developer",
  "devon.park@example.test | Raleigh, North Carolina",
  "SUMMARY",
  "Entry-level developer with bootcamp, project, and internship experience in TypeScript, React, Node.js, SQL, and automated testing. Seeking a junior web development role with structured mentorship.",
  "INTERNSHIP",
  "Software Development Intern - Pine Workshop Software",
  "May 2026-August 2026",
  "- Fixed small interface defects with guidance from a senior developer.",
  "- Added tests and updated setup notes for an internal scheduling tool.",
  "PROJECTS",
  "Neighborhood Tool Share",
  "- Built a responsive React and TypeScript catalog for lending household tools.",
  "- Added Node.js API validation and PostgreSQL queries for inventory availability.",
  "- Wrote Vitest tests for account-free browsing and reservation rules.",
  "Study Planner",
  "- Created an accessible keyboard-friendly planner using semantic HTML and CSS.",
  "- Documented setup and testing steps for other student contributors.",
  "EDUCATION",
  "Full-stack Web Development Bootcamp - Triangle Code School, 2026",
  "SKILLS",
  "TypeScript, JavaScript, React, Node.js, PostgreSQL, Git, Vitest, HTML, CSS",
].join("\n");

function createJuniorBundle() {
  const blocks: ResumeDocumentBlock[] = JUNIOR_RESUME.split("\n").map(
    (text, readingOrder) => ({
      id: `junior_${readingOrder + 1}`,
      pageNumber: 1,
      readingOrder,
      text,
      kind: text.startsWith("-") ? "list_item" : "paragraph",
      sectionHint: "other",
      bbox: null,
      sourceParserKinds: ["plain_text"],
      sourceConfidence: 0.98,
    }),
  );

  return {
    id: "junior_resume_bundle",
    runId: "junior_resume_run",
    sourceResumeId: "junior_resume",
    sourceFileKind: "plain_text" as const,
    primaryParserKind: "plain_text" as const,
    parserKinds: ["plain_text" as const],
    createdAt: "2026-08-30T00:00:00.000Z",
    languageHints: [],
    warnings: [],
    pages: [],
    blocks,
    fullText: JUNIOR_RESUME,
  };
}

describe("junior resume section boundaries", () => {
  test("keeps internship content out of summary and imports it as experience", () => {
    const extraction = buildDeterministicResumeProfileExtraction(
      {
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        resumeText: JUNIOR_RESUME,
      },
      "deterministic",
      "Test provider",
      { preserveExistingValues: false },
    );

    expect(extraction.summary).toBe(
      "Entry-level developer with bootcamp, project, and internship experience in TypeScript, React, Node.js, SQL, and automated testing. Seeking a junior web development role with structured mentorship.",
    );
    expect(extraction.summary).not.toContain("Pine Workshop Software");
    expect(extraction.experiences).toHaveLength(1);
    expect(extraction.experiences[0]).toMatchObject({
      companyName: "Pine Workshop Software",
      title: "Software Development Intern",
      startDate: "May 2026",
      endDate: "August 2026",
      isCurrent: false,
    });
  });

  test("keeps title-followed-by-bullet projects as separate records", () => {
    const extraction = buildDeterministicResumeProfileExtraction(
      {
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        resumeText: JUNIOR_RESUME,
      },
      "deterministic",
      "Test provider",
      { preserveExistingValues: false },
    );

    expect(extraction.projects).toHaveLength(2);
    expect(extraction.projects.map((project) => project.name)).toEqual([
      "Neighborhood Tool Share",
      "Study Planner",
    ]);
    expect(extraction.projects[0]?.summary).not.toContain("Study Planner");
    expect(extraction.projects[1]?.summary).toContain(
      "keyboard-friendly planner",
    );
  });

  test("does not treat a bullet detail line as a new project heading", () => {
    const extraction = buildDeterministicResumeProfileExtraction(
      {
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        resumeText: [
          "PROJECTS",
          "Neighborhood Tool Share",
          "- Built a responsive catalog.",
          "- Accessibility improvements for keyboard users.",
          "- Added reservation validation.",
        ].join("\n"),
      },
      "deterministic",
      "Test provider",
      { preserveExistingValues: false },
    );

    expect(extraction.projects).toHaveLength(1);
    expect(extraction.projects[0]?.name).toBe("Neighborhood Tool Share");
    expect(extraction.projects[0]?.summary).toContain(
      "Accessibility improvements for keyboard users.",
    );
  });

  test("uses the same internship boundary for staged experience extraction", () => {
    const bundle = createJuniorBundle();
    const selectedTexts = selectBlocksForResumeImportStage(
      bundle,
      "experience",
    ).map((block) => block.text);

    expect(selectedTexts).toContain("INTERNSHIP");
    expect(selectedTexts).toContain(
      "Software Development Intern - Pine Workshop Software",
    );
    expect(selectedTexts).not.toContain("PROJECTS");

    const result = buildDeterministicResumeImportStageExtraction(
      {
        stage: "experience",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: bundle,
      },
      "Test provider",
    );
    const experienceCandidate = result.candidates.find(
      (candidate) => candidate.target.section === "experience",
    );

    expect(experienceCandidate?.value).toMatchObject({
      companyName: "Pine Workshop Software",
      title: "Software Development Intern",
    });
  });
});
