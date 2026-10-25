import type { HomeSummary, HomeUpcoming } from "@nestor/contracts";
import { ArrowRight, CalendarClock, MessagesSquare } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { PageHeader } from "@renderer/features/job-finder/components/page-header";
import { JOB_FINDER_ROUTE_PATHS } from "@renderer/features/job-finder/lib/job-finder-route-hrefs";
import { plural } from "@renderer/features/job-lists";
import { cn } from "@renderer/lib/cn";

import { ActivityChart, StandingBar } from "./home-charts";
import { useHomeSummary } from "./use-home-summary";

const HOME_SHOWN_MARK = "job-finder:home:numbers-shown";

const PANEL =
  "surface-panel-shell min-w-0 rounded-(--radius-panel) border border-(--surface-panel-border) p-4";

const whenFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
const dueFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

interface NextStep {
  id: string;
  text: string;
  detail?: string;
  action: string;
  to: string;
}

const NEEDS_YOU_PATH = "/job-finder/actions";

/** What is waiting on the person, most urgent first. */
function nextSteps(summary: HomeSummary): NextStep[] {
  const steps: NextStep[] = [];
  const { questions, signIns, checks } = summary.needsYou;
  if (questions > 0)
    steps.push({
      id: "needs-you-questions",
      text: `Answer ${plural(questions, "question")} for your applications`,
      detail: "Apply asked; it carries on once you answer.",
      action: "Answer",
      to: `${NEEDS_YOU_PATH}?kind=question`,
    });
  if (signIns > 0)
    steps.push({
      id: "needs-you-sign-ins",
      text:
        signIns === 1
          ? "Sign in to 1 job site"
          : `Sign in to ${signIns.toLocaleString()} job sites`,
      detail: "Searching or applying there waits until you do.",
      action: "Sign in",
      to: `${NEEDS_YOU_PATH}?kind=sign_in`,
    });
  if (checks > 0)
    steps.push({
      id: "needs-you-checks",
      text: `Pass ${plural(checks, "site check")}`,
      detail: "A CAPTCHA or verification code only you can enter.",
      action: "Open",
      to: NEEDS_YOU_PATH,
    });
  if (summary.followUpsDue > 0)
    steps.push({
      id: "follow-ups",
      text: `Follow up on ${plural(summary.followUpsDue, "application")}`,
      detail: "Reminders and interviews that are due.",
      action: "Follow up",
      to: JOB_FINDER_ROUTE_PATHS.applications,
    });
  if (summary.resumes.toReview > 0)
    steps.push({
      id: "review",
      text: `Read ${plural(summary.resumes.toReview, "resume")} and approve them`,
      ...(summary.resumes.writing > 0
        ? {
            detail: `${summary.resumes.writing.toLocaleString()} more being written.`,
          }
        : {}),
      action: "Review",
      to: JOB_FINDER_ROUTE_PATHS.reviewQueue,
    });
  if (summary.readyToApply > 0)
    steps.push({
      id: "apply",
      text: `Apply to ${plural(summary.readyToApply, "approved job")}`,
      action: "Apply",
      to: `${JOB_FINDER_ROUTE_PATHS.reviewQueue}?tab=approved`,
    });
  if (summary.jobs.found > 0)
    steps.push({
      id: "triage",
      text: `Sort ${plural(summary.jobs.found, "found job")}`,
      ...(summary.foundToday > 0
        ? { detail: `${summary.foundToday.toLocaleString()} new today.` }
        : {}),
      action: "Sort",
      to: JOB_FINDER_ROUTE_PATHS.discovery,
    });
  return steps;
}

/**
 * Home: what to do next, what is coming up, and how the search is going.
 * Every number comes from one store read and follows the store's changes.
 */
