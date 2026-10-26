import { readFileSync } from "node:fs";
import {
  CandidateProfileSchema,
  type CandidateProfile,
} from "@nestor/contracts";
import { expect, test } from "vitest";

import { runResumeGenerationAgentTask } from "./agent-capabilities";
import { createDeterministicJobFinderAiClient } from "./deterministic";
import { buildJobFitAssessmentPayload } from "./openai-compatible-fit";
import { buildResumeClaimCheckPayload } from "./openai-compatible-resume-claims";
import { buildResumeGenerationEvidenceCatalog } from "./resume-generation-grounding";
import type { AgentCapableJobFinderAiClient, AgentMessage } from "./shared";
import { ResumeProposalValidationError } from "./shared";
import {
  createJobPosting,
  createPreferences,
  createSettings,
} from "./test-fixtures";

/**
 * A synthetic profile at the scale of a long-used workspace: the Lina Haddad
 * persona's resume plus ten roles, forty saved answers, projects and proof
 * points. Every value is fictional.
 */
function largeSyntheticProfile(): CandidateProfile {
  const persona = readFileSync(
    new URL(
      "../../../apps/desktop/test-fixtures/job-finder/resume-import-personas/lina-haddad.txt",
      import.meta.url,
    ),
    "utf8",
  );
  const experiences = Array.from({ length: 10 }, (_, index) => ({
    id: `experience_${index}`,
    title: `Data Analyst ${index}`,
    companyName: `Example Analytics ${index} GmbH`,
    location: "Berlin, Germany",
    startDate: `${2014 + index}-01`,
    endDate: index === 0 ? null : `${2015 + index}-01`,
    isCurrent: index === 0,
    summary: `Owned the weekly reporting cycle for team ${index}: gathered requirements from operations leads, modelled the data in SQL, and kept dashboards accurate while the business changed.`,
    achievements: Array.from(
      { length: 6 },
      (_, item) =>
        `Built report ${item} for team ${index} in Looker Studio and BigQuery, replacing ${item + 2} manual spreadsheets and saving about ${item + 3} hours a week.`,
    ),
    skills: ["SQL", "BigQuery", "Looker Studio", "Python", "pandas"],
  }));
  const resumeText = [
    persona,
    "Additional experience",
    ...experiences.flatMap((role) => [
      `${role.title} - ${role.companyName}`,
      role.summary,
      ...role.achievements.map((line) => `* ${line}`),
    ]),
  ].join("\n");
  return CandidateProfileSchema.parse({
    id: "candidate_large",
    firstName: "Lina",
    lastName: "Haddad",
    fullName: "Lina Haddad",
    headline: "Data analyst and data science student",
    summary:
      "Data science student who builds dependable reporting for operations teams with SQL, Python and BI tools.",
    currentLocation: "Berlin, Germany",
    yearsExperience: 3,
    email: "lina.haddad@example.com",
    phone: "+49 151 5550 1234",
    githubUrl: "https://github.com/lina-haddad-example",
    baseResume: {
      id: "resume_large",
      fileName: "lina-haddad.txt",
      uploadedAt: "2026-09-01T09:00:00.000Z",
      textContent: resumeText,
      textUpdatedAt: "2026-09-01T09:00:00.000Z",
      extractionStatus: "ready",
    },
    workEligibility: {
      authorizedWorkCountries: ["Germany"],
      requiresVisaSponsorship: true,
    },
    proofBank: Array.from({ length: 10 }, (_, index) => ({
      id: `proof_${index}`,
      title: `Reporting win ${index}`,
      claim: `Replaced ${index + 2} manual spreadsheets with one SQL model and dashboard used every week by the operations team.`,
    })),
    targetRoles: ["Data Analyst", "Junior Data Scientist"],
    locations: ["Berlin, Germany"],
    skills: Array.from(
      { length: 40 },
      (_, index) => `Analytics skill ${index}`,
    ),
    experiences,
    education: [
      {
        id: "education_0",
        degree: "M.Sc.",
        fieldOfStudy: "Data Science",
        schoolName: "Technische Universität Berlin",
      },
    ],
    projects: Array.from({ length: 6 }, (_, index) => ({
      id: `project_${index}`,
      name: `Forecasting project ${index}`,
      summary:
        "Forecast bike-sharing demand from weather data with LightGBM and a small feature pipeline in Python.",
      skills: ["Python", "LightGBM"],
    })),
  });
}

/** The display fields the studio assembles for translation: headings and every shown line. */
function languageFieldsFor(profile: CandidateProfile) {
  return [
    { id: "heading_summary", text: "Summary" },
    { id: "heading_experience", text: "Experience" },
    ...profile.experiences.flatMap((experience) => [
      { id: `${experience.id}_title`, text: experience.title ?? "" },
      ...experience.achievements.map((text, index) => ({
        id: `${experience.id}_bullet_${index}`,
        text,
      })),
    ]),
  ];
}

