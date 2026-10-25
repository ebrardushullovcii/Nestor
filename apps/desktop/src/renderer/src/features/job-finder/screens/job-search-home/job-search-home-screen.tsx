import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type {
  ApplicationAutomationMode,
  DiscoveryActivityEvent,
  JobFinderSearchRequest,
  JobFinderRendererWorkspaceSnapshot,
  ProfileSetupStep,
  ResumeImportProgressEvent,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import type { ApplyQueueControlAction } from "../../lib/apply-queue-view";
import {
  PageHeaderStack,
  type PageStatusItem,
} from "../../components/page-header";
import { buildJobFinderTaskCenterModel } from "../../components/task-center/job-finder-task-center-model";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import { useApplicationPageStates } from "../../hooks/use-application-page-states";
import { DiscoveryRunFeedbackCallout } from "../discovery/discovery-run-feedback-callout";
import type { DiscoveryRunFeedback } from "../discovery/discovery-run-feedback";
import type { ActionState } from "../../lib/job-finder-types";
import {
  buildJobSearchHomeModel,
  type HomeFindJobsCounts,
  type HomeAction,
  type HomeButton,
} from "./job-search-home-model";
import { useRememberNextStepHeight } from "./home-next-step-size";

export { buildInterruptedSearchRetryRequest } from "./job-search-home-model";

export interface JobSearchHomeScreenProps {
  workspace: JobFinderRendererWorkspaceSnapshot;
  /** Find jobs' counts from the database while its lists still load. */
  findJobsCounts?: HomeFindJobsCounts | null;
  /**
   * What the last press on this page came to, in a sentence. A refusal
   * (Apply held back by a resume, a send that could not start) is shown here
   * instead of the press doing nothing visible.
   */
  actionState?: ActionState;
  activityPending: boolean;
  applicationAutomationMode?: ApplicationAutomationMode;
  browserSessionPending?: boolean;
  discoveryRunFeedback?: DiscoveryRunFeedback | null;
  discoveryRunPending?: boolean;
  isDiscoveryPending?: boolean;
  isResumeImportPending?: boolean;
  liveDiscoveryEvents?: readonly DiscoveryActivityEvent[];
  resumeImportProgress?: ResumeImportProgressEvent | null;
  onApplyToJobs?: (jobIds: readonly string[]) => Promise<unknown> | void;
  /** Send for me: Job Finder presses Send on each filled-in form. */
  onSendPreparedApplications?: (
    jobIds: readonly string[],
  ) => Promise<unknown> | void;
  onNavigate: (path: string) => void;
  onOpenBrowserSession?: () => void;
  onPauseActivity: () => void;
  onResumeActivity: () => void;
  onRunDiscovery?: (request?: JobFinderSearchRequest) => void;
  onResumeSetup?: (step: ProfileSetupStep) => void;
  onStopApply?: (runId: string) => void;
  onControlApplyQueue?: (action: ApplyQueueControlAction) => void;
  onStopSearch?: (runId: string) => void;
}

const PANEL_CLASS =
  "surface-panel-shell grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) p-5";

const DISMISSED_HOME_PROBLEMS_KEY = "nestor.home.dismissed-problems-v1";

type DismissedHomeProblems = Readonly<Record<string, string>>;

function readDismissedHomeProblems(): DismissedHomeProblems {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(DISMISSED_HOME_PROBLEMS_KEY) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Remembers that the person hid a quiet Home line for its current cause, so
 * it stays hidden until the cause changes (ADR 0051: a fact the app cannot
 * fix gets at most a notice dismissed for good).
 */
export function rememberDismissedHomeProblem(
  problemId: string,
  dismissKey: string,
): DismissedHomeProblems {
  const next = { ...readDismissedHomeProblems(), [problemId]: dismissKey };
  try {
    window.localStorage.setItem(
      DISMISSED_HOME_PROBLEMS_KEY,
      JSON.stringify(next),
    );
  } catch {
    // This visit still hides it.
  }
  return next;
}

export function JobSearchHomeScreen(props: JobSearchHomeScreenProps) {
  const [now, setNow] = useState(Date.now);
  const nextStepRef = useRef<HTMLElement>(null);
  useRememberNextStepHeight(nextStepRef);
  const [dismissedProblemKeys, setDismissedProblemKeys] =
    useState<DismissedHomeProblems>(readDismissedHomeProblems);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [applyPending, setApplyPending] = useState(false);
  const [dismissedActionState, setDismissedActionState] =
    useState<ActionState | null>(null);
  const actionMessage =
    props.actionState?.message && props.actionState !== dismissedActionState
      ? props.actionState.message
      : null;
  const tasks = buildJobFinderTaskCenterModel({
    workspace: props.workspace,
    isDiscoveryPending: props.isDiscoveryPending ?? false,
    isResumeImportPending: props.isResumeImportPending ?? false,
    liveDiscoveryEvents: props.liveDiscoveryEvents,
    resumeImportProgress: props.resumeImportProgress,
  });
  // A search outcome the person has to do something about (a browser that
  // would not open, a source that needs sign-in) keeps its own callout with
  // its own corrective action. A finished search is a status fact and reads
  // as the line under the title instead.
  const applicationPageStates = useApplicationPageStates(
    props.workspace.applyJobResults,
  );
  const model = buildJobSearchHomeModel({
    now,
    workspace: props.workspace,
    applicationPageStates,
    tasks,
    discoveryRunPending: props.discoveryRunPending ?? false,
    findJobsCounts: props.findJobsCounts ?? null,
    canRunDiscovery: Boolean(props.onRunDiscovery),
    applicationAutomationMode:
      props.applicationAutomationMode ?? "confirm_before_submit",
  });
  const missingStartingPageCoveredBySourceFix =
    model.problems.some((problem) => problem.id === "failing-sources") &&
    /Starting page returned HTTP (404|410)/iu.test(
      props.discoveryRunFeedback?.detail ?? "",
    );
  // A search that stopped at a sign-in carries on by itself once the person
  // signs in; the press that started it failed, but a later search of the
  // same plan finished. That completion replaces the failure, as it does on
  // Find jobs.
  const failureRecordedAtMs =
    props.discoveryRunFeedback?.status === "failed"
      ? props.discoveryRunFeedback.recordedAtMs
      : undefined;
  const failureSupersededByCompletedRun =
    failureRecordedAtMs !== undefined &&
    (props.workspace.recentDiscoveryRuns ?? []).some(
      (run) =>
        run.campaignId === props.workspace.activeCampaignId &&
        run.state === "completed" &&
        run.completedAt !== null &&
        Date.parse(run.completedAt) > failureRecordedAtMs,
    );
  const unresolvedFeedback =
    props.discoveryRunFeedback &&
    props.discoveryRunFeedback.targetLabel === null &&
    props.discoveryRunFeedback.status !== "succeeded" &&
    props.discoveryRunFeedback.status !== "started" &&
    // The person's own Stop: the line under the title already says the
    // last search stopped early, and nothing needs fixing.
    props.discoveryRunFeedback.status !== "cancelled" &&
    !failureSupersededByCompletedRun &&
    !missingStartingPageCoveredBySourceFix &&
    // The next step already names the broken source and where to fix it,
    // or the failed search and why; a banner above it said it again.
    model.next.id !== "source_failed" &&
    !(
      model.next.id === "search_failed" &&
      props.discoveryRunFeedback.recovery?.kind !== "browser_session"
    ) &&
    model.next.id !== "sources" &&
    // A source to correct is Home's card or problem line, which follow the
    // sources as they are now; this callout kept naming a source the person
    // had already removed.
    props.discoveryRunFeedback.recovery?.kind !== "source_setup"
      ? props.discoveryRunFeedback
      : null;
  const run = (action: HomeAction) => {
    switch (action.kind) {
      case "navigate":
        props.onNavigate(action.route);
        return;
      case "run_search":
        if (props.onRunDiscovery) {
          props.onRunDiscovery(action.request);
        } else {
          props.onNavigate(JOB_FINDER_ROUTE_PATHS.discovery);
        }
        return;
      case "resume_setup":
        if (props.onResumeSetup) {
          props.onResumeSetup(action.step);
        } else {
          props.onNavigate("/job-finder/profile/setup");
        }
        return;
      case "apply_all":
        if (props.onApplyToJobs) {
          setApplyPending(true);
          void Promise.resolve(props.onApplyToJobs(action.jobIds)).finally(() =>
            setApplyPending(false),
          );
        } else {
          props.onNavigate(JOB_FINDER_ROUTE_PATHS.reviewQueue);
        }
        return;
      case "send_prepared":
        if (props.onSendPreparedApplications) {
          setApplyPending(true);
          void Promise.resolve(
            props.onSendPreparedApplications(action.jobIds),
          ).finally(() => setApplyPending(false));
        } else {
          props.onNavigate(JOB_FINDER_ROUTE_PATHS.applications);
        }
        return;
      case "stop_search":
        props.onStopSearch?.(action.runId);
        return;
      case "stop_apply":
        props.onStopApply?.(action.runId);
        return;
      case "apply_queue":
        props.onControlApplyQueue?.(action.action);
        return;
      case "pause_activity":
        props.onPauseActivity();
        return;
      case "resume_activity":
        props.onResumeActivity();
        return;
    }
  };

  const isButtonPending = (button: HomeButton): boolean =>
    (button.action.kind === "run_search" &&
      Boolean(props.discoveryRunPending)) ||
    ((button.action.kind === "apply_all" ||
      button.action.kind === "send_prepared") &&
      applyPending) ||
    ((button.action.kind === "pause_activity" ||
      button.action.kind === "resume_activity") &&
      props.activityPending);

  return (
    // The header stack owns its 12px seam; the -mb-2 cancels the part of
    // the 20px grid gap that would double it.
    // Home is one column: at 1920 its card and tiles ran 1600px wide around
    // a 68-character sentence. It keeps a readable width instead.
    <section className="grid min-w-0 max-w-[76rem] grid-cols-[minmax(0,1fr)] gap-5 pb-8 [&>[data-page-header-stack]]:-mb-2">
      <PageHeaderStack
        actions={
          // While paused the next-step card below offers Resume; the header
          // does not repeat it.
          model.paused && model.next.id !== "paused" ? (
            <Button
              onClick={() => run({ kind: "resume_activity" })}
              pending={props.activityPending}
              size="sm"
              type="button"
            >
              <Play aria-hidden="true" className="size-4" />
              Resume
            </Button>
          ) : undefined
        }
        description="Your search, shortlisted jobs, and applications."
        statusItems={[
          ...model.problems.flatMap((problem): PageStatusItem[] => {
            const button = problem.button;
            const dismissKey = problem.dismissKey;
            if (
              dismissKey !== undefined &&
              dismissedProblemKeys[problem.id] === dismissKey
            )
              return [];
            const item: PageStatusItem = {
              id: problem.id,
              ...(problem.tone ? { tone: problem.tone } : {}),
              text: problem.text,
              ...(dismissKey !== undefined
                ? {
                    onHide: () =>
                      setDismissedProblemKeys(
                        rememberDismissedHomeProblem(problem.id, dismissKey),
                      ),
                  }
                : {}),
              ...(button
                ? {
                    // Going to the screen that owns the problem is a link;
                    // doing something here is the line's one button.
                    action:
                      button.action.kind === "navigate"
                        ? {
                            kind: "link",
                            label: button.label,
                            onClick: () => run(button.action),
                          }
                        : {
                            kind: "button",
                            label: button.label,
                            onClick: () => run(button.action),
                          },
                  }
                : {}),
            };
            return [item];
          }),
          { id: "run-summary", text: model.statusLine },
        ]}
        title="Home"
      />

      {model.now.length > 0 ? (
        <section
          aria-label="Happening now"
          className={PANEL_CLASS}
          data-testid="home-now"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h2 className="text-(length:--text-small) font-semibold leading-5 text-muted-foreground">
              Happening now
            </h2>
            {!model.paused ? (
              <Button
                onClick={() => run({ kind: "pause_activity" })}
                pending={props.activityPending}
                size="xs"
                type="button"
                variant="ghost"
              >
                <Pause aria-hidden="true" className="size-3" />
                Pause new work
              </Button>
            ) : null}
          </div>
          <ul className="grid min-w-0 gap-2">
            {model.now.map((item) => (
              <li
                className="flex min-w-0 flex-wrap items-center justify-between gap-3"
                key={item.id}
              >
                <div className="min-w-0 flex-1">
                  <p className="min-w-0 break-words text-sm font-medium text-(--text-headline)">
                    <span
                      key={`${item.title}:${item.detail ?? ""}`}
                      aria-hidden="true"
                      className={cn(
                        "mr-2 inline-block size-2 rounded-full align-middle",
                        item.active === false
                          ? "bg-foreground-muted"
                          : "motion-safe:animate-pulse-brief bg-primary",
                      )}
                    />
                    {item.title}
                  </p>
                  {item.detail ? (
                    <p className="min-w-0 break-words text-xs text-foreground-muted">
                      {item.detail}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {item.open ? (
                    <Button
                      onClick={() => item.open && run(item.open.action)}
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      {item.open.label}
                    </Button>
                  ) : null}
                  {item.stop ? (
                    <Button
                      onClick={() => item.stop && run(item.stop.action)}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {item.stop.label}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {unresolvedFeedback ? (
        <div
          className="grid min-w-0 gap-2"
          data-testid="home-discovery-run-feedback"
        >
          <DiscoveryRunFeedbackCallout
            feedback={unresolvedFeedback}
            {...(props.browserSessionPending !== undefined
              ? { isRecoveryPending: props.browserSessionPending }
              : {})}
            {...(props.onOpenBrowserSession
              ? { onOpenBrowserSession: props.onOpenBrowserSession }
              : {})}
          />
        </div>
      ) : null}

      {actionMessage ? (
        <div
          aria-atomic="true"
          className="flex min-w-0 items-start justify-between gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-background px-3 py-2 text-sm leading-5 text-foreground"
          data-testid="home-action-message"
          role="status"
        >
          <p className="min-w-0 break-words">{actionMessage}</p>
          <div className="flex shrink-0 items-center gap-1">
            {props.actionState?.actionLink ? (
              <Button
                onClick={() =>
                  props.actionState?.actionLink &&
                  props.onNavigate(props.actionState.actionLink.route)
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {props.actionState.actionLink.label}
              </Button>
            ) : null}
            <Button
              onClick={() => setDismissedActionState(props.actionState ?? null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      <section
        aria-labelledby="home-next-step-title"
        className="surface-panel-shell grid min-w-0 gap-3 rounded-(--radius-panel) border border-primary/40 bg-primary/10 p-5"
        data-home-next-step={model.next.id}
        data-testid="home-next-step"
        ref={nextStepRef}
      >
        <p className="text-(length:--text-small) font-semibold leading-5 text-muted-foreground">
          Next step
        </p>
        <h2
          className="min-w-0 break-words font-semibold text-(--text-headline)"
          id="home-next-step-title"
        >
          {model.next.title}
        </h2>
        <p className="min-w-0 max-w-[68ch] break-words text-sm text-foreground-soft">
          {model.next.detail}
          {model.next.detailLink ? (
            <>
              {" "}
              <button
                className="inline cursor-pointer rounded-sm text-primary underline underline-offset-2 outline-none hover:text-primary/80 focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="home-next-step-detail-link"
                onClick={() =>
                  model.next.detailLink && run(model.next.detailLink.action)
                }
                type="button"
              >
                {model.next.detailLink.label}
              </button>
            </>
          ) : null}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            className="h-11 w-fit px-5"
            onClick={() => run(model.next.primary.action)}
            pending={isButtonPending(model.next.primary)}
            type="button"
          >
            {model.next.primary.label}
          </Button>
          {model.next.secondary.map((button) => (
            <Button
              className="h-11 w-fit px-4"
              key={button.label}
              onClick={() => run(button.action)}
              pending={isButtonPending(button)}
              size="sm"
              type="button"
              variant="outline"
            >
              {button.label}
            </Button>
          ))}
        </div>
        {model.next.also && model.next.also.length > 0 ? (
          <ul className="m-0 grid list-none gap-1 p-0" data-home-next-step-also>
            {model.next.also.map((line) => (
              <li
                className="min-w-0 text-(length:--text-small) leading-5 text-foreground-muted"
                data-home-also={line.id}
                key={line.id}
              >
                {line.text}
                {line.link ? (
                  <>
                    {" "}
                    <button
                      className="inline cursor-pointer rounded-sm text-foreground-soft underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => line.link && run(line.link.action)}
                      type="button"
                    >
                      {line.link.label}
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {model.stages ? (
        <nav
          aria-label="Where you are"
          className="grid min-w-0 gap-2 sm:grid-cols-3"
          data-testid="home-pipeline"
        >
          {model.stages.map((stage) => (
            <button
              className="surface-panel-shell grid min-w-0 content-start gap-0.5 rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-3 text-left outline-none transition-colors hover:border-(--control-border-hover) hover:bg-secondary/35 focus-visible:ring-2 focus-visible:ring-ring"
              data-home-stage={stage.id}
              key={stage.id}
              onClick={() => props.onNavigate(stage.route)}
              type="button"
            >
              <span className="text-(length:--text-small) text-foreground-soft">
                {stage.label}
              </span>
              <span className="text-(length:--text-heading-2) font-semibold tabular-nums leading-tight text-(--text-headline)">
                {stage.count}
              </span>
              {stage.detail ? (
                <span className="min-w-0 break-words text-xs text-foreground-muted">
                  {stage.detail}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}
    </section>
  );
}
