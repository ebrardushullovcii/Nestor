import type {
  ApplicationAnswerRecord,
  ApplicationAnswerValue,
  ApplicationQuestionRecord,
  ApplyRunDetails,
  BrowserVisualEvidenceSummary,
  CandidateAsset,
  ClearApplicationAnswerCommandInput,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderApplyConsentActionInput,
  SaveApplicationAnswerCommandInput,
} from "@nestor/contracts";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@renderer/lib/cn";
import { APPLICATION_DETAIL_FACT_LABEL_CLASS } from "./applications-detail-fact-strip";
import { Button } from "@renderer/components/ui";
import {
  formatTimestamp,
  formatStatusLabel,
} from "@renderer/features/job-finder/lib/job-finder-utils";
import { StatusBadge } from "../../components/status-badge";
import { formatQuestionPrompt } from "./applications-recovery-state";
import {
  ExternalUrlLink,
  SavedFileLink,
} from "../../components/open-outside-links";
import { CANDIDATE_ASSETS_CHANGED_EVENT } from "./applications-application-documents";
import {
  getAnswerTone,
  getApplyDetailsStatusBadge,
  getConsentTone,
} from "./applications-detail-panel-helpers";
import { buildJobFinderContextRoute } from "../../lib/job-finder-context-navigation";
import {
  inferFileKindForQuestion,
  profileFilesHref,
} from "../../lib/job-finder-route-hrefs";
import { getJobFinderDateInputLocale } from "../../lib/job-finder-date-input-locale";

const jobFinderDateInputLocale = getJobFinderDateInputLocale();

