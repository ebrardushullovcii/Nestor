import type { CampaignNotification } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { buildJobFinderContextRoute } from "../lib/job-finder-context-navigation";
import { JOB_FINDER_ROUTE_PATHS } from "../lib/job-finder-route-hrefs";

const kindLabels: Record<CampaignNotification["kind"], string> = {
  digest_ready: "Digest ready",
  strong_match: "Strong match",
  blocked_work: "Blocked work",
  schedule_paused: "Schedule paused",
  rule_effect_update: "Rule update",
};

const NOTIFICATION_ROUTES: Record<CampaignNotification["kind"], string> = {
  digest_ready: "/job-finder/discovery",
  strong_match: "/job-finder/discovery",
  blocked_work: "/job-finder/actions",
  schedule_paused: "/job-finder/discovery",
  rule_effect_update: "/job-finder/discovery",
};
const NOTIFICATION_OPEN_LABELS: Record<CampaignNotification["kind"], string> = {
  digest_ready: "Open Find jobs",
  strong_match: "Open Find jobs",
  blocked_work: "Open Needs you",
  schedule_paused: "Open Find jobs",
  rule_effect_update: "Open Find jobs",
};

/**
 * Blocked work on a job source (a failed source check) lives on Profile >
 * Job sources, not on Needs you: that screen counts application blockers,
 * so "Open Needs you" landed on a screen that said 0 and contradicted the
 * notification.
 */
function getNotificationRoute(
  notification: CampaignNotification,
  applicationRecoveryRecords: ReadonlyMap<string, string>,
): string {
  if (notification.kind === "blocked_work" && notification.sourceTargetId) {
    return JOB_FINDER_ROUTE_PATHS.profileSources;
  }
  if (
    notification.kind === "blocked_work" &&
    notification.jobId &&
    applicationRecoveryRecords.has(notification.jobId)
  ) {
    return buildJobFinderContextRoute(JOB_FINDER_ROUTE_PATHS.applications, {
      applicationRecordId:
        applicationRecoveryRecords.get(notification.jobId) ?? null,
      jobId: notification.jobId,
    });
  }
  return NOTIFICATION_ROUTES[notification.kind];
}

function getNotificationOpenLabel(
  notification: CampaignNotification,
  applicationRecoveryRecords: ReadonlyMap<string, string>,
): string {
  if (notification.kind === "blocked_work" && notification.sourceTargetId) {
    return "Open job sources";
  }
  if (
    notification.kind === "blocked_work" &&
    notification.jobId &&
    applicationRecoveryRecords.has(notification.jobId)
  ) {
    return "Open Applications";
  }
  return NOTIFICATION_OPEN_LABELS[notification.kind];
}