export function HomeScreen() {
  const { summary, error } = useHomeSummary();
  const navigate = useNavigate();
  const shown = summary !== null;
  // Launch is measured to this mark: the first frame with Home's numbers.
  useEffect(() => {
    if (shown && performance.getEntriesByName(HOME_SHOWN_MARK).length === 0)
      performance.mark(HOME_SHOWN_MARK);
  }, [shown]);

  if (!summary)
    return (
      <section aria-label="Home" className="grid gap-4">
        <PageHeader description="Your next step." title="Home" />
        <p className="text-sm text-foreground-soft">
          {error ?? "Loading your numbers…"}
        </p>
      </section>
    );

  const steps = nextSteps(summary);
  const week = summary.days.slice(-7).reduce((sum, day) => sum + day.sent, 0);
  const lastWeek = summary.days
    .slice(-14, -7)
    .reduce((sum, day) => sum + day.sent, 0);
  const sentRecently = Object.entries(summary.recent)
    .filter(([status]) => status !== "applying")
    .reduce((sum, [, count]) => sum + count, 0);
  const heardBack =
    sentRecently -
    summary.recent.applied -
    summary.recent.no_reply -
    summary.recent.withdrawn;
  const interviewing = summary.tracker.assessment + summary.tracker.interview;
  const { interviewsThisWeek } = summary;

  return (
    <section aria-label="Home" className="grid min-w-0 gap-4">
      <PageHeader
        actions={
          <Button
            onClick={() => void navigate(JOB_FINDER_ROUTE_PATHS.discovery)}
            size="toolbar"
            variant="outline"
          >
            Find jobs
          </Button>
        }
        description={
          summary.applyWorking > 0
            ? `Apply is working on ${plural(summary.applyWorking, "application")}.`
            : "Your next step, and how your search is going."
        }
        title="Home"
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
        <section aria-labelledby="home-next" className={PANEL}>
          <h2
            className="mb-2 text-sm font-semibold text-(--text-headline)"
            id="home-next"
          >
            Next up
          </h2>
          {steps.length === 0 ? (
            <p className="py-2 text-sm text-foreground-soft">
              Nothing is waiting on you.
              {summary.resumes.writing > 0
                ? ` ${plural(summary.resumes.writing, "resume")} being written.`
                : ""}
            </p>
          ) : (
            <ul className="grid">
              {steps.map((step, index) => (
                <li
                  className="flex min-w-0 items-center justify-between gap-3 border-t border-(--surface-panel-border) py-2.5 first:border-t-0"
                  key={step.id}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-(--text-headline)">
                      {step.text}
                    </p>
                    {step.detail ? (
                      <p className="text-xs text-foreground-soft">
                        {step.detail}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    onClick={() => void navigate(step.to)}
                    size="compact"
                    variant={index === 0 ? "primary" : "outline"}
                  >
                    {step.action}
                    <ArrowRight aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="home-upcoming" className={PANEL}>
          <h2
            className="mb-2 text-sm font-semibold text-(--text-headline)"
            id="home-upcoming"
          >
            Coming up
          </h2>
          {summary.upcoming.length === 0 ? (
            <p className="py-2 text-sm text-foreground-soft">
              No interviews or reminders in the next 7 days.
            </p>
          ) : (
            <ul className="grid">
              {summary.upcoming.map((item) => (
                <UpcomingItem
                  item={item}
                  key={`${item.jobId}:${item.at}:${item.what}`}
                  onOpen={() =>
                    void navigate(
                      `${JOB_FINDER_ROUTE_PATHS.applications}?jobId=${item.jobId}`,
                    )
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <div
        aria-label="This week"
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        role="group"
      >
        <StatTile
          detail={
            lastWeek === week
              ? "Same as the week before"
              : `${week > lastWeek ? "▲" : "▼"} ${Math.abs(week - lastWeek).toLocaleString()} on the week before`
          }
          label="Sent in the last 7 days"
          value={week.toLocaleString()}
        />
        <StatTile
          detail={`${heardBack.toLocaleString()} of ${sentRecently.toLocaleString()} sent in 30 days`}
          label="Heard back"
          value={
            sentRecently === 0
              ? "–"
              : `${Math.round((heardBack / sentRecently) * 100)}%`
          }
        />
        <StatTile
          detail={
            interviewsThisWeek > 0
              ? `${plural(interviewsThisWeek, "interview")} in the next 7 days`
              : "None scheduled this week"
          }
          label="Assessments and interviews"
          value={interviewing.toLocaleString()}
        />
        <StatTile
          detail={`${summary.tracker.rejected.toLocaleString()} rejected so far`}
          label="Offers"
          value={summary.tracker.offer.toLocaleString()}
        />
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
        <section aria-label="Activity" className={PANEL}>
          <ActivityChart days={summary.days} />
        </section>
        <section aria-label="Where they stand" className={PANEL}>
          <StandingBar recent={summary.recent} />
        </section>
      </div>
    </section>
  );
}

function StatTile(props: { label: string; value: string; detail: ReactNode }) {
  return (
    <div className={cn(PANEL, "grid content-start gap-1 py-3")}>
      <span className="text-xs text-foreground-soft">{props.label}</span>
      <span className="text-(length:--text-heading-2) font-semibold leading-tight text-(--text-headline)">
        {props.value}
      </span>
      <span className="text-xs text-foreground-muted">{props.detail}</span>
    </div>
  );
}

function UpcomingItem(props: { item: HomeUpcoming; onOpen: () => void }) {
  const { item } = props;
  const at = new Date(item.at);
  const overdue = at.getTime() < Date.now();
  const Icon = item.kind === "interview" ? MessagesSquare : CalendarClock;
  return (
    <li className="border-t border-(--surface-panel-border) first:border-t-0">
      <button
        className="flex w-full min-w-0 items-start gap-3 rounded-(--radius-small) py-2 text-left outline-none hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={props.onOpen}
        type="button"
      >
        <Icon
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-foreground-soft"
        />
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-sm font-medium text-(--text-headline)">
            {item.what}
          </span>
          <span className="truncate text-xs text-foreground-soft">
            {item.company} · {item.title}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            overdue
              ? "font-semibold text-(--warning-text)"
              : "text-foreground-soft",
          )}
        >
          {overdue ? `Due ${dueFormat.format(at)}` : whenFormat.format(at)}
        </span>
      </button>
    </li>
  );
}