test("the writer gets the evidence once and a record outline, and a refused proposal's repair does not resend it", async () => {
  const profile = largeSyntheticProfile();
  const request = {
    profile,
    searchPreferences: createPreferences(),
    settings: createSettings(),
    job: createJobPosting(),
    resumeText: profile.baseResume.textContent,
    language: null,
    languageFields: languageFieldsFor(profile),
    targetPageCount: 2,
  };
  const marker = "UNIQUE_SYNTHETIC_PROPOSAL_MARKER";
  const turns: AgentMessage[][] = [];
  let renders = 0;
  const client: AgentCapableJobFinderAiClient = {
    ...createDeterministicJobFinderAiClient(),
    chatWithTools(messages) {
      turns.push(messages);
      return Promise.resolve({
        toolCalls: [
          {
            id: `compose_${turns.length}`,
            type: "function" as const,
            function: {
              name: "compose_resume_proposal",
              arguments: JSON.stringify({
                proposal: {
                  summary: {
                    text: `Builds reliable reporting. ${marker}`,
                    evidenceRefs: ["profile:summary"],
                  },
                  languagePresentation: {
                    language: "English",
                    listingLanguage: "English",
                    translations: [],
                  },
                },
              }),
            },
          },
        ],
      });
    },
  };
  await runResumeGenerationAgentTask({
    client,
    substantivePrompt: "Write a grounded resume.",
    request: {
      ...request,
      renderPreview: () => {
        if (++renders === 1)
          throw new ResumeProposalValidationError(
            "The synthetic render refused this proposal.",
            [],
          );
        return Promise.resolve({
          templateId: "classic_ats",
          pageCount: 2,
          warnings: [],
          fileName: "preview.pdf",
          requiredModelRepairs: [],
        });
      },
    },
  });

  expect(turns).toHaveLength(2);
  const firstPayload = JSON.parse(turns[0]![1]!.content) as Record<
    string,
    unknown
  >;
  const evidence = buildResumeGenerationEvidenceCatalog(request);
  const resumeMetadata: Record<string, unknown> = { ...profile.baseResume };
  delete resumeMetadata.textContent;
  const before = JSON.stringify({
    ...firstPayload,
    candidateProfile: {
      ...profile,
      baseResume: {
        ...resumeMetadata,
        textContentEvidenceRef: "baseResume:text",
      },
    },
    languageFields: request.languageFields,
  });
  const after = JSON.stringify(firstPayload);
  console.info(
    `[token budget] writer payload: before ${before.length} chars, after ${after.length} chars`,
  );
  expect(after.length).toBeLessThan(before.length * 0.7);
  // Contact details reach the writer only inside the resume text it cites.
  expect(JSON.stringify(firstPayload.candidateProfile)).not.toMatch(
    /lina\.haddad@example\.com|\+49 151|github\.com/u,
  );
  expect(after).not.toContain("Saved answer 0");
  // Every achievement is still there, once, as evidence.
  for (const experience of profile.experiences)
    for (const achievement of experience.achievements) {
      expect(evidence.some((item) => item.text === achievement)).toBe(true);
      expect(after.split(achievement).length - 1).toBe(
        // Also once inside the imported resume text item.
        2,
      );
    }

  // The repair turn carries the proposal once: as workingProposal.
  const repairTurn = JSON.stringify(turns[1]);
  console.info(
    `[token budget] writer repair turn: ${repairTurn.length} chars, proposal copies ${repairTurn.split(marker).length - 1}`,
  );
  expect(repairTurn.split(marker).length - 1).toBe(1);
});

test("a full listing read gets the trimmed profile, not contact details or saved answers", () => {
  const profile = largeSyntheticProfile();
  const input = {
    assessmentDate: "2026-10-21",
    profile,
    searchPreferences: createPreferences(),
    job: createJobPosting(),
  };
  const after = JSON.stringify(buildJobFitAssessmentPayload(input));
  const before = JSON.stringify({
    ...buildJobFitAssessmentPayload(input),
    profile: { ...profile },
  });
  console.info(
    `[token budget] full listing read payload: before ${before.length} chars, after ${after.length} chars`,
  );
  expect(after.length).toBeLessThan(before.length * 0.7);
  expect(after).toContain("Built report 0 for team 0");
  expect(after).toContain("Additional experience");
  const payload = buildJobFitAssessmentPayload(input);
  expect(
    JSON.stringify(payload.profile).split("lina.haddad@example.com"),
  ).toHaveLength(
    // Only inside the imported resume text.
    2,
  );
  expect(payload.profile).not.toHaveProperty("email");
  expect(payload.profile).not.toHaveProperty("answerBank");
  expect(after).not.toContain("Saved answer 0");
});

test("a claim check without the duplicate resume text", () => {
  const profile = largeSyntheticProfile();
  const resume = profile.baseResume.textContent!;
  const evidence = resume
    .split("\n")
    .filter((line) => line.trim().split(/\s+/u).length >= 2)
    .map((text, index) => ({ id: `claim_evidence_resume_${index}`, text }));
  const input = {
    tailoringStrength: "balanced",
    job: { title: "Data Analyst", company: "Northwind", description: "SQL." },
    evidence,
    resumeText: null,
    claims: [{ id: "line_1", section: "Summary", text: "Builds SQL reports." }],
  };
  const after = JSON.stringify(buildResumeClaimCheckPayload(input));
  const before = JSON.stringify(
    buildResumeClaimCheckPayload({ ...input, resumeText: resume }),
  );
  console.info(
    `[token budget] claim check payload: before ${before.length} chars, after ${after.length} chars`,
  );
  expect(after).not.toContain('"importedResume"');
  expect(before.length - after.length).toBeGreaterThanOrEqual(resume.length);
});
