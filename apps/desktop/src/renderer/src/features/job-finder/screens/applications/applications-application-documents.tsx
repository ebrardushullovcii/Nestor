import { ApplicationsDisclosureSummary } from "./applications-disclosure-summary";
import { getJobFinderErrorDetail } from "../../lib/describe-failure";
import { useEffect, useMemo, useState } from "react";
import type {
  ApplicationDocumentKind,
  ApplicationDocumentRevision,
  ApplicationRecord,
  ApplyRunDetails,
} from "@nestor/contracts";
import { cn } from "@renderer/lib/cn";
import { APPLICATION_DETAIL_FACT_LABEL_CLASS } from "./applications-detail-fact-strip";
import { Button } from "@renderer/components/ui";
import { formatStatusLabel } from "@renderer/features/job-finder/lib/job-finder-utils";
import { formatApplicationEmployerLine } from "../../lib/job-employer-location-display";
import { StatusBadge } from "../../components/status-badge";

export const CANDIDATE_ASSETS_CHANGED_EVENT =
  "nestor:candidate-assets-changed";

export function ApplicationsApplicationDocuments(props: {
  applicationRecord: ApplicationRecord;
  applyRunDetails: ApplyRunDetails | null;
  /** When recovery is the primary action, collapse this optional section. */
  demoteAsSecondary?: boolean;
}) {
  const {
    applicationRecord,
    applyRunDetails,
    demoteAsSecondary = false,
  } = props;
  const [documents, setDocuments] = useState<
    readonly ApplicationDocumentRevision[]
  >([]);
  const [approvedRevisions, setApprovedRevisions] = useState<
    readonly ApplicationDocumentRevision[]
  >([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [kind, setKind] = useState<ApplicationDocumentKind>("cover_letter");
  const attachmentQuestions = useMemo(
    () =>
      (applyRunDetails?.questionRecords ?? []).filter(
        (question) =>
          question.answerControlType === "file" && question.kind !== "resume",
      ),
    [applyRunDetails?.questionRecords],
  );
  const [questionId, setQuestionId] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [status, setStatus] = useState<
    "loading" | "ready" | "working" | "error"
  >("loading");
  const [message, setMessage] = useState<string | null>(null);
  const selectedDocument =
    documents.find((document) => document.id === selectedDocumentId) ??
    documents[0] ??
    null;

  const previousApprovedRevision =
    selectedDocument?.status === "proposed"
      ? approvedRevisions.find(
          (revision) =>
            revision.id === selectedDocument.id &&
            revision.revision < selectedDocument.revision,
        )
      : null;

  useEffect(() => {
    setDraftContent(selectedDocument?.content ?? "");
  }, [
    selectedDocument?.content,
    selectedDocument?.id,
    selectedDocument?.revision,
  ]);

  async function refresh() {
    setStatus("loading");
    try {
      const result = await window.nestor.jobFinder.listApplicationDocuments(
        {
          jobId: applicationRecord.jobId,
          applicationRecordId: applicationRecord.id,
        },
      );
      // One entry per document, at its newest revision; the approved one
      // opens first so a person never mistakes it for an unapproved draft.
      const latest = [
        ...result.documents
          .reduce((byId, document) => {
            const current = byId.get(document.id);
            if (!current || document.revision > current.revision)
              byId.set(document.id, document);
            return byId;
          }, new Map<string, ApplicationDocumentRevision>())
          .values(),
      ];
      setDocuments(latest);
      setApprovedRevisions(result.approvedRevisions ?? []);
      setSelectedDocumentId((current) =>
        latest.some((document) => document.id === current)
          ? current
          : (latest.find((document) => document.status === "approved")?.id ??
            latest[0]?.id ??
            ""),
      );
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? getJobFinderErrorDetail(error)
          : "Application documents could not be loaded.",
      );
    }
  }

  useEffect(() => {
    setDocuments([]);
    setApprovedRevisions([]);
    setSelectedDocumentId("");
    setQuestionId("");
  }, [applicationRecord.id, applicationRecord.jobId]);

  useEffect(() => {
    void refresh();
  }, [
    applicationRecord.id,
    applicationRecord.jobId,
    applyRunDetails?.result?.reviewCard?.letter?.text,
  ]);

  useEffect(() => {
    if (
      questionId &&
      !attachmentQuestions.some((question) => question.id === questionId)
    ) {
      setQuestionId("");
    } else if (!questionId && attachmentQuestions.length === 1) {
      setQuestionId(attachmentQuestions[0]?.id ?? "");
    }
  }, [attachmentQuestions, questionId]);

  async function propose(revise: boolean) {
    setStatus("working");
    setMessage(null);
    const question = attachmentQuestions.find(
      (entry) => entry.id === questionId,
    );
    try {
      const document =
        await window.nestor.jobFinder.proposeApplicationDocument({
          kind,
          jobId: applicationRecord.jobId,
          applicationRecordId: applicationRecord.id,
          question: question
            ? { runId: question.runId, questionId: question.id }
            : null,
          ...(revise && selectedDocument
            ? {
                documentId: selectedDocument.id,
                expectedRevision: selectedDocument.revision,
              }
            : {}),
        });
      await refresh();
      setSelectedDocumentId(document.id);
      setMessage(
        `Revision ${document.revision} is ready to read. It is written from your profile and resume; check it before you approve it.`,
      );
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? getJobFinderErrorDetail(error)
          : "The proposal failed.",
      );
    }
  }

  async function approve() {
    if (!selectedDocument) return;
    const content = draftContent.trim();
    if (!content) return;
    // Approving means approving what is on screen: unsaved typing is saved as
    // a new revision first, and that exact revision is the one approved.
    const hasUnsavedEdit =
      selectedDocument.status === "proposed" &&
      content !== selectedDocument.content.trim();
    if (hasUnsavedEdit && content.length > 12_000) {
      setStatus("error");
      setMessage("Document content cannot exceed 12,000 characters.");
      return;
    }
    setStatus("working");
    setMessage(null);
    try {
      const revisionToApprove = hasUnsavedEdit
        ? await window.nestor.jobFinder.editApplicationDocument({
            documentId: selectedDocument.id,
            expectedRevision: selectedDocument.revision,
            content,
          })
        : selectedDocument;
      const approved =
        await window.nestor.jobFinder.approveApplicationDocument({
          documentId: revisionToApprove.id,
          expectedRevision: revisionToApprove.revision,
        });
      setDraftContent(approved.content);
      await refresh();
      setSelectedDocumentId(approved.id);
      window.dispatchEvent(new Event(CANDIDATE_ASSETS_CHANGED_EVENT));
      setMessage(
        approved.question
          ? "Approved and saved to your files. Select it in the exact attachment question below, then save that prepared answer."
          : "Approved and saved to your files (Profile › Files).",
      );
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? getJobFinderErrorDetail(error)
          : "Approval failed.",
      );
    }
  }

  async function saveManualEdit() {
    if (!selectedDocument) return;
    const content = draftContent.trim();
    if (!content) {
      setStatus("error");
      setMessage("Document content cannot be empty.");
      return;
    }
    if (content.length > 12_000) {
      setStatus("error");
      setMessage("Document content cannot exceed 12,000 characters.");
      return;
    }
    setStatus("working");
    setMessage(null);
    try {
      const edited = await window.nestor.jobFinder.editApplicationDocument({
        documentId: selectedDocument.id,
        expectedRevision: selectedDocument.revision,
        content,
      });
      await refresh();
      setSelectedDocumentId(edited.id);
      setDraftContent(edited.content);
      setMessage(
        `Saved user-authored revision ${edited.revision}. Review every edited claim before approving this exact revision.`,
      );
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? getJobFinderErrorDetail(error)
          : "The edit could not be saved.",
      );
    }
  }

  async function exportDocument() {
    if (!selectedDocument) return;
    setStatus("working");
    setMessage(null);
    try {
      const result =
        await window.nestor.jobFinder.exportApplicationDocument({
          documentId: selectedDocument.id,
          expectedRevision: selectedDocument.revision,
        });
      if (result.status === "cancelled") {
        setStatus("ready");
        setMessage("Export cancelled. The approved document was not changed.");
        return;
      }
      await refresh();
      setMessage(`Exported ${result.fileName}.`);
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? getJobFinderErrorDetail(error)
          : "Export failed.",
      );
    }
  }

  const isWorking = status === "loading" || status === "working";
  // Optional work is one quiet disclosure line, like "Run details and
  // history", not a card whose heading and sentence look like a step.
  const header = demoteAsSecondary ? (
    <ApplicationsDisclosureSummary>Cover letter (optional)</ApplicationsDisclosureSummary>
  ) : (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className={cn(APPLICATION_DETAIL_FACT_LABEL_CLASS, "text-primary")}>
          Application documents
        </h3>
        <p className="mt-1 text-(length:--text-small) leading-6 text-foreground-soft">
          Create a cover letter or short response from your saved profile,
          review it, then approve or export that exact revision. This never
          submits.
        </p>
      </div>
      <StatusBadge
        tone={
          status === "error" ? "critical" : isWorking ? "active" : "neutral"
        }
      >
        {status === "working" ? "Working" : formatStatusLabel(status)}
      </StatusBadge>
    </div>
  );

  const body = (
    <>
      <div
        className={
          attachmentQuestions.length > 0
            ? "grid gap-3 md:grid-cols-2"
            : "grid max-w-sm gap-3"
        }
      >
        <label className="grid gap-1 text-(length:--text-small)">
          Document type
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            disabled={isWorking}
            onChange={(event) =>
              setKind(event.target.value as ApplicationDocumentKind)
            }
            value={kind}
          >
            <option value="cover_letter">Cover letter</option>
            <option value="short_response">Short response document</option>
          </select>
        </label>
        {/* Only a form that asked for an attachment has a question to pick;
            without one this was a dropdown whose one entry said so. */}
        {attachmentQuestions.length > 0 ? (
          <label className="grid gap-1 text-(length:--text-small)">
            Exact attachment question
            <select
              className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
              disabled={isWorking}
              onChange={(event) => setQuestionId(event.target.value)}
              value={questionId}
            >
              <option value="">Choose a question</option>
              {attachmentQuestions.map((question) => (
                <option key={question.id} value={question.id}>
                  {question.prompt}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={isWorking}
          onClick={() => void propose(false)}
          size="compact"
          variant={demoteAsSecondary ? "secondary" : "primary"}
        >
          {kind === "short_response"
            ? "Draft a short response"
            : "Draft a cover letter"}
        </Button>
        {selectedDocument ? (
          <Button
            disabled={isWorking}
            onClick={() => void propose(true)}
            size="compact"
            variant="ghost"
          >
            Draft a new revision
          </Button>
        ) : null}
      </div>

      {documents.length > 1 ? (
        <label className="grid gap-1 text-(length:--text-small)">
          Saved document
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) => setSelectedDocumentId(event.target.value)}
            value={selectedDocument?.id ?? ""}
          >
            {documents.map((document) => (
              <option key={document.id} value={document.id}>
                {formatStatusLabel(document.kind)} · revision{" "}
                {document.revision} · {formatStatusLabel(document.status)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {selectedDocument ? (
        <div className="grid gap-3 rounded-(--radius-field) border border-border/40 bg-background/50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>
              {formatStatusLabel(selectedDocument.kind)} · revision{" "}
              {selectedDocument.revision}
            </strong>
            <StatusBadge
              tone={
                selectedDocument.status === "proposed" ? "active" : "positive"
              }
            >
              {formatStatusLabel(selectedDocument.status)}
            </StatusBadge>
          </div>
          <p className="text-(length:--text-small) text-foreground-soft">
            Exact job: {selectedDocument.job.title}
            {(() => {
              const employerLine = formatApplicationEmployerLine({
                company: selectedDocument.job.company,
                canonicalUrl: selectedDocument.job.canonicalUrl,
              });
              return employerLine ? ` at ${employerLine}` : null;
            })()}
          </p>
          {selectedDocument.question ? (
            <p className="text-(length:--text-small) text-foreground-soft">
              Attachment question: {selectedDocument.question.prompt}
            </p>
          ) : null}
          {previousApprovedRevision ? (
            <div className="grid gap-2 text-(length:--text-small) text-foreground-soft">
              <p>
                Revision {previousApprovedRevision.revision} is approved and
                stays in use until you approve this one.
              </p>
              <details
                key={`${previousApprovedRevision.id}:${previousApprovedRevision.revision}`}
              >
                <summary className="cursor-pointer">
                  Read approved revision {previousApprovedRevision.revision}
                </summary>
                <p className="mt-2 whitespace-pre-wrap leading-6">
                  {previousApprovedRevision.content}
                </p>
              </details>
            </div>
          ) : null}
          {selectedDocument.status === "proposed" ? (
            <div className="grid gap-2">
              <label className="grid gap-1 text-(length:--text-small) font-semibold">
                Edit proposed text
                <textarea
                  className="min-h-64 w-full resize-y rounded-(--radius-field) border border-(--field-border) bg-(--field) p-3 font-sans text-(length:--text-small) font-normal leading-6 outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
                  disabled={isWorking}
                  maxLength={12_000}
                  onChange={(event) => setDraftContent(event.target.value)}
                  value={draftContent}
                />
              </label>
              <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                Check every claim against your profile and resume before
                approving.
              </p>
              <Button
                disabled={
                  isWorking ||
                  !draftContent.trim() ||
                  draftContent === selectedDocument.content
                }
                onClick={() => void saveManualEdit()}
                size="compact"
                variant="secondary"
              >
                Save edit as new revision
              </Button>
            </div>
          ) : (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-(--radius-field) border border-border/30 bg-background p-3 font-sans text-(length:--text-small) leading-6">
              {selectedDocument.content}
            </pre>
          )}
          {selectedDocument.requiresGroundingReview ? (
            <p className="rounded-(--radius-field) border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-(length:--text-small) leading-6 text-foreground">
              {selectedDocument.reviewReason ??
                "Check every edited claim against your profile and resume before approving."}
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer text-(length:--text-small) font-semibold">
              Supporting facts ({selectedDocument.evidence.length})
            </summary>
            <ul className="mt-2 grid gap-2 text-(length:--text-small) leading-6 text-foreground-soft">
              {selectedDocument.evidence.map((evidence) => (
                <li key={evidence.id}>
                  <strong className="text-foreground">{evidence.label}:</strong>{" "}
                  {evidence.text}
                </li>
              ))}
            </ul>
          </details>
          <div className="flex flex-wrap gap-2">
            {selectedDocument.status === "proposed" ? (
              <Button
                disabled={isWorking || !draftContent.trim()}
                onClick={() => void approve()}
                size="compact"
              >
                {draftContent.trim() &&
                draftContent.trim() !== selectedDocument.content.trim()
                  ? "Save and approve"
                  : "Approve"}
              </Button>
            ) : (
              <Button
                disabled={isWorking}
                onClick={() => void exportDocument()}
                size="compact"
                variant="secondary"
              >
                Export .txt
              </Button>
            )}
          </div>
        </div>
      ) : status === "ready" ? (
        <p className="text-(length:--text-small) text-foreground-soft">
          No application document has been proposed for this job yet.
        </p>
      ) : null}
      {message ? (
        <p
          className={
            status === "error"
              ? "text-(length:--text-small) text-destructive"
              : "text-(length:--text-small) text-foreground-soft"
          }
        >
          {message}
        </p>
      ) : null}
    </>
  );

  return (
    <section
      className={
        demoteAsSecondary
          ? "grid min-w-0"
          : "surface-card-tint grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4"
      }
    >
      {demoteAsSecondary ? (
        // Not a grid: a closed <details> still lays out its hidden content
        // slot as a grid row, so the gap added 16 px under the summary.
        <details className="group">
          {header}
          <div className="mt-3 grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
            <p className="text-(length:--text-small) leading-6 text-foreground-soft">
              Read, edit and approve documents for this application.
            </p>
            {body}
          </div>
        </details>
      ) : (
        <>
          {header}
          {body}
        </>
      )}
    </section>
  );
}
