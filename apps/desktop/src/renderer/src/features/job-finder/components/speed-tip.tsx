import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { speedLevelOf } from "@nestor/contracts";
import { JOB_FINDER_ROUTE_PATHS } from "../lib/job-finder-route-hrefs";
import { useToast } from "@renderer/components/ui/toast";
import { afterFirstScreen } from "../lib/after-first-screen";

const SPEED_TIP_SEEN_KEY = "nestor.speed-tip-seen-v1";
const SPEED_TIP_ID = "speed-tip";
// Windows reports a 16 GB PC as about 15.8 GB, so 15 counts as 16.
const STRONG_MEMORY_GB = 15;
const STRONG_CORES = 8;
const SHOW_AFTER_MS = 4000;
/** Shown once, briefly: it goes by itself unless the person is on it. */
const SHOWN_FOR_MS = 12_000;

/** A computer that runs Faster comfortably: 16 GB of memory and 8 cores. */
export function isStrongComputer(device: {
  memoryGb?: number | undefined;
  cores?: number | undefined;
}): boolean {
  return (
    (device.memoryGb ?? 0) >= STRONG_MEMORY_GB &&
    (device.cores ?? 0) >= STRONG_CORES
  );
}

function tipSeen(): boolean {
  try {
    return localStorage.getItem(SPEED_TIP_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

function markTipSeen(): void {
  try {
    localStorage.setItem(SPEED_TIP_SEEN_KEY, "1");
  } catch {
    // Without storage the tip simply shows again next time.
  }
}

/**
 * Once, on a strong computer still on Standard, after the first search has
 * found jobs (a first run has its own next step): a short note that this
 * computer can run more at once, with a link to the Speed setting. It is a
 * side note, never the screen's main action, so it arrives as a toast in the
 * header's feedback slot, never over a list's rows or a page's work; it goes
 * by itself after twelve seconds and never comes back once it has shown.
 */
export function SpeedTip() {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast, dismissToast } = useToast();
  const inSetup = location.pathname.startsWith("/job-finder/profile/setup");

  useEffect(() => {
    if (tipSeen() || inSetup) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopListening: (() => void) | undefined;
    const check = () => {
      // Hosts without the bridge (tests of other screens) show no tip.
      if (!window.nestor?.ping || !window.nestor.jobs?.run) return;
      void Promise.all([
        window.nestor.ping(),
        window.nestor.jobs.run("get_settings", {}),
        window.nestor.jobs.run("stage_counts", {}),
      ]).then(
        ([device, settings, counts]) => {
          if (
            !live ||
            tipSeen() ||
            !isStrongComputer(device) ||
            speedLevelOf(settings) !== "standard"
          )
            return;
          const searched =
            counts.found +
              counts.hidden +
              counts.shortlisted +
              counts.resume +
              counts.applied >
            0;
          if (!searched) {
            // Before the first search: wait for jobs to arrive.
            stopListening ??= window.nestor.jobs.onChange?.((change) => {
              if (!change.stages.includes("found")) return;
              stopListening?.();
              stopListening = undefined;
              timer = setTimeout(check, SHOW_AFTER_MS);
            });
            return;
          }
          // Seen once shown: it never comes back.
          markTipSeen();
          showToast({
            id: SPEED_TIP_ID,
            title: "This computer can run more at once",
            description: "A faster Speed uses more memory and AI limits.",
            action: {
              label: "Speed setting",
              onClick: () =>
                void navigate(
                  `${JOB_FINDER_ROUTE_PATHS.settings}#settings-speed`,
                ),
            },
            duration: SHOWN_FOR_MS,
            scope: "app",
          });
        },
        () => undefined,
      );
    };
    afterFirstScreen(() => {
      timer = setTimeout(check, SHOW_AFTER_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      stopListening?.();
    };
  }, [inSetup, navigate, showToast]);

  // Guided setup is its own task: the tip never sits over it.
  useEffect(() => {
    if (inSetup) dismissToast(SPEED_TIP_ID);
  }, [dismissToast, inSetup]);

  return null;
}
