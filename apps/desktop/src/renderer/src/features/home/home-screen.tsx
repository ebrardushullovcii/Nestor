import type {
  HomeSummary,
  HomeUpcoming,
  ProfileSetupStatus,
} from "@nestor/contracts";
import {
  formatDate,
  formatDateTime,
} from "@renderer/features/job-finder/lib/format-date";
import {
  ArrowRight,
  Check,
  CalendarClock,
  ChartColumn,
  MessagesSquare,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { PageHeader } from "@renderer/features/job-finder/components/page-header";
import { JOB_FINDER_ROUTE_PATHS } from "@renderer/features/job-finder/lib/job-finder-route-hrefs";
import { plural } from "@renderer/features/job-lists";
import { cn } from "@renderer/lib/cn";

import { ActivityChart, StandingBar } from "./home-charts";
import { formatHomePercent } from "./home-percent";
import { markFirstScreenShown } from "@renderer/features/job-finder/lib/after-first-screen";
import { useLaunchReads } from "@renderer/features/job-finder/lib/launch-reads";

import { useHomeSummary } from "./use-home-summary";

const HOME_SHOWN_MARK = "job-finder:home:numbers-shown";

const PANEL =
  "surface-panel-shell min-w-0 rounded-(--radius-panel) border border-(--surface-panel-border) p-4";

interface NextStep {
  id: string;
  text: string;
  detail?: string;
  action: string;
  to: string;
}

const NEEDS_YOU_PATH = "/job-finder/actions";
const SETUP_PATH = "/job-finder/profile/setup";

/**
 * What is waiting on the person, most urgent first. Until guided setup is
 * finished, finishing it comes first: searching and applying both use the
 * profile it builds. An unknown setup state (the launch read failed) adds
 * nothing rather than nagging a set-up workspace.
 */
export function nextSteps(
  summary: HomeSummary,
  setupStatus: ProfileSetupStatus | null = null,
): NextStep[] {
  const steps: NextStep[] = [];
  if (setupStatus === "not_started")
    steps.push({
      id: "setup",
      text: "Set up your profile",
      detail: "Start from your resume; five short steps, saved as you go.",
      action: "Set up",
      to: SETUP_PATH,
    });
  else if (setupStatus === "in_progress")
    steps.push({
      id: "setup",
      text: "Finish setting up your profile",
      detail: "Job Finder searches and applies with it.",
      action: "Continue setup",
      to: SETUP_PATH,
    });
  const { questions, signIns, checks } = summary.needsYou;
  // Sites as Needs you counts them (one per host); the sign-ins on them
  // are named beside it when the two numbers differ.
  const signInSites = Math.max(
    signIns > 0 ? 1 : 0,
    Math.min(signIns, summary.needsYou.signInSites),
  );
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
      text: `Sign in to ${plural(signInSites, "job site")}`,
      detail:
        signInSites === signIns
          ? "Searching or applying there waits until you do."
          : `${signIns.toLocaleString()} sign-ins on ${signInSites === 1 ? "this site" : "these sites"}; searching or applying there waits until you sign in.`,
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
  if (summary.resumes.toReview > 0) {
    // The same number as Shortlisted's "N to review": every shortlisted
    // job, with how many of their resumes are ready to read when some are
    // still being written (or failed), never one count beside another.
    const { toReview, writing, failed } = summary.resumes;
    const shortlisted = toReview + writing + failed;
    steps.push({
      id: "review",
      ...(shortlisted === toReview
        ? {
            text: `Read ${plural(toReview, "resume")} and approve ${toReview === 1 ? "it" : "them"}`,
          }
        : {
            text: `Review ${plural(shortlisted, "shortlisted job")}`,
            detail: [
              `${toReview.toLocaleString()} ${toReview === 1 ? "resume" : "resumes"} ready to read`,
              writing > 0 ? `${writing.toLocaleString()} being written` : null,
              failed > 0
                ? `${failed.toLocaleString()} couldn’t be written`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")
              .concat("."),
          }),
      action: "Review",
      to: JOB_FINDER_ROUTE_PATHS.reviewQueue,
    });
  }
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
  const { summary, error, retry } = useHomeSummary();
  const setupStatus =
    useLaunchReads().context?.profileSetupState?.status ?? null;
  const navigate = useNavigate();
  const shown = summary !== null;
  // Launch is measured to this mark: the first frame with Home's numbers.
  // Main holds its background services until then, so they never compete
  // with the first screen.
  useEffect(() => {
    if (shown && performance.getEntriesByName(HOME_SHOWN_MARK).length === 0) {
      performance.mark(HOME_SHOWN_MARK);
      markFirstScreenShown();
      window.nestor.firstScreenShown?.();
    }
  }, [shown]);

  if (!summary)
    return error ? (
      <section aria-label="Home" className="grid gap-4">
        <PageHeader
          description="Your next step, and how your search is going."
          title="Home"
        />
        <div
          className={cn(PANEL, "flex flex-wrap items-center gap-3")}
          role="alert"
        >
          <p className="min-w-0 flex-1 text-sm text-(--text-headline)">
            Home could not read your numbers.{" "}
            <span className="text-foreground-soft">{error}</span>
          </p>
          <Button onClick={retry} size="compact" variant="outline">
            Try again
          </Button>
        </div>
      </section>
    ) : (
      <HomeSkeleton />
    );

  const steps = nextSteps(summary, setupStatus);
  const setupDone = setupStatus === null || setupStatus === "completed";
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
  // The charts only draw something once an application was sent; before
  // that they were two empty axes and a hint to point at nothing.
  const everSent =
    summary.days.some((day) => day.sent > 0 || day.replies > 0) ||
    sentRecently > 0 ||
    Object.values(summary.tracker).some((count) => count > 0);

  return (
    <section aria-label="Home" className="grid min-w-0 gap-4">
      <PageHeader
        actions={
          setupDone ? (
            <Button
              onClick={() => void navigate(JOB_FINDER_ROUTE_PATHS.discovery)}
              size="toolbar"
              variant="outline"
            >
              Find jobs
            </Button>
          ) : null
        }
        description={describeApply(summary)}
        title="Home"
      />

      {everSent ? (
        <HomeDashboard
          interviewing={interviewing}
          interviewsThisWeek={interviewsThisWeek}
          heardBack={heardBack}
          lastWeek={lastWeek}
          navigate={(to) => void navigate(to)}
          sentRecently={sentRecently}
          steps={steps}
          summary={summary}
          week={week}
        />
      ) : (
        <FirstRunHome
          navigate={(to) => void navigate(to)}
          setupStatus={setupStatus}
          steps={steps}
          summary={summary}
        />
      )}
    </section>
  );
}

/**
 * What Apply is doing, by real state: "Apply is working on 1 application ·
 * 1 waiting on you · 2 ready to send". Applications waiting on the person
 * are never counted as Apply's work.
 */
export function describeApply(summary: HomeSummary): string {
  const { needsYou, ready } = summary.applyWaiting;
  const working = Math.max(0, summary.applyWorking - needsYou - ready);
  // A count that leads the line names what it counts ("3 applications
  // waiting on you"): alone under the header's Needs you badge, a bare "3
  // waiting on you" read as a different number from the same thing.
  const count = (n: number, lead: boolean) =>
    lead ? plural(n, "application") : n.toLocaleString();
  const parts = [
    working > 0
      ? `Apply is working on ${plural(working, "application")}`
      : null,
    needsYou > 0 ? `${count(needsYou, working === 0)} waiting on you` : null,
    ready > 0
      ? `${count(ready, working === 0 && needsYou === 0)} ready to send`
      : null,
  ].filter(Boolean);
  return parts.length > 0
    ? `${parts.join(" · ")}.`
    : "Your next step, and how your search is going.";
}

/** Home once something was sent: next up, coming up, the week, the charts. */
function HomeDashboard(props: {
  steps: NextStep[];
  summary: HomeSummary;
  navigate: (to: string) => void;
  week: number;
  lastWeek: number;
  sentRecently: number;
  heardBack: number;
  interviewing: number;
  interviewsThisWeek: number;
}) {
  const {
    steps,
    summary,
    navigate,
    week,
    lastWeek,
    sentRecently,
    heardBack,
    interviewing,
    interviewsThisWeek,
  } = props;
  return (
    <>
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
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
                    onClick={() => navigate(step.to)}
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

        {/* With nothing coming up it is one quiet line beside Next up, not
            a second card of the same weight holding a single sentence. */}
        <section
          aria-labelledby="home-upcoming"
          className={
            summary.upcoming.length === 0 ? "min-w-0 px-4 py-4" : PANEL
          }
        >
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
                    navigate(
                      `${JOB_FINDER_ROUTE_PATHS.applications}?jobId=${item.jobId}`,
                    )
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* One divided strip, not four cards: the numbers are one reading. */}
      <div
        aria-label="This week"
        className={cn(PANEL, "grid min-w-0 p-0 sm:grid-cols-2 xl:grid-cols-4")}
        role="group"
      >
        <StatTile
          detail={
            lastWeek === week
              ? "Same as the week before"
              : `${week > lastWeek ? "▲" : "▼"} ${Math.abs(week - lastWeek).toLocaleString()} ${week > lastWeek ? "more" : "fewer"} than the week before`
          }
          label="Sent in the last 7 days"
          value={week.toLocaleString()}
        />
        <StatTile
          detail={
            sentRecently === 0
              ? "Nothing sent in the last 30 days"
              : `${heardBack.toLocaleString()} of ${sentRecently.toLocaleString()} sent in 30 days`
          }
          label="Heard back"
          value={
            sentRecently === 0
              ? "–"
              : formatHomePercent(heardBack, sentRecently)
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
          detail={
            summary.tracker.offer > 0
              ? `${plural(summary.tracker.offer, "offer")} so far`
              : "None yet"
          }
          label="Offers"
          value={summary.tracker.offer.toLocaleString()}
        />
      </div>

      {/* Side by side (xl) the two cards end on one line: the row is as
          tall as "Where they stand", and the sent-per-day plot takes what
          the chart's other parts leave (at least 4rem), instead of a fixed
          10rem that ran the chart ~96px past its neighbour. */}
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)] xl:items-stretch">
        <section
          aria-label="Activity"
          className={cn(PANEL, "xl:flex xl:flex-col")}
        >
          <ActivityChart days={summary.days} />
        </section>
        <section aria-label="Where they stand" className={PANEL}>
          <StandingBar recent={summary.recent} />
        </section>
      </div>
    </>
  );
}

