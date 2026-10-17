import { useState } from "react";
import { Button } from "@renderer/components/ui/button";

type DiagnosticExportState =
  | { status: "idle"; message: string }
  | { status: "pending"; message: string }
  | { status: "saved"; message: string }
  | { status: "cancelled"; message: string }
  | { status: "failed"; message: string };

const initialExportState: DiagnosticExportState = {
  status: "idle",
  message: "No diagnostic report has been created in this session.",
};

export function SettingsSupportControls() {
  const [exportState, setExportState] =
    useState<DiagnosticExportState>(initialExportState);
  const isPending = exportState.status === "pending";

  async function exportDiagnostics() {
    if (isPending) {
      return;
    }

    setExportState({
      status: "pending",
      message: "Preparing a local diagnostic report…",
    });

    try {
      const result = await window.nestor.jobFinder.exportDiagnostics();

      setExportState(
        result.status === "saved"
          ? {
              status: "saved",
              message: "Diagnostic report saved on this device.",
            }
          : {
              status: "cancelled",
              message: "Export cancelled. No diagnostic report was saved.",
            },
      );
    } catch {
      setExportState({
        status: "failed",
        message: "Could not export the diagnostic report. Try again.",
      });
    }
  }

  return (
    <>
      <section className="surface-panel-shell grid gap-3.5 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
        <div className="grid gap-1.5">
          <p className="text-[10px] uppercase tracking-(--tracking-badge) text-muted-foreground">
            Support
          </p>
          <h2 className="font-display font-semibold text-(--text-headline)">
            Export diagnostic report
          </h2>
          <p className="text-sm leading-6 text-foreground-soft">
            Save a local report with app status, performance timings, and
            capability checks. It excludes credentials, resume content,
            screenshots, transcripts, browser storage, private payloads, URL
            secrets, and local paths.
          </p>
        </div>
        <div className="grid justify-items-start gap-2">
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            Nothing is uploaded or transmitted. You choose whether and where to
            save the report.
          </p>
          <Button
            onClick={() => void exportDiagnostics()}
            pending={isPending}
            type="button"
            variant="secondary"
          >
            {isPending ? "Preparing report" : "Export diagnostics"}
          </Button>
          <p
            aria-atomic="true"
            aria-live="polite"
            className="text-(length:--text-description) leading-5 text-foreground-soft"
            data-diagnostic-export-status={exportState.status}
            role="status"
          >
            {exportState.message}
          </p>
        </div>
      </section>
    </>
  );
}
