import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Gauge, X } from "lucide-react";
import { speedLevelOf } from "@nestor/contracts";
import { JOB_FINDER_ROUTE_PATHS } from "../lib/job-finder-route-hrefs";
import { afterFirstScreen } from "../lib/after-first-screen";

const SPEED_TIP_SEEN_KEY = "nestor.speed-tip-seen-v1";
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
 * Once, on a strong computer still on Standard: a small note at the top right
 * that this PC can run more at once, with a link to the Speed setting. It is
 * a side note, never the screen's main action: compact, quiet, gone by itself
 * after a few seconds, and never shown again once it has been seen.
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
            ) {
              // Seen once shown: it never comes back.
              markTipSeen();
              setVisible(true);
            }
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

  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!visible || held) return;
    const timer = setTimeout(() => setVisible(false), SHOWN_FOR_MS);
    return () => clearTimeout(timer);
  }, [visible, held]);

  if (!visible) return null;
  const close = () => {
    markTipSeen();
    setVisible(false);
  };
  return (
    <aside
      aria-labelledby="speed-tip-title"
      className="fixed top-[8rem] z-40 w-[min(19rem,calc(100vw-2rem))] rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-raised) px-3 py-2.5 text-sm shadow-md xl:top-[4.5rem]"
      data-speed-tip
      onBlur={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      style={{
        right: "calc(var(--assistant-sidebar-reserved, 0px) + 1rem)",
      }}
    >
      <div className="flex items-start gap-2">
        <Gauge
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-foreground-soft"
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          {/* A side note's title: body size, not the screen heading's. */}
          <h2
            className="font-sans text-sm font-medium leading-5 text-foreground"
            id="speed-tip-title"
          >
            This PC can run more at once
          </h2>
          <p className="leading-5 text-foreground-soft">
            A faster Speed does more at once, using more memory and AI limits.{" "}
            <button
              className="font-medium text-(--link) underline underline-offset-2 hover:text-(--link-hover)"
              onClick={() => {
                close();
                void navigate(
                  `${JOB_FINDER_ROUTE_PATHS.settings}#settings-speed`,
                );
              }}
              type="button"
            >
              Speed setting
            </button>
          </p>
        </div>
        <button
          aria-label="Dismiss the Speed tip"
          className="-mr-1 rounded-(--radius-small) p-1 text-foreground-soft hover:bg-secondary hover:text-foreground"
          onClick={close}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
    </aside>
  );
}
