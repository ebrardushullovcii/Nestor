import { useState } from "react";
import type {
  JobFinderPerformanceSnapshot,
  PerformanceEvidenceArea,
  PerformanceEvidenceBudgetStatus,
  PerformanceEvidenceStageId,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";

const areaLabels: Record<PerformanceEvidenceArea, string> = {
  resume_import: "Resume import",
  resume_generation: "Resume generation",
  discovery: "Job discovery",
  application_preparation: "Application preparation",
  persistence: "Workspace persistence",
  ipc: "IPC round trip",
  renderer_commit: "Renderer commit",
};

const stageLabels: Record<PerformanceEvidenceStageId, string> = {
  "resume_import.text_branch": "AI text analysis",
  "resume_import.literal_extraction": "Literal extraction",
  "resume_import.reconciliation": "Reconciliation",
  "resume_import.finalization": "Finalization",
  "resume_import.identity_summary": "Identity and summary",
  "resume_import.experience": "Experience extraction",
  "resume_import.background": "Background extraction",
  "resume_import.shared_memory": "Shared-memory matching",
  "resume_generation.provider": "Provider generation",
  "resume_generation.grounding": "Grounding checks",
  "resume_generation.render": "Document render",
  "discovery.planning": "Planning",
  "discovery.target": "Source work",
  "discovery.navigation": "Navigation",
  "discovery.extraction": "Extraction",
  "discovery.scoring": "Scoring",
  "discovery.persistence": "Persistence",
  "discovery.run": "Run orchestration",
  "application_preparation.browser_preparation": "Browser preparation",
  "application_preparation.form_preparation": "Form preparation",
  "application_preparation.visual_diagnostics": "Visual diagnostics",
  "persistence.workspace_snapshot_read": "Workspace snapshot read",
  "ipc.workspace_round_trip": "Workspace IPC round trip",
  "renderer.discovery_results_commit": "Discovery results commit",
};

const budgetLabels: Record<PerformanceEvidenceBudgetStatus, string> = {
  pass: "Within budget",
  warning: "Budget warning",
  fail: "Over budget",
  not_evaluated: "No stable budget yet",
  unavailable: "No measurement",
};

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)} ms`;
  }
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function timingStepLabel(name: string): string {
  const labels: Record<string, string> = {
    model_turn: "Assistant decision",
    observe_after_batch: "Reading the page after answers",
    observe_initial: "Reading the first page",
    observe: "Reading the page",
    read_text: "Reading page text",
    type: "Entering an answer",
    select: "Choosing an answer",
    set_checkbox: "Ticking a box",
    upload: "Attaching a file",
    fill_fields: "Entering answers and checking facts",
    report_answer_checks: "Checking answers",
    report_question_classifications: "Checking questions",
    report_question_kinds: "Checking questions",
    finish: "Checking the completed form",
    click: "Pressing a control",
    navigate: "Opening a page",
    follow_link: "Following a link",
    wait: "Waiting for the page",
    scroll: "Scrolling the page",
  };
  return labels[name] ?? "Application step";
}

export function SettingsPerformanceEvidence() {
  const [snapshot, setSnapshot] = useState<JobFinderPerformanceSnapshot | null>(
    null,
  );
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );

  async function loadPerformanceEvidence() {
    if (state === "loading") {
      return;
    }
    setState("loading");
    try {
      const next = await window.nestor.jobFinder.getPerformanceSnapshot();
      setSnapshot(next);
      setState("ready");
    } catch {
      setSnapshot(null);
      setState("failed");
    }
  }

  return (
    <section className="surface-panel-shell grid gap-3.5 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="grid gap-1.5">
        <p className="text-[10px] uppercase tracking-(--tracking-badge) text-muted-foreground">
          Performance
        </p>
        <h2 className="font-display font-semibold text-(--text-headline)">
          Workflow timing evidence
        </h2>
        <p className="text-sm leading-6 text-foreground-soft">
          Compare the latest recorded workflow stages and warning budgets. “Not
          recorded” is different from a measured 0 ms.
        </p>
      </div>

      <Button
        className="justify-self-start"
        onClick={() => void loadPerformanceEvidence()}
        pending={state === "loading"}
        type="button"
        variant="secondary"
      >
        {state === "loading"
          ? "Reading performance evidence"
          : snapshot
            ? "Refresh performance evidence"
            : "Load performance evidence"}
      </Button>

      {state === "failed" ? (
        <p aria-live="polite" className="text-sm text-destructive">
          Performance evidence could not be loaded. Try again.
        </p>
      ) : null}

      {snapshot ? (
        <div className="grid gap-2" data-testid="performance-evidence-list">
          {snapshot.waitingFormMemory ? (
            <details className="rounded-(--radius-field) border border-(--surface-panel-border) p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Waiting forms memory
              </summary>
              <p className="mt-2 text-sm text-foreground-muted">
                {(snapshot.waitingFormMemory.totalBytes / 1024 / 1024).toFixed(
                  1,
                )}{" "}
                MiB of{" "}
                {(snapshot.waitingFormMemory.budgetBytes / 1024 / 1024).toFixed(
                  0,
                )}{" "}
                MiB budget · {snapshot.waitingFormMemory.tabs.length}{" "}
                {snapshot.waitingFormMemory.tabs.length === 1
                  ? "form"
                  : "forms"}
              </p>
              <p className="mt-2 text-sm text-foreground-muted">
                {snapshot.waitingFormMemory.overBudget
                  ? "Above budget; new forms wait until memory is available."
                  : "New forms reserve memory before starting."}{" "}
                Background forms are throttled. Answers and attachments stay in
                their tabs. Shared processes count once in the total.
              </p>
              {!snapshot.waitingFormMemory.measurementComplete ? (
                <p className="mt-2 text-sm text-foreground-muted">
                  Some process memory could not be measured.
                </p>
              ) : null}
              <ul className="mt-2 text-sm text-foreground-muted">
                {snapshot.waitingFormMemory.tabs.map((tab, index) => (
                  <li key={tab.tabId}>
                    Form {index + 1}:{" "}
                    {tab.processBytes === null
                      ? "Not recorded"
                      : `${(tab.processBytes / 1024 / 1024).toFixed(1)} MiB`}{" "}
                    ·{" "}
                    {tab.backgroundThrottled
                      ? "Background throttling on"
                      : "Active"}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {snapshot.evidence.map((entry) => (
            <article
              className="rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-subtle) p-3"
              key={entry.area}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-foreground">
                    {areaLabels[entry.area]}
                  </h3>
                  <p className="mt-1 text-(length:--text-description) text-foreground-muted">
                    {budgetLabels[entry.budgetStatus]}
                  </p>
                </div>
                <strong className="text-sm text-(--text-headline)">
                  {entry.measurementStatus === "available"
                    ? formatDuration(entry.durationMs)
                    : entry.measurementStatus === "partial"
                      ? "Total not recorded"
                      : "Not recorded"}
                </strong>
              </div>

              {"agentTiming" in entry && entry.agentTiming ? (
                <details className="mt-3 border-t border-(--surface-panel-border) pt-2">
                  <summary className="cursor-pointer text-sm font-medium">
                    Form preparation details
                  </summary>
                  <dl className="mt-2 grid gap-1 text-sm text-foreground-muted">
                    <div>
                      <dt>Form agent total</dt>
                      <dd>{formatDuration(entry.agentTiming.totalMs)}</dd>
                    </div>
                    <div>
                      <dt>Assistant decisions</dt>
                      <dd>
                        {entry.agentTiming.modelTurns} turns ·{" "}
                        {formatDuration(entry.agentTiming.modelMs)}
                      </dd>
                    </div>
                    <div>
                      <dt>Question reading</dt>
                      <dd>
                        {entry.agentTiming.questionReadingCalls === undefined
                          ? "Not recorded separately"
                          : `${entry.agentTiming.questionReadingCalls} ${entry.agentTiming.questionReadingCalls === 1 ? "call" : "calls"} · ${formatDuration(entry.agentTiming.questionReadingMs ?? 0)}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Answer checks</dt>
                      <dd>
                        {entry.agentTiming.answerCheckCalls === undefined
                          ? "Not recorded separately"
                          : `${entry.agentTiming.answerCheckCalls} ${entry.agentTiming.answerCheckCalls === 1 ? "call" : "calls"} · ${formatDuration(entry.agentTiming.answerCheckMs ?? 0)}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Tools, including checks</dt>
                      <dd>{formatDuration(entry.agentTiming.toolMs)}</dd>
                    </div>
                    <div>
                      <dt>Page reads, including safety checks</dt>
                      <dd>
                        {entry.agentTiming.pageReads} reads ·{" "}
                        {formatDuration(entry.agentTiming.pageReadMs)}
                      </dd>
                    </div>
                    <div>
                      <dt>Entering answers</dt>
                      <dd>{formatDuration(entry.agentTiming.writeMs)}</dd>
                    </div>
                    <div>
                      <dt>Attaching files</dt>
                      <dd>{formatDuration(entry.agentTiming.uploadMs)}</dd>
                    </div>
                  </dl>
                  <p className="mt-2 text-sm text-foreground-muted">
                    Checks can run while other work is happening. These times
                    overlap.
                  </p>
                  <p className="mt-2 text-sm font-medium text-foreground-soft">
                    Slowest steps
                  </p>
                  <ul className="mt-2 text-sm text-foreground-muted">
                    {entry.agentTiming.longestSteps.map((step, index) => (
                      <li key={index}>
                        {timingStepLabel(step.toolName)}:{" "}
                        {formatDuration(step.durationMs)}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-sm text-foreground-muted">
                    Answers and progress per turn:{" "}
                    {entry.agentTiming.requests
                      .map(
                        (request) =>
                          `Turn ${request.turn}: ${request.fieldsFilled === undefined ? "fields filled not recorded" : `${request.fieldsFilled} ${request.fieldsFilled === 1 ? "field" : "fields"} filled`}; ${request.storedFactFills === undefined ? "stored facts not recorded" : `${request.storedFactFills} from stored facts`}; ${request.answersWaited === undefined ? "answer checks not recorded" : `${request.answersWaited} waited for a check`}; ${request.stepsAdvanced === undefined ? "steps advanced not recorded" : `${request.stepsAdvanced} ${request.stepsAdvanced === 1 ? "step" : "steps"} advanced`}; ${request.uploadsAttached === undefined ? "uploads not recorded" : `${request.uploadsAttached} ${request.uploadsAttached === 1 ? "file" : "files"} attached`}`,
                      )
                      .join(" · ") || "No assistant turns"}
                  </p>
                  <p className="mt-2 text-sm text-foreground-muted">
                    Characters sent per assistant turn:{" "}
                    {entry.agentTiming.requests
                      .map(
                        (request) =>
                          `${request.historyChars} (page update ${request.observationChars})`,
                      )
                      .join(", ") || "No assistant turns"}
                  </p>
                </details>
              ) : null}

              {entry.stageDurations.length > 0 ? (
                <details className="mt-3 border-t border-(--surface-panel-border) pt-2">
                  <summary className="cursor-pointer text-(length:--text-description) font-medium text-foreground-soft">
                    Stage details
                  </summary>
                  <dl className="mt-2 grid gap-1 text-(length:--text-description) text-foreground-muted">
                    {entry.stageDurations.map((stage) => (
                      <div
                        className="flex justify-between gap-3"
                        key={stage.id}
                      >
                        <dt>{stageLabels[stage.id]}</dt>
                        <dd>{formatDuration(stage.durationMs)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
