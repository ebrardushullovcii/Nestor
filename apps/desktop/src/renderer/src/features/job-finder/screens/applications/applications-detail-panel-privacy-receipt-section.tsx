import type { ApplicationPrivacyReceipt } from "@nestor/contracts";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Fingerprint,
  LockKeyhole,
  Monitor,
  Send,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatStatusLabel } from "@renderer/features/job-finder/lib/job-finder-utils";
import { cn } from "@renderer/lib/cn";
import { APPLICATION_DETAIL_FACT_LABEL_CLASS } from "./applications-detail-fact-strip";
import { Button } from "@renderer/components/ui";

const LEGACY_LINEAGE_EXPORT_UNAVAILABLE_REASON =
  "This legacy receipt predates exact application-record linking, so Job Finder cannot export its packet.";

function formatReceiptDestination(origin: string, safePath: string): string {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  const normalizedPath = safePath.replace(/^\/+/, "");

  return normalizedPath
    ? `${normalizedOrigin}/${normalizedPath}`
    : normalizedOrigin;
}

function formatReceiptDataCategory(
  category: ApplicationPrivacyReceipt["stayedLocal"][number],
): string {
  return category === "resume_content"
    ? "Resume text"
    : formatStatusLabel(category);
}

function ReceiptGroup(props: {
  icon: typeof Monitor;
  label: string;
  children: ReactNode;
}) {
  const Icon = props.icon;

  return (
    <div className="grid gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3">
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="size-4 text-primary" />
        <strong>{props.label}</strong>
      </div>
      <div className="text-(length:--text-small) leading-6 text-foreground-soft">
        {props.children}
      </div>
    </div>
  );
}

/**
 * What the attached file actually is, taken from its own name.
 *
 * This screen exists to prove the bytes were not altered, and it called a
 * `.txt` original "PDF" twice while showing the real file name a line above.
 * A tailored export really is a PDF; an original upload is whatever the person
 * imported, so the extension answers rather than an assumption.
 */
export function describeReceiptResumeFileType(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!extension || extension === fileName.toLowerCase()) {
    return "file";
  }

  const known: Record<string, string> = {
    pdf: "PDF",
    doc: "Word document",
    docx: "Word document",
    md: "Markdown file",
    rtf: "RTF file",
    txt: "text file",
  };
  return known[extension] ?? `${extension.toUpperCase()} file`;
}

