import type { ApplicationRecord } from "@nestor/contracts";
import { cn } from "@renderer/lib/utils";
import {
  formatTimestamp,
  getEventTone,
} from "@renderer/features/job-finder/lib/job-finder-utils";
import { getCustomerFacingApplyText } from "./applications-detail-panel-helpers";
import { ApplicationsDisclosureSummary } from "./applications-disclosure-summary";

export function ApplicationsDetailPanelTimelineSection(props: {
  events: ApplicationRecord["events"];
}) {
  // Older records sometimes appended the same site confirmation twice, in
  // different wordings. Show one confirmation per send (minutes apart at
  // most) while preserving the stored history.
  let shownConfirmationAt: number | null = null;
  const events = [...props.events]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .filter((event) => {
      if (event.emphasis !== "positive") return true;
      const key = (getCustomerFacingApplyText(event.detail) ?? "").trim();
      if (
        !/confirmed (receipt|that it received)/iu.test(key) &&
        key !== "Submission confirmed."
      )
        return true;
      const at = Date.parse(event.at);
      if (
        shownConfirmationAt !== null &&
        Math.abs(shownConfirmationAt - at) <= 5 * 60_000
      )
        return false;
      shownConfirmationAt = at;
      return true;
    });

  if (!events.length) {
    return null;
  }

  return (
    <details className="group min-w-0">
      <ApplicationsDisclosureSummary count={events.length}>
        Activity
      </ApplicationsDisclosureSummary>
      <div className="mt-2 grid gap-0">
        {[...events]
          .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
          .map((event) => {
            const tone = getEventTone(event);

            return (
              <article
                key={event.id}
                className="relative grid gap-3 border-l border-border/20 pl-8 pb-8 sm:grid-cols-[1fr]"
              >
                <div
                  className={cn(
                    "absolute -left-1.25 top-1 h-2.5 w-2.5",
                    tone === "positive"
                      ? "bg-positive"
                      : tone === "active"
                        ? "bg-primary"
                        : tone === "critical"
                          ? "bg-destructive"
                          : "border border-border bg-background",
                  )}
                />
                <div>
                  <div className="label-mono-xs">
                    {formatTimestamp(event.at)}
                  </div>
                  <strong
                    className={cn(
                      "mt-1 block text-sm font-medium",
                      tone === "positive"
                        ? "text-positive"
                        : tone === "active"
                          ? "text-primary"
                          : tone === "critical"
                            ? "text-destructive"
                            : "text-foreground",
                    )}
                  >
                    {getCustomerFacingApplyText(event.title)}
                  </strong>
                  {/* A line whose body only repeats its title shows it once. */}
                  {getCustomerFacingApplyText(event.detail)?.trim() !==
                  getCustomerFacingApplyText(event.title)?.trim() ? (
                    <p className="mt-2 text-(length:--text-description) leading-relaxed text-foreground-soft">
                      {getCustomerFacingApplyText(event.detail)}
                    </p>
                  ) : null}
                </div>
              </article>
            );
          })}
      </div>
    </details>
  );
}
