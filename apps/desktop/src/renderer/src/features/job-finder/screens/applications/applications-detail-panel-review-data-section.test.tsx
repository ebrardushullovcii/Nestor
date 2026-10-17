// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ApplicationAnswerRecordSchema,
  ApplicationQuestionRecordSchema,
  ApplyJobResultSchema,
  ApplyRunDetailsSchema,
  ApplyRunSchema,
  CandidateAssetSchema,
} from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ApplicationsDetailPanelReviewDataSection } from "./applications-detail-panel-review-data-section";

const now = "2026-08-10T10:00:00.000Z";

function createDetails(withAnswer = false) {
  const run = ApplyRunSchema.parse({
    id: "run-1",
    mode: "copilot",
    state: "paused_for_user_review",
    jobIds: ["job-1"],
    currentJobId: "job-1",
    summary: "Prepared safely",
    detail: "Final submission remains disabled.",
    createdAt: now,
    updatedAt: now,
  });
  const result = ApplyJobResultSchema.parse({
    id: "result-1",
    runId: run.id,
    jobId: "job-1",
    applicationRecordId: "application-1",
    state: "awaiting_review",
    summary: "Review required answers",
    detail: "Nothing was submitted.",
    startedAt: now,
    updatedAt: now,
  });
  const question = ApplicationQuestionRecordSchema.parse({
    id: "question-1",
    runId: run.id,
    jobId: "job-1",
    resultId: result.id,
    prompt: "Will you require visa sponsorship?",
    kind: "visa_sponsorship",
    answerControlType: "single_choice",
    isRequired: true,
    detectedAt: now,
    answerOptions: ["Yes", "No"],
    selectedAnswerId: withAnswer ? "answer-1" : null,
    submittedAnswer: withAnswer ? "No" : null,
    status: withAnswer ? "answered" : "detected",
  });
  const answer = withAnswer
    ? ApplicationAnswerRecordSchema.parse({
        id: "answer-1",
        runId: run.id,
        jobId: "job-1",
        resultId: result.id,
        questionId: question.id,
        status: "suggested",
        text: "No",
        value: { type: "single_choice", value: "No" },
        revision: 2,
        sourceKind: "user",
        sourceId: "command-older",
        createdAt: now,
      })
    : null;
  return ApplyRunDetailsSchema.parse({
    run,
    result,
    results: [result],
    submitApproval: null,
    questionRecords: [question],
    answerRecords: answer ? [answer] : [],
    artifactRefs: [],
    checkpoints: [],
    consentRequests: [],
  });
}

