import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Gauge, X } from "lucide-react";
import { speedLevelOf } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { JOB_FINDER_ROUTE_PATHS } from "../lib/job-finder-route-hrefs";
import { afterFirstScreen } from "../lib/after-first-screen";

const SPEED_TIP_SEEN_KEY = "nestor.speed-tip-seen-v1";
// Windows reports a 16 GB PC as about 15.8 GB, so 15 counts as 16.
const STRONG_MEMORY_GB = 15;
const STRONG_CORES = 8;
const SHOW_AFTER_MS = 4000;

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
 * Once, on a strong computer still on Standard: a tip at the top right that
 * Job Finder can run faster, at the cost of memory and AI limits, with a
 * button to the Speed setting. Dismissing it or using it ends it for good.
 */
export function SpeedTip() {
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const inSetup = location.pathname.startsWith("/job-finder/profile/setup");

  useEffect(() => {
    if (tipSeen() || inSetup) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    afterFirstScreen(() => {
      timer = setTimeout(() => {
        // Hosts without the bridge (tests of other screens) show no tip.
        if (!window.nestor?.ping || !window.nestor.jobs?.run) return;
        void Promise.all([
          window.nestor.ping(),
          window.nestor.jobs.run("get_settings", {}),
        ]).then(
          ([device, settings]) => {
            if (
              live &&
              !tipSeen() &&
              isStrongComputer(device) &&
              speedLevelOf(settings) === "standard"
            )
              setVisible(true);
          },
          () => undefined,
        );
      }, SHOW_AFTER_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [inSetup]);

  if (!visible) return null;
  const close = () => {
    markTipSeen();
    setVisible(false);
  };
  return (
    <aside
      aria-labelledby="speed-tip-title"
      className="fixed top-[8rem] z-40 w-[min(22rem,calc(100vw-2rem))] rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-raised) p-4 shadow-lg xl:top-[4.5rem]"
      data-speed-tip
      style={{
        right: "calc(var(--assistant-sidebar-reserved, 0px) + 1rem)",
      }}
    >
      <div className="flex items-start gap-3">
        <Gauge aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <div className="grid min-w-0 flex-1 gap-1">
          <h2 className="font-semibold" id="speed-tip-title">
            This computer can run Job Finder faster
          </h2>
          <p className="text-sm leading-5 text-foreground-soft">
            It has plenty of memory. A faster Speed level searches and applies
            to more jobs at once, but uses more memory and spends your AI limits
            sooner.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              onClick={() => {
                close();
                void navigate(
                  `${JOB_FINDER_ROUTE_PATHS.settings}#settings-speed`,
                );
              }}
              size="sm"
            >
              Open Speed setting
            </Button>
            <Button onClick={close} size="sm" variant="ghost">
              Not now
            </Button>
          </div>
        </div>
        <button
          aria-label="Dismiss the Speed tip"
          className="-mr-1 -mt-1 rounded-(--radius-small) p-1 text-foreground-soft hover:bg-secondary hover:text-foreground"
          onClick={close}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
    </aside>
  );
}
