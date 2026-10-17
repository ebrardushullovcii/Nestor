import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@renderer/components/ui/toast";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";

const PROFILE_READY_BANNER_DISMISSED_KEY =
  "nestor.profile-ready-banner-dismissed-v1";

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
 * "Core setup is ready" is news, not a standing state: it arrives once per
 * completed setup as a toast with the one next step, instead of a tinted
 * banner that sat above the profile until someone dismissed it (ADR 0042).
 */
export function ProfileReadyBanner(props: { completionIdentity: string }) {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const dismissedKey = getReadyBannerDismissedKey(props.completionIdentity);

  useEffect(() => {
    if (readReadyBannerDismissed(dismissedKey)) return;
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
  }, [dismissedKey, navigate, showToast]);

  return null;
}