/** The path to a first application, in order, with where the person is on it. */
function firstRunPath(
  summary: HomeSummary,
  setupStatus: ProfileSetupStatus | null,
): { id: string; text: string; detail: string; done: boolean }[] {
  const searched =
    summary.jobs.found +
      summary.jobs.hidden +
      summary.jobs.shortlisted +
      summary.jobs.resume +
      summary.jobs.applied >
    0;
  const shortlisted =
    summary.jobs.shortlisted + summary.jobs.resume + summary.jobs.applied > 0;
  return [
    {
      id: "profile",
      text: "Set up your profile",
      detail: "From your resume, in five short steps.",
      done: setupStatus === null || setupStatus === "completed",
    },
    {
      id: "search",
      text: "Search your job sites",
      detail: "Every job found is checked for fit.",
      done: searched,
    },
    {
      id: "shortlist",
      text: "Shortlist and approve a resume",
      detail: "Each shortlisted job gets a resume written for it.",
      done: shortlisted && summary.jobs.resume + summary.jobs.applied > 0,
    },
    {
      id: "apply",
      text: "Apply",
      detail: "Apply fills in the form; you send it.",
      done: false,
    },
  ];
}

/**
 * Home before anything was sent: no dashboard of zeros. The one next step
 * leads, large, with the path to a first application beneath it and where
 * the person is on it; the numbers and charts arrive with the first
 * application.
 */
