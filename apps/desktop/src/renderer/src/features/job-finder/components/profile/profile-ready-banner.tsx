import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@renderer/components/ui/toast";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";

const PROFILE_READY_BANNER_DISMISSED_KEY =
  "nestor.profile-ready-banner-dismissed-v1";

/**
 * How long after setup completes the news is still news. Past this, opening
 * Profile is a visit to a finished setup, not the moment it finished.
 */
export const PROFILE_READY_NEWS_WINDOW_MS = 10 * 60 * 1000;

function getReadyBannerDismissedKey(completionIdentity: string): string {
  return `${PROFILE_READY_BANNER_DISMISSED_KEY}:${encodeURIComponent(completionIdentity)}`;
}

function readReadyBannerDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether "Core setup is ready" is still news: setup finished moments ago.
 * A setup without a completion time, or one that finished earlier, is old
 * news, so opening Profile after a launch no longer replays it (ADR 0042).
 */
export function isProfileReadyNews(
  completedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!completedAt) return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  return (
    now - completedAtMs >= 0 &&
    now - completedAtMs <= PROFILE_READY_NEWS_WINDOW_MS
  );
}

/**
 * "Core setup is ready" is news, not a standing state: it arrives once, when
 * setup has just completed, as a toast with the one next step, instead of a
 * tinted banner that sat above the profile until someone dismissed it
 * (ADR 0042).
 */
export function ProfileReadyBanner(props: {
  completionIdentity: string;
  completedAt: string | null | undefined;
}) {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const dismissedKey = getReadyBannerDismissedKey(props.completionIdentity);
  const isNews = isProfileReadyNews(props.completedAt);

  useEffect(() => {
    if (!isNews || readReadyBannerDismissed(dismissedKey)) return;
    try {
      localStorage.setItem(dismissedKey, "1");
    } catch {
      // Without storage it may show again on a later visit; that is harmless.
    }
    showToast({
      id: "profile-ready",
      title: "Core setup is ready",
      description: "Optional details can stay empty.",
      tone: "success",
      duration: 8000,
      action: {
        label: "Continue to Find jobs",
        onClick: () => {
          void navigate(JOB_FINDER_ROUTE_PATHS.discovery);
        },
      },
    });
  }, [dismissedKey, isNews, navigate, showToast]);

  return null;
}
