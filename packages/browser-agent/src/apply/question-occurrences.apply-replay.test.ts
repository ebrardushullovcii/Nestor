import replay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/repeated-employment-step.json";
import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { createQuestionOccurrences } from "./question-occurrences";
import { buildApplyFormObservation } from "./page-hands";
import {
  createApplyGuardState,
  executeApplyProposal,
  questionPrompt,
} from "./policy-executor";
import type { ApplyAgentConfig, ApplyFormObservation } from "./types";

function page(index: number): ApplyFormObservation {
  return buildApplyFormObservation(
    {
      url: "https://replica.test/repeated-employment",
      title: "Apply",
      bodyText: `Step ${index} of 2`,
      stepLabel: `Step ${index} of 2`,
      loading: false,
      actions: [],
      links: [],
      clickables: [],
      headings: [],
      openedTabs: [],
      validationErrors: [],
      controls: [
        {
          index: 0,
          tagName: "input",
          inputType: "month",
          role: "",
          id: "start",
          name: "start",
          label: replay.question,
          groupLabel: replay.section,
          placeholder: "",
          autocomplete: "",
          required: true,
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
        },
      ],
    },
    "2026-10-26T00:00:00.000Z",
  );
}

test.each([false, true])(
  "Apply replay: a repeated section asks instead of reusing the first date (resume=%s)",
  async (resume) => {
    let occurrences = createQuestionOccurrences();
    const first = page(1);
    occurrences.observe(first);
    if (resume)
      occurrences = createQuestionOccurrences(
        JSON.parse(JSON.stringify(occurrences.snapshot())) as ReturnType<
          typeof occurrences.snapshot
        >,
      );
    const second = page(2);
    occurrences.observe(second);
    const fillText = vi.fn(),
      checkWrittenAnswer = vi.fn(() =>
        Promise.resolve({
          supported: true,
          reason: "Supported",
        }),
      );
    const config = {
      application: { jobId: "1", applicationId: "1", startingUrl: second.url! },
      siteLabel: "Replica",
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
          yearsExperience: 7,
          baseResume: {
            id: "synthetic",
            fileName: "synthetic.txt",
            uploadedAt: "2026-10-26T00:00:00.000Z",
            textContent: "Synthetic applicant",
          },
        }),
        resumeText: null,
        posting: {
          title: "Engineer",
          company: "Example",
          location: "Remote",
          description: "Synthetic",
        },
        documents: [],
        reusableAnswers: [
          {
            id: "first-entry",
            kind: "other",
            question: `${replay.section} — ${replay.question}`,
            label: "First date",
            answer: replay.firstAnswer,
            roleFamilies: [],
            proofEntryIds: [],
          },
        ],
      },
      hands: { observe: () => Promise.resolve(second), fillText },
    } as unknown as ApplyAgentConfig;
    const deps = {
      config,
      now: () => new Date(),
      guardState: createApplyGuardState(),
      checkWrittenAnswer,
    };
    const refused = await executeApplyProposal(
      { tool: "type", ref: "c0", text: replay.firstAnswer },
      second.signature,
      deps,
    );
    expect(refused).toMatchObject({
      kind: "suggestion",
      question: { repeatedAtDifferentStep: true },
    });
    expect(fillText).not.toHaveBeenCalled();
    expect(checkWrittenAnswer).not.toHaveBeenCalled();
    expect(questionPrompt(second.controls[0])).toContain("step 2");
    // A retained form keeps the same context on its next read.
    occurrences.observe(second);
    expect(questionPrompt(second.controls[0])).toContain("step 2");
  },
);