function FirstRunHome(props: {
  steps: NextStep[];
  summary: HomeSummary;
  setupStatus: ProfileSetupStatus | null;
  navigate: (to: string) => void;
}) {
  const next = props.steps[0] ?? null;
  const later = props.steps.slice(1);
  const path = firstRunPath(props.summary, props.setupStatus);
  const current = path.findIndex((step) => !step.done);
  // The next step is the path's current one ("Set up your profile" in Next
  // up and again as step 1): say it once, in the path, with its action.
  const nextInPath =
    next !== null && current >= 0 && path[current]?.text === next.text;
  return (
    // The same frame as the Home it grows into: the path where Next up
    // will be, Coming up beside it, and the week's four numbers under them,
    // waiting ("–") for the first application. The first screen reads as
    // one composed page, not one card in a corner.
    <div className="grid min-w-0 gap-4" data-home-first-run>
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
        <div className="grid min-w-0 gap-4">
          {nextInPath && later.length === 0 ? null : (
            <section aria-labelledby="home-next" className={cn(PANEL, "p-6")}>
              <h2
                className="text-xs font-medium text-foreground-soft"
                id="home-next"
              >
                {nextInPath ? "Also waiting" : "Next up"}
              </h2>
              {nextInPath ? null : next ? (
                <div className="mt-2 flex min-w-0 flex-wrap items-end justify-between gap-4">
                  <div className="grid min-w-0 gap-1">
                    <p className="font-display text-(length:--text-heading-2) font-semibold text-(--text-headline)">
                      {next.text}
                    </p>
                    {next.detail ? (
                      <p className="text-sm text-foreground-soft">
                        {next.detail}
                      </p>
                    ) : null}
                  </div>
                  <Button onClick={() => props.navigate(next.to)}>
                    {next.action}
                    <ArrowRight aria-hidden />
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-sm text-foreground-soft">
                  Nothing is waiting on you.
                </p>
              )}
              {later.length > 0 ? (
                <ul className="mt-4 grid border-t border-(--surface-panel-border) pt-2">
                  {later.map((step) => (
                    <li
                      className="flex min-w-0 items-center justify-between gap-3 py-2"
                      key={step.id}
                    >
                      <p className="min-w-0 text-sm text-(--text-headline)">
                        {step.text}
                      </p>
                      <Button
                        onClick={() => props.navigate(step.to)}
                        size="compact"
                        variant="outline"
                      >
                        {step.action}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          )}
          <section aria-labelledby="home-path" className={PANEL}>
            <h2
              className="mb-3 text-sm font-semibold text-(--text-headline)"
              id="home-path"
            >
              Your first application
            </h2>
            <ol className="grid gap-3">
              {path.map((step, index) => (
                <li
                  aria-current={index === current ? "step" : undefined}
                  className="flex min-w-0 items-start gap-3"
                  data-home-path-step={
                    step.done ? "done" : index === current ? "current" : "later"
                  }
                  key={step.id}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
                      step.done
                        ? "border-transparent bg-primary-fill text-primary-fill-foreground"
                        : index === current
                          ? "border-primary text-primary"
                          : "border-(--surface-panel-border) text-foreground-muted",
                    )}
                  >
                    {step.done ? <Check className="size-3" /> : index + 1}
                  </span>
                  <span className="grid min-w-0">
                    <span
                      className={cn(
                        "text-sm",
                        index === current
                          ? "font-medium text-(--text-headline)"
                          : "text-foreground-soft",
                      )}
                    >
                      {step.text}
                      <span className="sr-only">
                        {step.done
                          ? " (done)"
                          : index === current
                            ? " (next)"
                            : ""}
                      </span>
                    </span>
                    <span className="text-xs text-foreground-soft">
                      {step.detail}
                    </span>
                  </span>
                  {nextInPath && index === current && next ? (
                    <Button
                      className="ml-auto shrink-0 self-center"
                      onClick={() => props.navigate(next.to)}
                    >
                      {next.action}
                      <ArrowRight aria-hidden />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        </div>
        <section aria-labelledby="home-upcoming" className="min-w-0 px-4 py-4">
          <h2
            className="mb-2 text-sm font-semibold text-(--text-headline)"
            id="home-upcoming"
          >
            Coming up
          </h2>
          <p className="py-2 text-sm text-foreground-soft">
            Interviews and reminders show here once you apply.
          </p>
        </section>
      </div>
      <section
        aria-label="Your numbers"
        className={cn(PANEL, "grid min-w-0 p-0")}
      >
        <div
          className="grid min-w-0 sm:grid-cols-2 xl:grid-cols-4"
          role="group"
          aria-label="This week"
        >
          <StatTile
            detail="Counted from your first send"
            label="Sent in the last 7 days"
            value="–"
          />
          <StatTile
            detail="Replies within 30 days"
            label="Heard back"
            value="–"
          />
          <StatTile
            detail="Logged in Applications"
            label="Assessments and interviews"
            value="–"
          />
          <StatTile detail="Logged in Applications" label="Offers" value="–" />
        </div>
        <p className="flex items-center gap-2 border-t border-(--surface-panel-border) px-4 py-3 text-xs text-foreground-soft">
          <ChartColumn aria-hidden className="size-4 shrink-0" />
          Numbers and charts of what you send and who replies appear after your
          first application.
        </p>
      </section>
    </div>
  );
}

/** A skeleton line one text line tall, for the blocks below. */
function Bar(props: { className: string }) {
  return <span className={cn("skeleton block", props.className)} />;
}

/**
 * Home while its numbers load: every block the loaded Home has, the same
 * size and in the same place (next up, coming up, four tiles, two charts),
 * so nothing moves when the numbers land.
 */
function HomeSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Home"
      className="grid min-w-0 gap-4"
      data-home-skeleton
    >
      <PageHeader
        description="Your next step, and how your search is going."
        title="Home"
      />
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
        {[3, 2].map((rows, panel) => (
          <div className={PANEL} key={panel}>
            <div className="mb-2 flex h-5 items-center">
              <Bar className="h-3 w-20" />
            </div>
            {Array.from({ length: rows }, (_, row) => (
              <div
                className="flex min-h-14 items-center justify-between gap-3 border-t border-(--surface-panel-border) py-2.5 first:border-t-0"
                key={row}
              >
                <div className="grid flex-1 gap-1.5">
                  <Bar className={row % 2 ? "h-3 w-2/5" : "h-3 w-3/5"} />
                  <Bar className="h-2.5 w-1/4" />
                </div>
                {panel === 0 ? <Bar className="h-8 w-20" /> : null}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div
        className={cn(PANEL, "grid min-w-0 p-0 sm:grid-cols-2 xl:grid-cols-4")}
      >
        {[0, 1, 2, 3].map((tile) => (
          <div
            className="grid content-start gap-1 border-(--surface-panel-border) px-4 py-3 not-first:border-t sm:nth-2:border-t-0 sm:even:border-l xl:not-first:border-t-0 xl:not-first:border-l"
            key={tile}
          >
            <span className="flex h-4 items-center">
              <Bar className="h-2.5 w-24" />
            </span>
            <span className="flex h-7 items-center">
              <Bar className="h-5 w-10" />
            </span>
            <span className="flex h-4 items-center">
              <Bar className="h-2.5 w-32" />
            </span>
          </div>
        ))}
      </div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
        <div className={cn(PANEL, "grid content-start gap-3")}>
          <Bar className="h-3 w-28" />
          <Bar className="h-40 w-full" />
          <Bar className="h-12 w-full" />
        </div>
        <div className={cn(PANEL, "grid content-start gap-3")}>
          <Bar className="h-3 w-28" />
          <Bar className="h-6 w-full" />
          {[0, 1, 2, 3].map((row) => (
            <Bar className="h-3 w-full" key={row} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StatTile(props: { label: string; value: string; detail: ReactNode }) {
  return (
    <div className="grid content-start gap-1 border-(--surface-panel-border) px-4 py-3 not-first:border-t sm:nth-2:border-t-0 sm:even:border-l xl:not-first:border-t-0 xl:not-first:border-l">
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
        className="flex w-full min-w-0 items-start gap-3 rounded-(--radius-small) py-2 text-left outline-none hover:bg-secondary/40 focus-ring"
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
          {overdue ? `Due ${formatDate(at)}` : formatDateTime(at)}
        </span>
      </button>
    </li>
  );
}
