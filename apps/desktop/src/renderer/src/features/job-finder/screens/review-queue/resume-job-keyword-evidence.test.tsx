// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import {
  ResumeDraftBulletSchema,
  ResumeDraftEntrySchema,
  ResumeDraftSchema,
  ResumeDraftSectionSchema,
  type ResumeDraft,
  type ResumeDraftBullet,
  type ResumeDraftEntry,
  type ResumeDraftSection,
  type ResumeDraftSourceRef,
} from "@nestor/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildResumeJobKeywordEvidence,
  ResumeJobKeywordEvidencePanel,
  type ResumeKeywordEvidenceJob,
} from "./resume-job-keyword-evidence";

const updatedAt = "2026-04-27T00:00:00.000Z";

function createSourceRef(
  sourceKind: ResumeDraftSourceRef["sourceKind"],
  snippet: string,
): ResumeDraftSourceRef {
  return {
    id: `${sourceKind}_evidence`,
    sourceKind,
    sourceId: `${sourceKind}_1`,
    snippet,
  };
}

function createBullet(
  id: string,
  text: string,
  sourceRefs: readonly ResumeDraftSourceRef[] = [],
): ResumeDraftBullet {
  return ResumeDraftBulletSchema.parse({
    id,
    text,
    origin: "imported",
    sourceRefs,
    updatedAt,
  });
}

function createSection(
  overrides: Partial<ResumeDraftSection> = {},
): ResumeDraftSection {
  return ResumeDraftSectionSchema.parse({
    id: "section_summary",
    kind: "summary",
    label: "Summary",
    origin: "imported",
    sortOrder: 0,
    updatedAt,
    ...overrides,
  });
}

function createEntry(
  overrides: Partial<ResumeDraftEntry> = {},
): ResumeDraftEntry {
  return ResumeDraftEntrySchema.parse({
    id: "entry_1",
    entryType: "experience",
    origin: "imported",
    sortOrder: 0,
    updatedAt,
    ...overrides,
  });
}

function createDraft(overrides: Partial<ResumeDraft> = {}): ResumeDraft {
  return ResumeDraftSchema.parse({
    id: "draft_1",
    jobId: "job_1",
    status: "draft",
    templateId: "classic_ats",
    identity: null,
    sections: [],
    targetPageCount: 2,
    generationMethod: "manual",
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    workHistoryReviewAcknowledgments: [],
    claimConfirmations: [],
    issueApprovals: [],
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  });
}

function createJob(
  overrides: Partial<ResumeKeywordEvidenceJob> = {},
): ResumeKeywordEvidenceJob {
  return {
    title: "Senior Frontend Engineer",
    keySkills: ["React", "TypeScript"],
    keywordSignals: [],
    minimumQualifications: [],
    benefits: [],
    ...overrides,
  };
}

afterEach(cleanup);

function renderedSupportedKeywords(): HTMLElement {
  const supported = document.querySelector("[data-resume-supported-keywords]");
  if (!(supported instanceof HTMLElement)) {
    throw new Error("Expected the supported-keywords panel to render.");
  }
  return supported;
}

function renderedMissingKeywords(): HTMLElement {
  const missing = document.querySelector("[data-resume-missing-keywords]");
  if (!(missing instanceof HTMLElement)) {
    throw new Error("Expected the missing-keywords panel to render.");
  }
  return missing;
}