describe("application question answer review", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "nestor");
  });

  it("saves an exact employer option without authorizing submission", async () => {
    const details = createDetails();
    const onSave = vi.fn(() => Promise.resolve());

    render(
      <MemoryRouter>
        <ApplicationsDetailPanelReviewDataSection
          applyRunDetailsError={null}
          applyRunDetailsStatus="ready"
          isApplyRequestPending={() => false}
          onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={onSave}
          selectedApplyRunDetails={details}
          visibleApplyResult={details.result}
        />
      </MemoryRouter>,
    );

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "Answer for Will you require visa sponsorship?",
      }),
      { target: { value: "No" } },
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /also save this exact question and answer in profile/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save prepared answer" }),
    );

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        jobId: "job-1",
        resultId: "result-1",
        questionId: "question-1",
        expectedAnswerRevision: 0,
        value: { type: "single_choice", value: "No" },
        saveScope: "reusable_profile",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
    );
  });

  it("clears only the selected answer revision and keeps safety flags false", async () => {
    const details = createDetails(true);
    const onClear = vi.fn(() => Promise.resolve());

    render(
      <MemoryRouter>
        <ApplicationsDetailPanelReviewDataSection
          applyRunDetailsError={null}
          applyRunDetailsStatus="ready"
          isApplyRequestPending={() => false}
          onClearApplicationAnswer={onClear}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() => Promise.resolve())}
          selectedApplyRunDetails={details}
          visibleApplyResult={details.result}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Clear from this application" }),
    );

    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    expect(onClear).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        jobId: "job-1",
        resultId: "result-1",
        questionId: "question-1",
        expectedAnswerRevision: 2,
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
    );
  });

  it("offers Job Finder's suggestion as one tap, and keeps the choice with the person", async () => {
    const baseDetails = createDetails();
    const details = ApplyRunDetailsSchema.parse({
      ...baseDetails,
      questionRecords: [
        {
          ...baseDetails.questionRecords[0],
          suggestedAnswers: [
            {
              id: "suggestion-1",
              text: "No",
              sourceKind: "profile",
              sourceId: "profile.workEligibility.requiresVisaSponsorship",
            },
          ],
        },
      ],
    });
    const onSave = vi.fn(() => Promise.resolve());

    render(
      <MemoryRouter>
        <ApplicationsDetailPanelReviewDataSection
          applyRunDetailsError={null}
          applyRunDetailsStatus="ready"
          isApplyRequestPending={() => false}
          onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={onSave}
          selectedApplyRunDetails={details}
          visibleApplyResult={details.result}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Job Finder suggests/i)).toBeTruthy();
    // Nothing is filled in until the person takes it.
    fireEvent.click(screen.getByRole("button", { name: "Use this answer" }));

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: "question-1",
        submitAuthorized: false,
      }),
    );
  });

  it("selects an attachment-consented asset without exposing its path", async () => {
    const baseDetails = createDetails();
    const details = ApplyRunDetailsSchema.parse({
      ...baseDetails,
      questionRecords: [
        {
          ...baseDetails.questionRecords[0],
          prompt: "Upload a portfolio",
          kind: "portfolio",
          answerControlType: "file",
          answerOptions: [],
        },
      ],
    });
    const asset = CandidateAssetSchema.parse({
      id: "asset-portfolio",
      kind: "portfolio",
      originalName: "portfolio.pdf",
      mime: "application/pdf",
      byteSize: 100,
      sha256: "a".repeat(64),
      createdAt: now,
      sensitivity: "sensitive",
      consentScope: "job_application_attachment",
      retention: "until_deleted",
    });
    const onSave = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() =>
            Promise.resolve({
              assets: [
                asset,
                {
                  ...asset,
                  id: "asset-other-job",
                  originalName: "other-job.pdf",
                  forJob: {
                    jobId: "job-other",
                    title: "Engineer",
                    company: "Cedar",
                  },
                },
                {
                  ...asset,
                  id: "asset-this-job",
                  originalName: "this-job.pdf",
                  forJob: {
                    jobId: details.result!.jobId,
                    title: "Engineer",
                    company: "Cedar",
                  },
                },
              ],
            }),
          ),
        },
      },
    });

    render(
      <MemoryRouter>
        <ApplicationsDetailPanelReviewDataSection
          applyRunDetailsError={null}
          applyRunDetailsStatus="ready"
          isApplyRequestPending={() => false}
          onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={onSave}
          selectedApplyRunDetails={details}
          visibleApplyResult={details.result}
        />
      </MemoryRouter>,
    );

    const selector = await screen.findByRole("combobox", {
      name: "Answer for Upload a portfolio",
    });
    expect(screen.queryByRole("option", { name: /other-job.pdf/ })).toBeNull();
    expect(screen.getByRole("option", { name: /this-job.pdf/ })).toBeTruthy();
    fireEvent.change(selector, { target: { value: asset.id } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save prepared answer" }),
    );

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        value: { type: "asset_ref", assetId: asset.id },
        saveScope: "application_once",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
    );
    expect(document.body.textContent).not.toContain("C:/");
  });

  it("opens the current application job in Shortlisted", () => {
    const baseDetails = createDetails();
    const details = ApplyRunDetailsSchema.parse({
      ...baseDetails,
      questionRecords: [
        {
          ...baseDetails.questionRecords[0],
          prompt: "Upload your resume",
          kind: "resume",
          answerControlType: "file",
          answerOptions: [],
        },
      ],
    });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
        },
      },
    });

    render(
      <MemoryRouter>
        <ApplicationsDetailPanelReviewDataSection
          applyRunDetailsError={null}
          applyRunDetailsStatus="ready"
          isApplyRequestPending={() => false}
          onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() => Promise.resolve())}
          selectedApplyRunDetails={details}
          visibleApplyResult={details.result}
        />
      </MemoryRouter>,
    );

    expect(
      screen
        .getByRole("link", { name: "Open this job in Shortlisted" })
        .getAttribute("href"),
    ).toBe("/job-finder/review-queue?jobId=job-1");
  });

  it("makes the saved answer retry path explicit without widening authority", () => {
    const details = createDetails(true);
    if (!details.result) throw new Error("Expected a prepared result.");
    details.result.state = "blocked";
    details.result.blockerReason = "required_human_input";

    render(
      <MemoryRouter>
        <ApplicationsDetailPanelReviewDataSection
          applyRunDetailsError={null}
          applyRunDetailsStatus="ready"
          isApplyRequestPending={() => false}
          onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() => Promise.resolve())}
          selectedApplyRunDetails={details}
          visibleApplyResult={details.result}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: "Needs you" }).getAttribute("href"),
    ).toBe("/job-finder/actions");
    expect(
      screen.getByText(
        /When all required answers are saved, this application continues in its chosen apply mode/i,
      ),
    ).toBeTruthy();
  });

  it("does not send an already prepared application back to Needs you for its saved answer", () => {
    const details = createDetails(true);
    render(
      <MemoryRouter>
        <ApplicationsDetailPanelReviewDataSection
          applyRunDetailsError={null}
          applyRunDetailsStatus="ready"
          isApplyRequestPending={() => false}
          onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
          onResolveApplyConsentRequest={vi.fn()}
          onSaveApplicationAnswer={vi.fn(() => Promise.resolve())}
          selectedApplyRunDetails={details}
          visibleApplyResult={details.result}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/Answer saved for this exact application/),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Needs you" })).toBeNull();
    expect(screen.queryByText(/choose Done/)).toBeNull();
  });

  function renderManualFollowUp(input: {
    blockerReason: "auth_required" | "signup_consent_required";
    label: string;
  }) {
    const onResolveApplyConsentRequest = vi.fn();
    const baseDetails = createDetails(true);
    const details = ApplyRunDetailsSchema.parse({
      ...baseDetails,
      run: { ...baseDetails.run, state: "paused_for_consent" },
      result: {
        ...baseDetails.result,
        blockerReason: input.blockerReason,
        blockerSummary: input.label,
      },
      consentRequests: [
        {
          id: "consent-gate",
          runId: baseDetails.run.id,
          jobId: "job-1",
          applicationRecordId: "application-1",
          linkedConsentKind: "manual_follow_up",
          label: input.label,
          detail:
            "The runtime paused without making this decision on the user's behalf.",
          requestedAt: now,
        },
      ],
    });

    render(
      <MemoryRouter>
        <ApplicationsDetailPanelReviewDataSection
          applyRunDetailsError={null}
          applyRunDetailsStatus="ready"
          isApplyRequestPending={() => false}
          onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
          onResolveApplyConsentRequest={onResolveApplyConsentRequest}
          onSaveApplicationAnswer={vi.fn(() => Promise.resolve())}
          selectedApplyRunDetails={details}
          visibleApplyResult={details.result}
        />
      </MemoryRouter>,
    );
    return onResolveApplyConsentRequest;
  }

  it("never offers to approve a sign-in gate, which cannot be approved away", () => {
    // "Continue safely" on a login wall marked the application ready and
    // changed the next step to "Submit the prepared application manually" —
    // for a form that was never filled, because the run stopped at the gate.
    const onResolve = renderManualFollowUp({
      blockerReason: "auth_required",
      label: "The application requires an authenticated account.",
    });
    expect(
      screen.queryByRole("button", { name: "Continue safely" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip this job" })).toBeNull();
    expect(
      screen.getByText(/website asking you to sign in, not a choice/i),
    ).toBeTruthy();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("keeps the decision buttons for a manual follow-up that is a real choice", () => {
    // The catalog runtime raises the same consent kind for sign-up and
    // account-choice decisions, which the user can and should answer here.
    renderManualFollowUp({
      blockerReason: "signup_consent_required",
      label: "Choose whether to continue through an existing-account path",
    });
    expect(
      screen.getByRole("button", { name: "Continue safely" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip this job" })).toBeTruthy();
    expect(screen.queryByText(/asking you to sign in/i)).toBeNull();
  });

  it("explains consent requests as one view of the same paused preparation shown in Needs you", () => {
    const onResolveApplyConsentRequest = vi.fn();
    const baseDetails = createDetails(true);
    const details = ApplyRunDetailsSchema.parse({
      ...baseDetails,
      run: { ...baseDetails.run, state: "paused_for_consent" },
      consentRequests: [
        {
          id: "consent-1",
          runId: baseDetails.run.id,
          jobId: "job-1",
          applicationRecordId: "application-1",
          label: "Manual verification on the employer site",
          detail: "Job Finder paused before a step that needs you.",
          requestedAt: now,
        },
      ],
    });

    render(
      <MemoryRouter>
        <ApplicationsDetailPanelReviewDataSection
          applyRunDetailsError={null}
          applyRunDetailsStatus="ready"
          isApplyRequestPending={() => false}
          onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
          onResolveApplyConsentRequest={onResolveApplyConsentRequest}
          onSaveApplicationAnswer={vi.fn(() => Promise.resolve())}
          selectedApplyRunDetails={details}
          visibleApplyResult={details.result}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(/two views of the same paused preparation/i),
    ).toBeTruthy();
    expect(screen.getByText(/also clears it in\s*Needs you/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue safely" }));
    expect(onResolveApplyConsentRequest).toHaveBeenCalledWith({
      requestId: "consent-1",
      runId: "run-1",
      jobId: "job-1",
      applicationRecordId: "application-1",
      action: "approve",
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip this job" }));
    expect(onResolveApplyConsentRequest).toHaveBeenCalledWith({
      requestId: "consent-1",
      runId: "run-1",
      jobId: "job-1",
      applicationRecordId: "application-1",
      action: "decline",
    });

    expect(document.body.textContent ?? "").not.toMatch(
      /submit approval|apply copilot|restage/i,
    );
  });

  it("renders every prepared-answer control with canonical field tokens and focus", async () => {
    const canonicalFieldTokens = [
      "border-(--field-border)",
      "bg-(--field)",
      "outline-none",
      "focus-visible:border-(--field-focus-border)",
      "focus-visible:bg-(--field-strong)",
      "focus-visible:shadow-[var(--field-focus-shadow)]",
    ];
    const expectCanonicalField = (
      control: Element,
      geometry: readonly string[],
    ) => {
      for (const token of canonicalFieldTokens) {
        expect(control.className).toContain(token);
      }
      expect(control.className).not.toContain("border-input");
      expect(control.className).not.toContain("focus-visible:ring");
      for (const token of geometry) {
        expect(control.className).toContain(token);
      }
    };
    const renderSection = (details: ReturnType<typeof createDetails>) =>
      render(
        <MemoryRouter>
          <ApplicationsDetailPanelReviewDataSection
            applyRunDetailsError={null}
            applyRunDetailsStatus="ready"
            isApplyRequestPending={() => false}
            onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
            onResolveApplyConsentRequest={vi.fn()}
            onSaveApplicationAnswer={vi.fn(() => Promise.resolve())}
            selectedApplyRunDetails={details}
            visibleApplyResult={details.result}
          />
        </MemoryRouter>,
      );
    const detailsWithControl = (questionOverrides: Record<string, unknown>) => {
      const baseDetails = createDetails();
      const [baseQuestion] = baseDetails.questionRecords;
      return ApplyRunDetailsSchema.parse({
        ...baseDetails,
        questionRecords: [
          {
            ...baseQuestion,
            prompt: "Field token probe",
            ...questionOverrides,
          },
        ],
      });
    };

    for (const answerControlType of ["single_choice", "boolean"]) {
      const view = renderSection(detailsWithControl({ answerControlType }));
      expect(view.container.querySelectorAll("select")).toHaveLength(1);
      expectCanonicalField(view.container.querySelector("select")!, [
        "h-11",
        "w-full",
      ]);
      view.unmount();
    }

    const dateView = renderSection(
      detailsWithControl({ answerControlType: "date" }),
    );
    expectCanonicalField(
      dateView.container.querySelector("input[type='date']")!,
      ["h-11", "w-full"],
    );
    dateView.unmount();

    const textView = renderSection(
      detailsWithControl({ answerControlType: "text" }),
    );
    expectCanonicalField(textView.container.querySelector("textarea")!, [
      "min-h-24",
      "resize-y",
    ]);
    textView.unmount();

    // Multi-choice without employer options falls back to a textarea.
    const multiChoiceView = renderSection(
      detailsWithControl({
        answerControlType: "multi_choice",
        answerOptions: [],
      }),
    );
    expectCanonicalField(multiChoiceView.container.querySelector("textarea")!, [
      "min-h-20",
      "resize-y",
    ]);
    multiChoiceView.unmount();

    // File answers select an approved attachment-consented asset.
    const asset = CandidateAssetSchema.parse({
      id: "asset-tokens",
      kind: "portfolio",
      originalName: "portfolio.pdf",
      mime: "application/pdf",
      byteSize: 100,
      sha256: "b".repeat(64),
      createdAt: now,
      sensitivity: "sensitive",
      consentScope: "job_application_attachment",
      retention: "until_deleted",
    });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() =>
            Promise.resolve({ assets: [asset] }),
          ),
        },
      },
    });
    const fileView = renderSection(
      detailsWithControl({ answerControlType: "file" }),
    );
    await waitFor(() =>
      expect(fileView.container.querySelector("select")).toBeTruthy(),
    );
    expectCanonicalField(fileView.container.querySelector("select")!, [
      "h-11",
      "w-full",
    ]);
    fileView.unmount();
  });
});
