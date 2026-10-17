import { withPersonAnswerSources } from "./application-review-source";
import { ApplicationsDisclosureSummary } from "./applications-disclosure-summary";
import type {
  ApplicationAttemptListRow,
  ApplicationRecord,
  ApplyRunDetails,
  ClearApplicationAnswerCommandInput,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderApplyConsentActionInput,
  JobFinderApplyRunDetailsQuery,
  SaveApplicationAnswerCommandInput,
} from "@nordri/contracts";
import { ApplicationsDetailPanelAttemptSection } from "./applications-detail-panel-attempt-section";
import { ApplicationsDetailPanelPrivacyReceiptSection } from "./applications-detail-panel-privacy-receipt-section";
import { ApplicationsDetailPanelReviewDataSection } from "./applications-detail-panel-review-data-section";
import { ApplicationsReviewCard } from "./applications-review-card";
import { ApplicationsDetailPanelRunHistorySection } from "./applications-detail-panel-run-history-section";
import { ApplicationsDetailPanelTimelineSection } from "./applications-detail-panel-timeline-section";

export function ApplicationsDetailPanelActivitySections(props: {
  applyRunDetailsError: string | null;
  applyRunDetailsStatus: "idle" | "loading" | "ready" | "error";
  applyRunHistory: Array<{
    result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];
    run: JobFinderRendererWorkspaceSnapshot["applyRuns"][number] | null;
  }>;
  isApplyRequestPending: (requestId: string) => boolean;
  onExportApplicationPacket: (
    input: JobFinderApplyRunDetailsQuery,
  ) => Promise<void>;
  onResolveSubmissionOutcome?: (
    uncertainOutcomeId: string,
    resolution: "submitted" | "not_submitted",
  ) => Promise<void>;
  onSaveApplicationAnswer: (
    command: SaveApplicationAnswerCommandInput,
  ) => Promise<void>;
  onClearApplicationAnswer: (
    command: ClearApplicationAnswerCommandInput,
  ) => Promise<void>;
  onResolveApplyConsentRequest: (
    input: JobFinderApplyConsentActionInput,
  ) => void;
  onSelectApplyRun: (runId: string) => void;
  /**
   * Sends this application. Present only when the person chose to look it over
   * before it goes, which is the only way this button ever appears.
   */
  onSubmitPreparedApplication?: (jobId: string) => Promise<void>;
  /** Prepares the application again when its page is no longer open. */
  onPrepareApplicationAgain?: (jobId: string) => Promise<void>;
  /** True when this application is filled in and waiting on their decision. */
  awaitsYourReview?: boolean;
  onOpenApplicationPage?: (() => Promise<void>) | undefined;
  /** True when the browser no longer holds the page this was filled in on. */
  applicationPageClosed?: boolean;
  selectedApplyRunDetails: ApplyRunDetails | null;
  selectedApplyRunId: string | null;
  selectedAttempt: ApplicationAttemptListRow | null;
  selectedRecord: ApplicationRecord;
  visibleApplyResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null;
}) {
  const {
    applyRunDetailsError,
    applyRunDetailsStatus,
    applyRunHistory,
    isApplyRequestPending,
    onExportApplicationPacket,
    onResolveSubmissionOutcome,
    onSaveApplicationAnswer,
    onClearApplicationAnswer,
    onResolveApplyConsentRequest,
    onSelectApplyRun,
    onSubmitPreparedApplication,
    onPrepareApplicationAgain,
    awaitsYourReview,
    applicationPageClosed,
    selectedApplyRunDetails,
    selectedApplyRunId,
    selectedAttempt,
    selectedRecord,
    visibleApplyResult,
  } = props;
  // A live consent decision or an unresolved manual answer lives inside the
  // review data, so the collapsed block opens itself while one is waiting.
  const hasPendingReviewDecision =
    (visibleApplyResult?.pendingConsentRequestCount ?? 0) > 0 ||
    (selectedApplyRunDetails?.consentRequests.some(
      (request) => request.status === "pending",
    ) ??
      false);

  // What the run that filled this in actually recorded, rather than a later
  // reconstruction from the individual records.
  const reviewCard = selectedApplyRunDetails?.reviewCard
    ? withPersonAnswerSources(
        selectedApplyRunDetails.reviewCard,
        selectedApplyRunDetails,
      )
    : null;
  const reviewCardMatchesVisibleResult =
    selectedApplyRunDetails?.result?.id === visibleApplyResult?.id;

  return (
    <>
      {(visibleApplyResult?.automaticSendPending !== true ||
        visibleApplyResult?.privacyReceipt?.submissionOutcome != null) &&
      (awaitsYourReview || visibleApplyResult?.state === "awaiting_review") &&
      reviewCard &&
      reviewCardMatchesVisibleResult &&
      visibleApplyResult ? (
        <ApplicationsReviewCard
          card={reviewCard}
          onOpenPage={props.onOpenApplicationPage}
          onSubmit={
            awaitsYourReview && onSubmitPreparedApplication
              ? () => onSubmitPreparedApplication(visibleApplyResult.jobId)
              : undefined
          }
          {...(onPrepareApplicationAgain
            ? {
                onPrepareAgain: () =>
                  onPrepareApplicationAgain(visibleApplyResult.jobId),
              }
            : {})}
          pageClosed={applicationPageClosed}
        />
      ) : null}
      <details
        className="group min-w-0"
        data-testid="applications-technical-details"
        {...(hasPendingReviewDecision ? { open: true } : {})}
      >
        <ApplicationsDisclosureSummary data-testid="applications-technical-details-summary">
          Run details and history
        </ApplicationsDisclosureSummary>
        <div className="mt-3 grid min-w-0 gap-4">
          <ApplicationsDetailPanelRunHistorySection
            applyRunHistory={applyRunHistory}
            onSelectApplyRun={onSelectApplyRun}
            selectedApplyRunId={selectedApplyRunId}
          />
          <ApplicationsDetailPanelReviewDataSection
            applyRunDetailsError={applyRunDetailsError}
            applyRunDetailsStatus={applyRunDetailsStatus}
            isApplyRequestPending={isApplyRequestPending}
            onResolveApplyConsentRequest={onResolveApplyConsentRequest}
            onSaveApplicationAnswer={onSaveApplicationAnswer}
            onClearApplicationAnswer={onClearApplicationAnswer}
            selectedApplyRunDetails={selectedApplyRunDetails}
            visibleApplyResult={visibleApplyResult}
          />
          <ApplicationsDetailPanelAttemptSection
            selectedAttempt={selectedAttempt}
          />
        </div>
      </details>
      <ApplicationsDetailPanelPrivacyReceiptSection
        {...(onResolveSubmissionOutcome
          ? { onResolveOutcome: onResolveSubmissionOutcome }
          : {})}
        onExport={() => {
          const receipt = visibleApplyResult?.privacyReceipt;
          if (!receipt?.lineage.applicationRecordId) {
            return Promise.resolve();
          }

          return onExportApplicationPacket({
            runId: receipt.lineage.runId,
            jobId: receipt.lineage.jobId,
            applicationRecordId: receipt.lineage.applicationRecordId,
          });
        }}
        receipt={visibleApplyResult?.privacyReceipt ?? null}
      />
      <ApplicationsDetailPanelTimelineSection events={selectedRecord.events} />
    </>
  );
}