export function ApplicationsDetailPanelPrivacyReceiptSection(props: {
  onExport: () => Promise<void>;
  onResolveOutcome?: (
    uncertainOutcomeId: string,
    resolution: "submitted" | "not_submitted",
  ) => Promise<void>;
  receipt: ApplicationPrivacyReceipt | null;
}) {
  const { onExport, onResolveOutcome, receipt } = props;
  const [isExporting, setIsExporting] = useState(false);
  const [pendingResolution, setPendingResolution] = useState<
    "submitted" | "not_submitted" | null
  >(null);
  const [isResolving, setIsResolving] = useState(false);
  if (!receipt) {
    return null;
  }

  // Modern receipts carry exact application-record lineage; anything else
  // predates exact linking and keeps the honest legacy explanation. Lineage
  // is read only from the persisted receipt — never inferred.
  const hasExactLineage = Boolean(receipt.lineage.applicationRecordId);
  const heading = hasExactLineage
    ? "What Job Finder prepared"
    : "Earlier preparation record";
  const submissionOutcome = receipt.submissionOutcome;

  return (
    <details
      className="surface-card-tint group grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4"
      open={submissionOutcome?.outcome === "outcome_uncertain"}
    >
      <summary className="cursor-pointer list-none outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h3
              className={cn(
                APPLICATION_DETAIL_FACT_LABEL_CLASS,
                "text-primary",
              )}
            >
              {heading}
            </h3>
            <p className="text-(length:--text-small) leading-6 text-foreground-soft">
              {formatReceiptDestination(
                receipt.destination.origin,
                receipt.destination.safePath,
              )}{" "}
              · Resume: {receipt.resume.fileName} (
              {describeReceiptResumeFileType(receipt.resume.fileName)})
            </p>
          </div>
          <span className="text-(length:--text-small) text-primary">
            Show details
          </span>
        </div>
        {submissionOutcome?.outcome === "outcome_uncertain" ? (
          <div
            className="mt-3 flex items-start gap-2 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-small) leading-6 text-(--warning-text)"
            role="alert"
          >
            <AlertTriangle
              aria-hidden="true"
              className="mt-1 size-4 shrink-0"
            />
            <span>
              Submission outcome is uncertain. Verify this application on the
              employer site before taking another submission action; automatic
              retry is blocked.
            </span>
          </div>
        ) : null}
      </summary>
      <div className="grid gap-3 border-t border-(--surface-panel-border) pt-3">
        {submissionOutcome?.outcome === "outcome_uncertain" &&
        onResolveOutcome ? (
          <section
            aria-label="Verify submission outcome"
            // The amber alert above already says the outcome is uncertain;
            // this is the form that settles it, so it is not a second alert.
            className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) px-3 py-3"
          >
            <div className="grid gap-1">
              <strong>Verify on the employer site</strong>
              <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                Open the employer site yourself and check this exact
                application. Recording the result changes durable history and
                cannot be undone from this screen.
              </p>
            </div>
            {pendingResolution === null ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Button
                  onClick={() => setPendingResolution("submitted")}
                  type="button"
                  variant="secondary"
                >
                  I verified it was submitted
                </Button>
                <Button
                  onClick={() => setPendingResolution("not_submitted")}
                  type="button"
                  variant="secondary"
                >
                  I verified it was not submitted
                </Button>
              </div>
            ) : (
              <div className="grid gap-2" role="alert">
                <p className="text-(length:--text-small) leading-6 text-(--warning-text)">
                  Confirm only if the employer site shows this application was{" "}
                  <strong>
                    {pendingResolution === "submitted"
                      ? "submitted"
                      : "not submitted"}
                  </strong>
                  .
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <Button
                    disabled={isResolving}
                    onClick={() => {
                      setIsResolving(true);
                      void onResolveOutcome(
                        submissionOutcome.id,
                        pendingResolution,
                      ).finally(() => setIsResolving(false));
                    }}
                    type="button"
                    variant="primary"
                  >
                    {isResolving
                      ? "Saving verification…"
                      : "Confirm verification"}
                  </Button>
                  <Button
                    disabled={isResolving}
                    onClick={() => setPendingResolution(null)}
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </section>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-(length:--text-small) leading-6 text-muted-foreground">
              Exported JSON contains personal application answers. Store it
              securely.
            </p>
            <p className="text-(length:--text-small) leading-6 text-foreground-soft">
              {hasExactLineage
                ? "This record shows what Job Finder stored for this application. A submission is confirmed only when the employer site reports receipt."
                : "This older record predates exact application linking. Check the employer site to confirm the outcome."}
            </p>
          </div>
          <Button
            disabled={isExporting || !hasExactLineage}
            onClick={() => {
              setIsExporting(true);
              void onExport().finally(() => setIsExporting(false));
            }}
            size="compact"
            title={
              hasExactLineage
                ? undefined
                : LEGACY_LINEAGE_EXPORT_UNAVAILABLE_REASON
            }
            type="button"
            variant="secondary"
          >
            <Download aria-hidden="true" className="size-4" />
            {isExporting ? "Exporting…" : "Download preparation record"}
          </Button>
        </div>

        {!hasExactLineage ? (
          <p
            className="text-(length:--text-small) leading-6 text-muted-foreground"
            role="note"
          >
            {LEGACY_LINEAGE_EXPORT_UNAVAILABLE_REASON} Everything Job Finder
            recorded about this preparation stays visible on this page.
          </p>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          <ReceiptGroup icon={Monitor} label="Stored on this device">
            {receipt.stayedLocal.length > 0
              ? receipt.stayedLocal.map(formatReceiptDataCategory).join(", ")
              : "No local data was recorded for this preparation."}
          </ReceiptGroup>

          <ReceiptGroup icon={Send} label="Sent to a model">
            {receipt.modelUse.length > 0
              ? receipt.modelUse
                  .map(
                    (entry) =>
                      `${entry.dataCategories.map(formatReceiptDataCategory).join(", ")} for ${formatStatusLabel(entry.purpose)} via ${entry.providerLabel}`,
                  )
                  .join(", ")
              : "Nothing was sent to a model during application preparation."}
          </ReceiptGroup>

          <ReceiptGroup icon={Fingerprint} label="The resume that was used">
            <span className="grid gap-1">
              <span>
                Saved file name:{" "}
                <span className="break-all font-mono text-foreground">
                  {receipt.resume.fileName}
                </span>
              </span>
            </span>
            {receipt.resume.sha256 ? (
              <span className="grid gap-1">
                <code
                  aria-label={`Resume file fingerprint ${receipt.resume.sha256}`}
                  className="break-all font-mono text-foreground"
                  title={receipt.resume.sha256}
                >
                  Fingerprint {receipt.resume.sha256.slice(0, 12)}…
                  {receipt.resume.sha256.slice(-12)}
                </code>
                <span>
                  {receipt.resume.source === "original_upload" &&
                  /\.txt$/iu.test(receipt.resume.fileName) ? (
                    "This is a plain-text copy of your original, unchanged."
                  ) : (
                    <>
                      This is the exact{" "}
                      {describeReceiptResumeFileType(receipt.resume.fileName)}{" "}
                      you approved — unchanged.
                    </>
                  )}
                </span>
              </span>
            ) : (
              <>
                No file fingerprint was recorded for this{" "}
                {hasExactLineage ? "preparation" : "older record"}, so Job
                Finder cannot prove the file went out unchanged. Export the
                resume again before your next application and it will.
              </>
            )}
          </ReceiptGroup>

          <ReceiptGroup icon={CheckCircle2} label="Written to the site">
            {receipt.externalWrites.length > 0 ? (
              <>
                {[
                  ...new Set(
                    receipt.externalWrites.map((entry) => entry.fieldLabel),
                  ),
                ].join(", ")}
                <span className="mt-1 block">
                  Preparation writes Job Finder observed on this run. They do
                  not confirm how the site stored the data or what it did next.
                </span>
              </>
            ) : (
              "No prepared field or resume attachment was recorded as written to the site."
            )}
          </ReceiptGroup>

          <ReceiptGroup
            icon={LockKeyhole}
            label={
              hasExactLineage ? "Safety record" : "Historical safety record"
            }
          >
            {hasExactLineage ? (
              <>
                {receipt.accountCreationAuthorized
                  ? "This preparation marked account creation as authorized. "
                  : "Account creation stayed unauthorized for this preparation. "}
                {receipt.finalSubmitAuthorized
                  ? "Final submit was marked authorized at the time. "
                  : "Final submit stayed disabled. "}
                {receipt.finalSubmitOccurred
                  ? "This receipt records a final-submit action for this run."
                  : "No final-submit action was recorded."}{" "}
                The employer-site outcome above is the record of whether that
                action was confirmed.
              </>
            ) : (
              <>
                {receipt.accountCreationAuthorized
                  ? "Legacy data marked account creation as authorized. "
                  : "Legacy data marked account creation as not authorized. "}
                {receipt.finalSubmitAuthorized
                  ? "Legacy data marked final submit as authorized. "
                  : "Legacy data marked final submit as disabled. "}
                {receipt.finalSubmitOccurred
                  ? "Legacy data recorded a final-submit action for this run."
                  : "Legacy data recorded no final-submit action."}{" "}
                These historical fields are not proof of the site's outcome and
                do not represent a capability in the current product.
              </>
            )}
          </ReceiptGroup>
        </div>

        <p className="text-(length:--text-small) leading-6 text-foreground-soft">
          {receipt.finalSubmitOccurred
            ? "This receipt records a final-submit action. The employer-site confirmation determines whether the application was sent."
            : receipt.finalSubmitAuthorized
              ? "Job Finder had permission to send this application, but this receipt records no final-submit action."
              : "Job Finder prepared this application without permission to send it."}
        </p>
      </div>
    </details>
  );
}