function compareNewestFirst(
  left: CampaignNotification,
  right: CampaignNotification,
): number {
  const leftMs = Date.parse(left.createdAt);
  const rightMs = Date.parse(right.createdAt);
  if (leftMs !== rightMs) {
    if (Number.isNaN(leftMs)) return 1;
    if (Number.isNaN(rightMs)) return -1;
    return rightMs - leftMs;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

// The same shape the rest of Job Finder uses. `toLocaleString()` printed
// "9/10/2026, 1:19:52 AM" — a numeric month/day that reads as 9 October
// outside the US, with seconds nobody needs. One formatter for every row:
// building one per notification cost Home about 10 ms per render.
const createdAtFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

function formatCreatedAt(createdAt: string): string {
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return createdAt;
  return createdAtFormat.format(new Date(parsed));
}

export function CampaignNotificationCenter(props: {
  errorMessage?: string | null;
  loading?: boolean;
  notifications: readonly CampaignNotification[];
  applicationRecoveryRecords?: readonly {
    jobId: string;
    applicationRecordId: string;
  }[];
  /**
   * Work the rest of the app is already reporting (the sidebar badges).
   * Notifications must never claim nothing has happened while these exist.
   */
  outstandingWork?: readonly {
    id: string;
    label: string;
    /**
     * What the button opens. A bare "Open" beside three different rows told
     * the reader nothing about where any of them went.
     */
    openLabel: string;
    onOpen: () => void;
  }[];
  pendingMarkAll: boolean;
  pendingNotificationId: (notificationId: string) => boolean;
  onMarkAllRead: () => void;
  onMarkRead: (notificationId: string) => void;
  /** Where a notification's "Open" goes; the row reads as dead without it. */
  onNavigate?: (route: string) => void;
}) {
  const notifications = [...props.notifications].sort(compareNewestFirst);
  const applicationRecoveryRecords = new Map(
    (props.applicationRecoveryRecords ?? []).map((record) => [
      record.jobId,
      record.applicationRecordId,
    ]),
  );
  const unreadCount = props.notifications.filter(
    (notification) => notification.unread,
  ).length;
  const hasUnread = unreadCount > 0;
  const hasNotifications = props.notifications.length > 0;
  const outstandingWork = props.outstandingWork ?? [];

  return (
    <section
      aria-label="Notifications"
      className="surface-panel-shell grid gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-(--text-headline)">
            Notifications
          </h2>
          {/* Same breathing room between title and description as the other
              sections on this page. */}
          {/* The empty state below already explains what lands here. */}
          {hasNotifications ? (
            <p className="mt-3 text-xs text-foreground-muted">
              {props.notifications.length === unreadCount
                ? `${unreadCount} unread`
                : `${props.notifications.length} total · ${unreadCount} unread`}
            </p>
          ) : null}
        </div>
        {hasUnread ? (
          <Button
            disabled={props.pendingMarkAll}
            onClick={props.onMarkAllRead}
            pending={props.pendingMarkAll}
            size="sm"
            type="button"
            variant="outline"
          >
            Mark all read
          </Button>
        ) : null}
      </div>

      {props.loading ? (
        <p
          aria-live="polite"
          className="rounded-(--radius-field) border border-border-subtle p-4 text-sm text-foreground-soft"
        >
          Loading notifications…
        </p>
      ) : props.errorMessage ? (
        <p
          aria-live="assertive"
          className="rounded-(--radius-field) border border-critical/35 p-4 text-sm text-foreground-soft"
          role="alert"
        >
          {props.errorMessage}
        </p>
      ) : (
        <>
          {outstandingWork.length > 0 ? (
            <ul
              className="grid gap-2"
              data-testid="notifications-outstanding-work"
            >
              {outstandingWork.map((entry) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-field) border border-accent/40 bg-accent/5 p-3"
                  key={entry.id}
                >
                  <span className="min-w-0 break-words text-sm text-foreground-soft">
                    {entry.label}
                  </span>
                  <Button
                    onClick={entry.onOpen}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    {entry.openLabel}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {!hasNotifications && outstandingWork.length === 0 ? (
            <p className="rounded-(--radius-field) border border-border-subtle p-4 text-sm text-foreground-soft">
              Nothing here yet. After a search finishes, matches scoring 86% or
              better and work that needs you show up here.
            </p>
          ) : null}
          {hasNotifications ? (
            <ul className="grid max-h-80 gap-2 overflow-y-auto pr-1">
              {notifications.map((notification) => {
                const pending = props.pendingNotificationId(notification.id);
                return (
                  <li
                    className={`grid gap-1.5 rounded-(--radius-field) border p-3 ${notification.unread ? "border-primary/60 bg-primary/10" : "border-border-subtle"}`}
                    key={notification.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-(--text-headline)">
                          {notification.title}
                        </p>
                        <p className="mt-0.5 text-xs text-foreground-muted">
                          {kindLabels[notification.kind]} ·{" "}
                          {formatCreatedAt(notification.createdAt)}
                          {notification.unread ? (
                            <span className="ml-2 rounded-full border border-primary/60 bg-primary/10 px-1.5 py-0.5 font-semibold text-foreground">
                              Unread
                            </span>
                          ) : null}
                        </p>
                      </div>
                      {notification.unread ? (
                        <Button
                          disabled={pending}
                          onClick={() => props.onMarkRead(notification.id)}
                          pending={pending}
                          size="xs"
                          type="button"
                          variant="ghost"
                        >
                          Mark read
                        </Button>
                      ) : (
                        <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-foreground-muted">
                          Read
                        </span>
                      )}
                    </div>
                    {notification.body ? (
                      <p className="text-sm text-foreground-soft">
                        {notification.kind === "blocked_work" &&
                        notification.sourceTargetId
                          ? "This job source could not be opened. Your saved jobs and other sources are still available. Open job sources to try again."
                          : notification.body}
                      </p>
                    ) : null}
                    {props.onNavigate ? (
                      <div>
                        <Button
                          onClick={() =>
                            props.onNavigate?.(
                              getNotificationRoute(
                                notification,
                                applicationRecoveryRecords,
                              ),
                            )
                          }
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          {getNotificationOpenLabel(
                            notification,
                            applicationRecoveryRecords,
                          )}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