export function ApplicationsDetailPanelReviewDataSection(props: {
  applyRunDetailsError: string | null;
  applyRunDetailsStatus: "idle" | "loading" | "ready" | "error";
  isApplyRequestPending: (requestId: string) => boolean;
  onResolveApplyConsentRequest: (
    input: JobFinderApplyConsentActionInput,
  ) => void;
  onSaveApplicationAnswer: (
    command: SaveApplicationAnswerCommandInput,
  ) => Promise<void>;
  onClearApplicationAnswer: (
    command: ClearApplicationAnswerCommandInput,
  ) => Promise<void>;
  selectedApplyRunDetails: ApplyRunDetails | null;
  visibleApplyResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null;
}) {
  const {
    applyRunDetailsError,
    applyRunDetailsStatus,
    isApplyRequestPending,
    onResolveApplyConsentRequest,
    onSaveApplicationAnswer,
    onClearApplicationAnswer,
    selectedApplyRunDetails,
    visibleApplyResult,
  } = props;
  const applyDetailsStatusBadge = getApplyDetailsStatusBadge(
    applyRunDetailsStatus,
  );
  const resultVisualCheckpointCount =
    selectedApplyRunDetails?.result?.visualCheckpoints.length ?? 0;
  // Every replay checkpoint is also mirrored into the artifact refs with the
  // same label, so the disclosure printed the identical two entries twice
  // with the same URL under two different headings.
  const retainedArtifacts = (
    selectedApplyRunDetails?.artifactRefs ?? []
  ).filter((artifact) => artifact.kind !== "checkpoint");

  // Counts the person can open below, in words: recorded steps and visual
  // evidence are internal bookkeeping and read as "1 STEPS RECORDED".
  const recordedMetrics = (
    [
      {
        label: ["question", "questions"],
        value: Math.max(
          selectedApplyRunDetails?.questionRecords.length ?? 0,
          selectedApplyRunDetails?.reviewCard?.answers.length ?? 0,
        ),
      },
      {
        label: ["answer filled in", "answers filled in"],
        value: Math.max(
          selectedApplyRunDetails?.answerRecords.filter(
            (answer) => answer.status === "filled",
          ).length ?? 0,
          selectedApplyRunDetails?.reviewCard?.answers.filter((answer) =>
            answer.answer.trim(),
          ).length ?? 0,
        ),
      },
      { label: ["file", "files"], value: retainedArtifacts.length },
      {
        label: ["screenshot", "screenshots"],
        value: resultVisualCheckpointCount,
      },
    ] as const
  )
    .filter((metric) => metric.value > 0)
    .map((metric) => ({
      label: metric.value === 1 ? metric.label[0] : metric.label[1],
      value: metric.value,
    }));

  if (!visibleApplyResult) {
    return null;
  }

  const visibleApplyResultJobId = visibleApplyResult.jobId;

  return (
    <section className="surface-card-tint grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className={cn(APPLICATION_DETAIL_FACT_LABEL_CLASS, "text-primary")}>
          What Job Finder filled in
        </h3>
        <StatusBadge tone={applyDetailsStatusBadge.tone}>
          {applyDetailsStatusBadge.label}
        </StatusBadge>
      </div>
      {applyRunDetailsStatus === "loading" ? (
        <p className="text-(length:--text-body) leading-7 text-foreground-soft">
          Loading what Job Finder filled in on this application.
        </p>
      ) : null}
      {applyRunDetailsStatus === "error" ? (
        <p className="text-(length:--text-body) leading-7 text-destructive">
          {applyRunDetailsError ??
            "This application's details could not be loaded. Try again."}
        </p>
      ) : null}
      {selectedApplyRunDetails ? (
        <>
          {/* Six counters, five of them zero, and a "0 artifacts" beside an
              approval banner that had just promised a created and verified
              PDF. A run that recorded nothing says so in one sentence; only
              counts that stand for something the user can open are shown. */}
          {recordedMetrics.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {recordedMetrics.map((metric) => (
                <MetricCard
                  key={metric.label}
                  label={metric.label}
                  value={metric.value}
                />
              ))}
            </div>
          ) : (
            <p className="text-(length:--text-body) leading-7 text-foreground-soft">
              This run stopped before it recorded any questions, answers, or
              artifacts. Your approved resume PDF is unaffected and stays in
              Resume Studio.
            </p>
          )}
          {selectedApplyRunDetails.result?.visualCheckpoints.length ? (
            <div className="grid gap-2">
              <p className={APPLICATION_DETAIL_FACT_LABEL_CLASS}>Screenshots of the form</p>
              {selectedApplyRunDetails.result.visualCheckpoints.map(
                (checkpoint) => (
                  <div
                    key={checkpoint.id}
                    className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3 text-(length:--text-small) leading-6 text-foreground-soft"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-foreground">
                        {checkpoint.label}
                      </strong>
                      <StatusBadge
                        tone={checkpoint.retained ? "positive" : "neutral"}
                      >
                        {checkpoint.retained ? "Retained" : "Temporary"}
                      </StatusBadge>
                    </div>
                    <p className="mt-2">{checkpoint.summary}</p>
                    {checkpoint.blockers.length ? (
                      <p className="mt-2">
                        Blockers: {checkpoint.blockers.join("; ")}
                      </p>
                    ) : null}
                    {checkpoint.fieldControls.length ? (
                      <p className="mt-2">
                        Controls: {checkpoint.fieldControls.join("; ")}
                      </p>
                    ) : null}
                    {checkpoint.validationErrors.length ? (
                      <p className="mt-2">
                        Validation: {checkpoint.validationErrors.join("; ")}
                      </p>
                    ) : null}
                    {checkpoint.storagePath ? (
                      <p className="mt-2 break-all">
                        Saved: <SavedFileLink path={checkpoint.storagePath} />
                      </p>
                    ) : null}
                  </div>
                ),
              )}
            </div>
          ) : null}
          {selectedApplyRunDetails.questionRecords.length ? (
            <div className="grid gap-2">
              <p className={APPLICATION_DETAIL_FACT_LABEL_CLASS}>Questions on the form</p>
              {selectedApplyRunDetails.questionRecords.map((question) => {
                const latestAnswer = getLatestAnswerForQuestion(
                  selectedApplyRunDetails.answerRecords,
                  question.id,
                );
                return (
                  <div
                    key={question.id}
                    className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong>{formatQuestionPrompt(question.prompt)}</strong>
                      <StatusBadge
                        tone={
                          question.status === "submitted" ||
                          question.status === "answered"
                            ? "positive"
                            : question.status === "skipped"
                              ? // A skipped question is a fact about the run,
                                // not an alarm: amber, as a held step is.
                                "warning"
                              : "active"
                        }
                      >
                        {formatStatusLabel(question.status)}
                      </StatusBadge>
                    </div>
                    <p className="mt-2 text-(length:--text-small) leading-6 text-foreground-soft">
                      {formatStatusLabel(question.kind)}
                      {question.isRequired ? " • Required" : " • Optional"}
                    </p>
                    {question.answerOptions.length ? (
                      <p className="mt-2 text-(length:--text-small) leading-6 text-foreground-soft">
                        Options: {question.answerOptions.join(", ")}
                      </p>
                    ) : null}
                    {question.submittedAnswer ? (
                      <p className="mt-2 text-(length:--text-small) leading-6 text-foreground-soft">
                        {question.status === "submitted"
                          ? "Submitted"
                          : "Prepared answer"}
                        : {question.submittedAnswer}
                      </p>
                    ) : null}
                    {question.pageUrl ? (
                      <p className="mt-2 break-all text-(length:--text-small) leading-6 text-foreground-soft">
                        Page: <ExternalUrlLink url={question.pageUrl} />
                      </p>
                    ) : null}
                    {question.visualContext ? (
                      <VisualEvidenceSummary
                        evidence={question.visualContext}
                      />
                    ) : null}
                    {question.status !== "submitted" ? (
                      <ApplicationQuestionAnswerEditor
                        key={`${question.id}:${latestAnswer?.revision ?? 0}`}
                        answer={latestAnswer}
                        isBlocked={
                          (visibleApplyResult?.state === "blocked" ||
                            visibleApplyResult?.state === "awaiting_review") &&
                          visibleApplyResult.blockerReason ===
                            "required_human_input"
                        }
                        jobId={visibleApplyResultJobId}
                        onClear={onClearApplicationAnswer}
                        onSave={onSaveApplicationAnswer}
                        question={question}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {selectedApplyRunDetails.answerRecords.length ? (
            <div className="grid gap-2">
              <p className={APPLICATION_DETAIL_FACT_LABEL_CLASS}>Answers Job Finder filled in</p>
              {selectedApplyRunDetails.answerRecords.map((answer) => (
                <div
                  key={answer.id}
                  className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>{answer.text}</strong>
                    <StatusBadge tone={getAnswerTone(answer.status)}>
                      {formatStatusLabel(answer.status)}
                    </StatusBadge>
                  </div>
                  <p className="mt-2 text-(length:--text-small) leading-6 text-foreground-soft">
                    {formatStatusLabel(answer.sourceKind)} source
                    {answer.confidenceLabel
                      ? ` • ${answer.confidenceLabel}`
                      : ""}
                  </p>
                  {answer.provenance.length ? (
                    <div className="mt-2 grid gap-1 text-(length:--text-small) leading-6 text-foreground-soft">
                      {answer.provenance.map((provenance) => (
                        <p key={provenance.id}>
                          {provenance.label}
                          {provenance.snippet ? `: ${provenance.snippet}` : ""}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {retainedArtifacts.length ? (
            <div className="grid gap-2">
              <p className={APPLICATION_DETAIL_FACT_LABEL_CLASS}>Files Job Finder attached</p>
              {retainedArtifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3 text-(length:--text-small) leading-6 text-foreground-soft"
                >
                  <strong className="text-foreground">{artifact.label}</strong>
                  <p>{formatStatusLabel(artifact.kind)}</p>
                  {artifact.textSnippet ? <p>{artifact.textSnippet}</p> : null}
                  {artifact.storagePath ? (
                    <p className="break-all">
                      Saved: <SavedFileLink path={artifact.storagePath} />
                    </p>
                  ) : null}
                  {artifact.url ? (
                    <p className="break-all">
                      URL: <ExternalUrlLink url={artifact.url} />
                    </p>
                  ) : null}
                  {artifact.visualEvidence ? (
                    <VisualEvidenceSummary evidence={artifact.visualEvidence} />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {selectedApplyRunDetails.checkpoints.length ? (
            <div className="grid gap-2">
              <p className={APPLICATION_DETAIL_FACT_LABEL_CLASS}>Screenshots of each step</p>
              {selectedApplyRunDetails.checkpoints.map((checkpoint) => (
                <div
                  key={checkpoint.id}
                  className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3 text-(length:--text-small) leading-6 text-foreground-soft"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-foreground">
                      {checkpoint.label}
                    </strong>
                    <StatusBadge
                      tone={
                        checkpoint.jobState === "submitted"
                          ? "positive"
                          : checkpoint.jobState === "blocked" ||
                              checkpoint.jobState === "failed"
                            ? "critical"
                            : "active"
                      }
                    >
                      {formatStatusLabel(checkpoint.jobState)}
                    </StatusBadge>
                  </div>
                  {checkpoint.detail ? (
                    <p className="mt-2">{checkpoint.detail}</p>
                  ) : null}
                  <p className="mt-2">
                    {formatTimestamp(checkpoint.createdAt)}
                  </p>
                  {/* The checkpoint detail already quotes the exact target,
                      so a bare repeat printed the same long URL twice. */}
                  {checkpoint.url &&
                  !(checkpoint.detail ?? "").includes(checkpoint.url) ? (
                    <p className="mt-2 break-all">
                      <ExternalUrlLink url={checkpoint.url} />
                    </p>
                  ) : null}
                  {checkpoint.visualEvidence.length ? (
                    <div className="mt-2 grid gap-1">
                      {checkpoint.visualEvidence.map((evidence) => (
                        <VisualEvidenceSummary
                          key={`${evidence.snapshotId}:${evidence.observationSetId}`}
                          evidence={evidence}
                        />
                      ))}
                    </div>
                  ) : null}
                  {checkpoint.visualReconciliations.length ? (
                    <div className="mt-2 grid gap-1">
                      {checkpoint.visualReconciliations.map(
                        (reconciliation) => (
                          <p key={reconciliation.id}>
                            Visual reconciliation:{" "}
                            {formatStatusLabel(reconciliation.status)}
                            {reconciliation.visualSummary
                              ? ` • ${reconciliation.visualSummary}`
                              : ""}
                          </p>
                        ),
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {selectedApplyRunDetails.consentRequests.length ? (
            <div className="grid gap-2">
              <p className={APPLICATION_DETAIL_FACT_LABEL_CLASS}>Consent requests</p>
              <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                Consent requests and the Needs you list are two views of the
                same paused preparation. Resolving it here also clears it in
                Needs you.
              </p>
              {selectedApplyRunDetails.consentRequests.map((request) => (
                <div
                  key={request.id}
                  className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3 text-(length:--text-small) leading-6 text-foreground-soft"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-foreground">{request.label}</strong>
                    <StatusBadge tone={getConsentTone(request.status)}>
                      {formatStatusLabel(request.status)}
                    </StatusBadge>
                  </div>
                  <p className="mt-2">{formatStatusLabel(request.kind)}</p>
                  {request.detail ? (
                    <p className="mt-2">{request.detail}</p>
                  ) : null}
                  {request.status === "pending" &&
                  request.linkedConsentKind === "manual_follow_up" &&
                  visibleApplyResult.blockerReason === "auth_required" ? (
                    // A sign-in wall is not a decision about the user's data:
                    // approving it here cannot sign them in, and marking it
                    // approved would report an application as prepared that
                    // was never filled. Only the sign-in wall is gated on:
                    // the same consent kind also carries real decisions
                    // (sign-up, account choice, unsupported answers) from the
                    // catalog runtime, and those keep their buttons.
                    <p className="mt-3 text-(length:--text-small) leading-6 text-foreground-soft">
                      This is the website asking you to sign in, not a choice
                      about your data. Use the sign-in step above to finish it,
                      then run preparation again.
                    </p>
                  ) : request.status === "pending" &&
                    selectedApplyRunDetails.run.state ===
                      "paused_for_consent" ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        onClick={() => {
                          if (!request.applicationRecordId) return;
                          onResolveApplyConsentRequest({
                            requestId: request.id,
                            runId: request.runId,
                            jobId: request.jobId,
                            applicationRecordId: request.applicationRecordId,
                            action: "approve",
                          });
                        }}
                        pending={isApplyRequestPending(request.id)}
                        type="button"
                        variant="secondary"
                        disabled={
                          isApplyRequestPending(request.id) ||
                          request.applicationRecordId === null
                        }
                      >
                        Continue safely
                      </Button>
                      <Button
                        onClick={() => {
                          if (!request.applicationRecordId) return;
                          onResolveApplyConsentRequest({
                            requestId: request.id,
                            runId: request.runId,
                            jobId: request.jobId,
                            applicationRecordId: request.applicationRecordId,
                            action: "decline",
                          });
                        }}
                        pending={isApplyRequestPending(request.id)}
                        type="button"
                        variant="ghost"
                        disabled={
                          isApplyRequestPending(request.id) ||
                          request.applicationRecordId === null
                        }
                      >
                        Skip this job
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function getLatestAnswerForQuestion(
  answerRecords: readonly ApplicationAnswerRecord[],
  questionId: string,
): ApplicationAnswerRecord | null {
  return (
    answerRecords
      .filter((answer) => answer.questionId === questionId)
      .sort(
        (left, right) =>
          right.revision - left.revision ||
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.id.localeCompare(left.id),
      )[0] ?? null
  );
}

function createApplicationAnswerCommandId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomUUID()}`;
}

function ApplicationQuestionAnswerEditor(props: {
  answer: ApplicationAnswerRecord | null;
  isBlocked: boolean;
  jobId: string;
  onClear: (command: ClearApplicationAnswerCommandInput) => Promise<void>;
  onSave: (command: SaveApplicationAnswerCommandInput) => Promise<void>;
  question: ApplicationQuestionRecord;
}) {
  const { answer, jobId, onClear, onSave, question } = props;
  const activeAnswer = answer?.status === "rejected" ? null : answer;
  const initialValue =
    activeAnswer?.value?.type === "boolean"
      ? String(activeAnswer.value.value)
      : activeAnswer?.value?.type === "text" ||
          activeAnswer?.value?.type === "single_choice" ||
          activeAnswer?.value?.type === "date"
        ? activeAnswer.value.value
        : (activeAnswer?.text ?? "");
  const initialSelectedValues =
    activeAnswer?.value?.type === "multi_choice"
      ? activeAnswer.value.values
      : [];
  const [value, setValue] = useState(initialValue);
  const [selectedValues, setSelectedValues] = useState<string[]>([
    ...initialSelectedValues,
  ]);
  // Free-text choices keep the raw text so a space or comma typed between two
  // choices is not swallowed before the next one is typed.
  const [choicesText, setChoicesText] = useState(
    initialSelectedValues.join(", "),
  );
  const [selectedAssetId, setSelectedAssetId] = useState(
    activeAnswer?.value?.type === "asset_ref" ? activeAnswer.value.assetId : "",
  );
  const [candidateAssets, setCandidateAssets] = useState<
    readonly CandidateAsset[]
  >([]);
  const [candidateAssetStatus, setCandidateAssetStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [saveForFuture, setSaveForFuture] = useState(
    activeAnswer?.saveScope === "reusable_profile",
  );
  const [status, setStatus] = useState<"idle" | "saving" | "clearing">("idle");
  const [error, setError] = useState<string | null>(null);
  const normalizedOptions = useMemo(
    () => Array.from(new Set(question.answerOptions)),
    [question.answerOptions],
  );
  const suggestedAnswer = question.suggestedAnswers[0]?.text.trim() ?? null;

  useEffect(() => {
    setValue(initialValue);
    setSelectedValues(
      activeAnswer?.value?.type === "multi_choice"
        ? [...activeAnswer.value.values]
        : [],
    );
    setSelectedAssetId(
      activeAnswer?.value?.type === "asset_ref"
        ? activeAnswer.value.assetId
        : "",
    );
    setSaveForFuture(activeAnswer?.saveScope === "reusable_profile");
    setError(null);
  }, [
    activeAnswer?.id,
    activeAnswer?.saveScope,
    activeAnswer?.value,
    initialValue,
  ]);

  useEffect(() => {
    if (question.answerControlType !== "file") {
      return;
    }
    let active = true;
    const loadCandidateAssets = () => {
      setCandidateAssetStatus("loading");
      void window.nestor.jobFinder
        .listCandidateAssets({ includeDeleted: false })
        .then((result) => {
          if (!active) return;
          setCandidateAssets(
            result.assets.filter(
              (asset) =>
                asset.consentScope === "job_application_attachment" &&
                asset.deletedAt === null &&
                (asset.forJob === null ||
                  asset.forJob.jobId === question.jobId),
            ),
          );
          setCandidateAssetStatus("ready");
        })
        .catch(() => {
          if (active) setCandidateAssetStatus("error");
        });
    };
    loadCandidateAssets();
    window.addEventListener(
      CANDIDATE_ASSETS_CHANGED_EVENT,
      loadCandidateAssets,
    );
    return () => {
      active = false;
      window.removeEventListener(
        CANDIDATE_ASSETS_CHANGED_EVENT,
        loadCandidateAssets,
      );
    };
  }, [question.answerControlType, question.jobId]);

  async function handleSave() {
    const trimmedValue = value.trim();
    let answerValue: ApplicationAnswerValue;
    switch (question.answerControlType) {
      case "single_choice":
        if (!trimmedValue) {
          setError("Choose an employer-provided option before saving it.");
          return;
        }
        answerValue = { type: "single_choice", value: trimmedValue };
        break;
      case "multi_choice":
        if (selectedValues.length === 0) {
          setError("Choose at least one employer-provided option.");
          return;
        }
        answerValue = { type: "multi_choice", values: selectedValues };
        break;
      case "boolean":
        if (value !== "true" && value !== "false") {
          setError("Choose Yes or No before saving this answer.");
          return;
        }
        answerValue = { type: "boolean", value: value === "true" };
        break;
      case "date":
        if (!trimmedValue) {
          setError("Choose a date before saving this answer.");
          return;
        }
        answerValue = { type: "date", value: trimmedValue };
        break;
      case "file":
        if (!selectedAssetId) {
          setError(
            "Choose an approved document or image from the asset library before saving this file answer.",
          );
          return;
        }
        answerValue = { type: "asset_ref", assetId: selectedAssetId };
        break;
      case "text":
        if (!trimmedValue) {
          setError("Enter an answer before saving it.");
          return;
        }
        answerValue = { type: "text", value: trimmedValue };
        break;
    }
    setStatus("saving");
    setError(null);
    try {
      await onSave({
        commandId: createApplicationAnswerCommandId("save_answer"),
        runId: question.runId,
        jobId: question.jobId,
        resultId: question.resultId ?? "",
        questionId: question.id,
        expectedAnswerRevision: answer?.revision ?? 0,
        value: answerValue,
        saveScope: saveForFuture ? "reusable_profile" : "application_once",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The answer could not be saved.",
      );
    } finally {
      setStatus("idle");
    }
  }

  async function handleClear() {
    if (!answer || answer.status === "rejected") {
      return;
    }
    setStatus("clearing");
    setError(null);
    try {
      await onClear({
        commandId: createApplicationAnswerCommandId("clear_answer"),
        runId: question.runId,
        jobId: question.jobId,
        resultId: question.resultId ?? "",
        questionId: question.id,
        expectedAnswerRevision: answer.revision,
        submitAuthorized: false,
        accountCreationAuthorized: false,
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The answer could not be cleared.",
      );
    } finally {
      setStatus("idle");
    }
  }

  const isPending = status !== "idle";
  const hasSavableValue = (() => {
    switch (question.answerControlType) {
      case "multi_choice":
        return selectedValues.length > 0;
      case "boolean":
        return value === "true" || value === "false";
      case "file":
        return question.kind !== "resume" && selectedAssetId.length > 0;
      case "single_choice":
      case "date":
      case "text":
        return value.trim().length > 0;
    }
  })();
  const canSave = Boolean(question.resultId) && hasSavableValue;
  return (
    <div className="mt-3 grid gap-3 rounded-(--radius-field) border border-border/30 bg-background/55 p-3">
      <div>
        <p className={APPLICATION_DETAIL_FACT_LABEL_CLASS}>Your prepared answer</p>
        <p className="mt-1 text-(length:--text-small) leading-6 text-foreground-soft">
          {props.isBlocked
            ? "When all required answers are saved, this application continues in its chosen apply mode."
            : "Review and save this for the exact application. Saving does not send it."}
        </p>
      </div>
      {/* Job Finder stopped here because it could not answer honestly, but it
          often has a plausible answer from your own profile. Offering it as one
          tap is faster than retyping, and it stays your choice. */}
      {suggestedAnswer && question.answerControlType !== "file" ? (
        <div className="grid gap-2 rounded-(--radius-field) border border-border/30 bg-background/40 p-3">
          <p className="text-(length:--text-small) leading-6 text-foreground-soft">
            Job Finder suggests:{" "}
            <strong className="text-foreground">{suggestedAnswer}</strong>
          </p>
          <div>
            <Button
              disabled={isPending || value.trim() === suggestedAnswer}
              onClick={() => setValue(suggestedAnswer)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Use this answer
            </Button>
          </div>
        </div>
      ) : null}
      {question.answerControlType === "single_choice" ? (
        <select
          aria-label={`Answer for ${question.prompt}`}
          className="h-11 w-full rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
          disabled={isPending}
          onChange={(event) => setValue(event.target.value)}
          value={value}
        >
          <option value="">Choose an employer-provided option</option>
          {normalizedOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : question.answerControlType === "multi_choice" ? (
        normalizedOptions.length > 0 ? (
          <fieldset className="grid gap-2">
            <legend className="sr-only">Answer for {question.prompt}</legend>
            {normalizedOptions.map((option) => (
              <label
                key={option}
                className="flex items-center gap-2 text-(length:--text-small) text-foreground"
              >
                <input
                  checked={selectedValues.includes(option)}
                  disabled={isPending}
                  onChange={(event) =>
                    setSelectedValues((current) =>
                      event.target.checked
                        ? [...current, option]
                        : current.filter((entry) => entry !== option),
                    )
                  }
                  type="checkbox"
                />
                {option}
              </label>
            ))}
          </fieldset>
        ) : (
          <textarea
            aria-label={`Answer for ${question.prompt}`}
            className="min-h-20 w-full resize-y rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 py-2 text-(length:--text-small) leading-6 text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            disabled={isPending}
            onChange={(event) => {
              setChoicesText(event.target.value);
              setSelectedValues(
                event.target.value
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean),
              );
            }}
            placeholder="Enter comma-separated choices exactly as shown"
            value={choicesText}
          />
        )
      ) : question.answerControlType === "boolean" ? (
        <select
          aria-label={`Answer for ${question.prompt}`}
          className="h-11 w-full rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
          disabled={isPending}
          onChange={(event) => setValue(event.target.value)}
          value={value}
        >
          <option value="">Choose Yes or No</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : question.answerControlType === "date" ? (
        <input
          aria-label={`Answer for ${question.prompt}`}
          className="h-11 w-full rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
          disabled={isPending}
          onChange={(event) => setValue(event.target.value)}
          lang={jobFinderDateInputLocale}
          type="date"
          value={value}
        />
      ) : question.answerControlType === "file" ? (
        <div className="grid gap-2">
          {question.kind === "resume" ? (
            <p className="rounded-(--radius-field) border border-dashed border-border/50 px-3 py-3 text-(length:--text-small) leading-6 text-foreground-soft">
              Resume uploads use the approved resume selected for this job.
              Return to Shortlisted to change its resume mode or approved
              export.
            </p>
          ) : candidateAssetStatus === "loading" ? (
            <p className="text-(length:--text-small) text-foreground-soft">
              Loading your files…
            </p>
          ) : candidateAssetStatus === "error" ? (
            <p className="text-(length:--text-small) text-destructive">
              Your files could not be loaded. Open Profile › Files and try
              again.
            </p>
          ) : candidateAssets.length > 0 ? (
            <select
              aria-label={`Answer for ${question.prompt}`}
              className="h-11 w-full rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
              disabled={isPending}
              onChange={(event) => setSelectedAssetId(event.target.value)}
              value={selectedAssetId}
            >
              <option value="">Choose a file</option>
              {candidateAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.originalName} · {formatStatusLabel(asset.kind)}
                </option>
              ))}
            </select>
          ) : (
            <p className="rounded-(--radius-field) border border-dashed border-border/50 px-3 py-3 text-(length:--text-small) leading-6 text-foreground-soft">
              You have not added any files yet. Add one under Profile › Files.
            </p>
          )}
          <Link
            className="text-(length:--text-small) font-semibold text-foreground underline underline-offset-4"
            to={
              question.kind === "resume"
                ? buildJobFinderContextRoute("/job-finder/review-queue", {
                    jobId,
                  })
                : profileFilesHref(inferFileKindForQuestion(question))
            }
          >
            {question.kind === "resume"
              ? "Open this job in Shortlisted"
              : "Open your files in Profile"}
          </Link>
        </div>
      ) : (
        <textarea
          aria-label={`Answer for ${question.prompt}`}
          className="min-h-24 w-full resize-y rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 py-2 text-(length:--text-small) leading-6 text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
          disabled={isPending}
          maxLength={4_000}
          onChange={(event) => setValue(event.target.value)}
          value={value}
        />
      )}
      {question.answerControlType !== "file" ? (
        <label className="flex items-start gap-2 text-(length:--text-small) leading-6 text-foreground-soft">
          <input
            checked={saveForFuture}
            className="mt-1 size-4"
            disabled={isPending}
            onChange={(event) => setSaveForFuture(event.target.checked)}
            type="checkbox"
          />
          Also save this exact question and answer in Profile for future
          applications
        </label>
      ) : null}
      {error ? (
        <p
          className="text-(length:--text-small) leading-6 text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={isPending || !canSave}
          onClick={() => void handleSave()}
          pending={status === "saving"}
          size="compact"
          type="button"
          variant="secondary"
        >
          Save prepared answer
        </Button>
        {activeAnswer ? (
          <Button
            disabled={
              isPending ||
              !question.resultId ||
              (question.answerControlType === "file" &&
                (question.kind === "resume" || !selectedAssetId))
            }
            onClick={() => void handleClear()}
            pending={status === "clearing"}
            size="compact"
            type="button"
            variant="ghost"
          >
            Clear from this application
          </Button>
        ) : null}
      </div>
      {activeAnswer ? (
        <p className="text-(length:--text-small) leading-6 text-foreground-soft">
          Answer saved for this exact application.
          {props.isBlocked ? (
            <>
              {" "}
              Complete any remaining required answers here or in{" "}
              <Link
                className="font-semibold text-foreground underline underline-offset-4"
                to="/job-finder/actions"
              >
                Needs you
              </Link>
              . The application then continues in its chosen apply mode.
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function VisualEvidenceSummary(props: {
  evidence: BrowserVisualEvidenceSummary;
}) {
  const { evidence } = props;

  return (
    <p className="mt-2 break-words text-(length:--text-small) leading-6 text-foreground-soft">
      Visual evidence: {evidence.summary} •{" "}
      {formatStatusLabel(evidence.retention)}
      {evidence.storagePath ? (
        <>
          {" • "}
          <SavedFileLink path={evidence.storagePath} />
        </>
      ) : null}
    </p>
  );
}

/**
 * Six counts, most of them zero, previously took a full-width ~80px card
 * each inside a disclosure that exists to hold small facts. One wrapping
 * row of value/label pairs carries the same numbers in a fraction of the
 * height.
 */
function MetricCard(props: { label: string; value: number }) {
  const { label, value } = props;

  return (
    <div className="flex min-w-0 items-baseline gap-1.5 rounded-(--radius-chip) border border-(--surface-panel-border) bg-background/40 px-2.5 py-1">
      <strong className="text-(length:--text-field) font-semibold text-foreground">
        {value}
      </strong>
      <span className="text-(length:--text-small) text-foreground-soft">
        {label}
      </span>
    </div>
  );
}