describe("ResumeJobKeywordEvidencePanel", () => {
  it("leaves requirements unchecked without semantic checks, even for exact phrase matches", () => {
    const draft = createDraft({
      sections: [
        createSection({
          sourceRefs: [
            createSourceRef(
              "profile",
              "Built React and TypeScript interfaces for workflow teams.",
            ),
          ],
        }),
      ],
    });
    const items = buildResumeJobKeywordEvidence({ draft, job: createJob() });
    expect(items.map((item) => [item.term, item.status])).toEqual([
      ["React", "unchecked"],
      ["TypeScript", "unchecked"],
    ]);
    render(<ResumeJobKeywordEvidencePanel draft={draft} job={createJob()} />);
    expect(screen.getByText("2 not checked")).toBeTruthy();
    expect(screen.getByText("0 supported")).toBeTruthy();
    expect(renderedMissingKeywords().textContent).toContain("React");
    expect(renderedSupportedKeywords().textContent).not.toContain(
      "Saved profile:",
    );
  });

  it("leaves evidence unchecked without a model verdict, regardless of draft phrase overlap (R3-074)", () => {
    const draft = createDraft({
      sections: [
        createSection({
          kind: "experience",
          label: "Experience",
          entries: [
            createEntry({
              title: "React Engineer",
              subtitle: "Acme Labs",
              summary: "Built TypeScript interfaces for workflow teams.",
              profileRecordId: "experience_profile_only",
            }),
          ],
        }),
      ],
    });
    const before = buildResumeJobKeywordEvidence({ draft, job: createJob() });
    expect(before.every((item) => item.status === "unchecked")).toBe(true);
    render(<ResumeJobKeywordEvidencePanel draft={draft} job={createJob()} />);
    expect(renderedMissingKeywords().textContent).not.toContain(
      "Draft wording:",
    );
    expect(renderedMissingKeywords().textContent).not.toContain(
      "Saved profile:",
    );
    const edited = { ...draft, sections: [] };
    expect(
      buildResumeJobKeywordEvidence({ draft: edited, job: createJob() }).map(
        (item) => item.status,
      ),
    ).toEqual(before.map((item) => item.status));
  });

  it("uses semantic saved checks for capabilities and compound requirements (R3-074)", () => {
    const job = {
      ...createJob(),
      matchAssessment: {
        requirementsSource: "model" as const,
        requirements: [
          {
            id: "lead",
            category: "experience" as const,
            importance: "required" as const,
            label: "Leadership and budgeting",
            status: "partial" as const,
            jobEvidence: "Lead a team and manage budgets",
            resumeEvidence: [
              {
                sourceKind: "experience" as const,
                sourceId: "role",
                label: "Saved role",
                detail: "Led a logistics team of four",
              },
            ],
            explanation: "Leadership supported; budgeting is not evidenced.",
          },
          {
            id: "pipeline",
            category: "skill" as const,
            importance: "required" as const,
            label: "Data pipelines",
            status: "supported" as const,
            jobEvidence: "Maintain ETL",
            resumeEvidence: [
              {
                sourceKind: "project" as const,
                sourceId: "project",
                label: "Saved project",
                detail: "Built ETL workflows",
              },
            ],
            explanation: "ETL supports pipeline experience.",
          },
        ],
      },
    };
    const draft = createDraft();
    const items = buildResumeJobKeywordEvidence({ draft, job });
    expect(items.map((item) => [item.term, item.status])).toEqual([
      ["Leadership and budgeting", "partial"],
      ["Data pipelines", "supported"],
    ]);
    expect(items.some((item) => item.term === "Training offered")).toBe(false);
    render(<ResumeJobKeywordEvidencePanel draft={draft} job={job} />);
    expect(screen.getByText("Partial support")).toBeTruthy();
    expect(screen.getByText("1 supported")).toBeTruthy();
    expect(screen.getByText("1 partial")).toBeTruthy();
    expect(renderedSupportedKeywords().textContent).toContain(
      "budgeting is not evidenced",
    );
    expect(
      buildResumeJobKeywordEvidence({ draft: { ...draft, sections: [] }, job }),
    ).toEqual(items);
  });

  it("does not treat a profile record locator without visible content as evidence", () => {
    const draft = createDraft({
      sections: [
        createSection({
          kind: "experience",
          label: "Experience",
          entries: [
            createEntry({ profileRecordId: "experience_without_content" }),
          ],
        }),
      ],
    });
    const job = createJob({ keySkills: ["React"] });

    expect(buildResumeJobKeywordEvidence({ draft, job })).toEqual([
      expect.objectContaining({
        evidence: null,
        sourceLabel: null,
        status: "unchecked",
        term: "React",
      }),
    ]);

    render(<ResumeJobKeywordEvidencePanel draft={draft} job={job} />);

    const missing = renderedMissingKeywords();
    expect(within(missing).getByText("React")).toBeTruthy();
    expect(screen.getByText("0 supported")).toBeTruthy();
    expect(screen.getByText("1 not checked")).toBeTruthy();
  });

  it("leaves requirements unchecked when saved evidence has no semantic check", () => {
    const draft = createDraft({
      sections: [
        createSection({
          sourceRefs: [createSourceRef("resume", "Built React interfaces.")],
        }),
      ],
    });

    const rendered = render(
      <ResumeJobKeywordEvidencePanel
        draft={draft}
        job={createJob({ keySkills: ["React", "Kubernetes"] })}
      />,
    );
    const missing = rendered.container.querySelector(
      "[data-resume-missing-keywords]",
    );
    if (!(missing instanceof HTMLElement)) {
      throw new Error("Expected the missing-keywords panel to render.");
    }
    expect(within(missing).getByText("Kubernetes")).toBeTruthy();
    expect(within(missing).getAllByText("Not checked")).toHaveLength(2);
    expect(screen.getByText("0 supported")).toBeTruthy();
    expect(screen.getByText("2 not checked")).toBeTruthy();
    expect(
      screen.getByText(
        "Keep these terms out unless you can add truthful support from your own experience.",
      ),
    ).toBeTruthy();
  });

  it("does not use a hidden targeted-keyword section as candidate evidence", () => {
    const hiddenTargetedSection = createSection({
      id: "section_keywords",
      kind: "keywords",
      label: "Targeted Keywords",
      included: false,
      bullets: [
        createBullet("keyword_kubernetes", "Kubernetes", [
          createSourceRef("resume", "Kubernetes"),
        ]),
      ],
    });
    const draft = createDraft({ sections: [hiddenTargetedSection] });

    const items = buildResumeJobKeywordEvidence({
      draft,
      job: createJob({ keySkills: [] }),
    });

    expect(items).toEqual([
      expect.objectContaining({
        evidence: null,
        sourceLabel: null,
        status: "unchecked",
        term: "Kubernetes",
      }),
    ]);

    const rendered = render(
      <ResumeJobKeywordEvidencePanel
        draft={draft}
        job={createJob({ keySkills: [] })}
      />,
    );

    expect(
      within(
        rendered.container.querySelector(
          "[data-resume-supported-keywords]",
        ) as HTMLElement,
      ).queryByText("Kubernetes"),
    ).toBeNull();
    expect(
      within(
        rendered.container.querySelector(
          "[data-resume-missing-keywords]",
        ) as HTMLElement,
      ).getByText("Kubernetes"),
    ).toBeTruthy();
  });

  it("discloses fallback output as review-only and keeps the panel non-mutating", () => {
    const draft = createDraft({
      sections: [
        createSection({
          sourceRefs: [createSourceRef("resume", "React delivery work.")],
        }),
      ],
    });

    const rendered = render(
      <ResumeJobKeywordEvidencePanel
        draft={draft}
        fallbackMessage="The AI resume draft timed out, so Job Finder used the built-in fallback."
        job={createJob({ keySkills: ["React"] })}
      />,
    );

    const note = screen.getByRole("note");
    expect(note.textContent).toContain(
      "This draft needs a factual review before approval.",
    );
    expect(note.textContent).toContain(
      "The keyword list is a review aid only; it does not add evidence or prove that a term is true.",
    );
    expect(rendered.container.querySelectorAll("button")).toHaveLength(0);
  });

  it("discloses a needs-review draft even without a fallback note", () => {
    const draft = createDraft({
      status: "needs_review",
      sections: [
        createSection({
          sourceRefs: [createSourceRef("profile", "React delivery work.")],
        }),
      ],
    });

    render(<ResumeJobKeywordEvidencePanel draft={draft} job={createJob()} />);

    expect(screen.getByRole("note").textContent).toContain("before approval");
  });

  it("stays absent when a job has no explicit keyword signals", () => {
    const draft = createDraft({
      sections: [
        createSection({
          sourceRefs: [
            createSourceRef("resume", "Five years of React experience."),
          ],
        }),
      ],
    });
    const job = createJob({
      keySkills: [],
      keywordSignals: [],
      minimumQualifications: ["Five years of React experience."],
    });

    expect(buildResumeJobKeywordEvidence({ draft, job })).toEqual([]);
    const rendered = render(
      <ResumeJobKeywordEvidencePanel draft={draft} job={job} />,
    );
    expect(rendered.container.firstElementChild).toBeNull();
  });

  it("associates the named region with its visible heading and description", () => {
    const draft = createDraft({
      sections: [
        createSection({
          sourceRefs: [createSourceRef("profile", "React delivery work.")],
        }),
      ],
    });

    const rendered = render(
      <ResumeJobKeywordEvidencePanel draft={draft} job={createJob()} />,
    );
    const panel = rendered.getByRole("region", {
      name: "Job keywords and evidence",
    });
    const headingId = panel.getAttribute("aria-labelledby");
    const descriptionId = panel.getAttribute("aria-describedby");

    expect(headingId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    expect(
      headingId ? document.getElementById(headingId) : null,
    ).toHaveProperty("textContent", "Job keywords and evidence");
    expect(
      descriptionId ? document.getElementById(descriptionId) : null,
    ).toHaveProperty(
      "textContent",
      expect.stringContaining("A missing term is not added to the draft."),
    );
  });
});

it("does not turn employer benefits into candidate evidence gaps", () => {
  const job = createJob({
    keySkills: ["Figma", "Inclusive team"],
    benefits: ["Inclusive team", "Training offered"],
    keywordSignals: [
      { id: "culture", label: "Inclusive team", kind: "benefit", weight: 1 },
      { id: "training", label: "Training offered", kind: "benefit", weight: 1 },
      { id: "tool", label: "Figma", kind: "tool", weight: 3 },
    ],
  });
  const evidence = buildResumeJobKeywordEvidence({ job, draft: createDraft() });
  expect(JSON.stringify(evidence)).not.toContain("Inclusive team");
  expect(JSON.stringify(evidence)).not.toContain("Training offered");
  expect(JSON.stringify(evidence)).toContain("Figma");
});
