import { useEffect, useId, useState } from "react";
import {
  MEMORY_PER_PAGE_MB,
  SPEED_LEVELS,
  speedLevelOf,
  speedLevelPages,
  speedLevelValues,
  type JobFinderSettings,
  type SpeedLevel,
  type UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";

/** Where the one-time tip and the assistant send the person. */
export const SETTINGS_SPEED_ANCHOR = "settings-speed";

function memoryText(megabytes: number): string {
  return megabytes >= 1000
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${Math.round(megabytes / 50) * 50} MB`;
}

/** What a level does, in the person's terms. */
export function describeSpeedLevel(level: SpeedLevel): string {
  const limits = SPEED_LEVELS[level];
  return `Up to ${limits.searchPages} pages for searching, ${limits.applyAtOnce} applications and ${limits.fitRequests} fit checks at once, with the ${limits.waitingPages} most recent forms waiting for you kept open.`;
}

function extraMemoryText(level: SpeedLevel): string {
  const extra =
    (speedLevelPages(level) - speedLevelPages("standard")) * MEMORY_PER_PAGE_MB;
  return memoryText(extra);
}

export function SettingsSpeedControl({
  onUpdateWorkspaceBehavior,
  settings,
}: {
  onUpdateWorkspaceBehavior: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<boolean | void> | void;
  settings: JobFinderSettings;
}) {
  const headingId = useId();
  const saved = speedLevelOf(settings);
  const [level, setLevel] = useState<SpeedLevel>(saved);
  const [failed, setFailed] = useState(false);
  useEffect(() => setLevel(saved), [saved]);

  // A level acts when picked, like the switches: it saves at once and goes
  // back if the save fails.
  const choose = (next: SpeedLevel) => {
    if (next === level) return;
    const previous = level;
    setLevel(next);
    setFailed(false);
    const revert = () => {
      setLevel(previous);
      setFailed(true);
    };
    try {
      void Promise.resolve(
        onUpdateWorkspaceBehavior({ speedLevel: next }),
      ).then((ok) => {
        if (ok === false) revert();
      }, revert);
    } catch {
      revert();
    }
  };

  return (
    <div
      className="grid min-w-0 scroll-mt-(--settings-subnav-offset) gap-2 outline-none"
      id={SETTINGS_SPEED_ANCHOR}
      tabIndex={-1}
    >
      <div className="grid gap-1">
        <h4 className="font-medium" id={headingId}>
          Speed
        </h4>
        <p className="text-sm text-foreground-soft">
          How much Job Finder does at once while it searches and applies.
        </p>
      </div>
      <div
        aria-labelledby={headingId}
        className="relative flex w-fit min-w-0 max-w-full flex-wrap items-center gap-0.5 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 p-0.5"
        role="group"
      >
        {speedLevelValues.map((value) => {
          const isSelected = level === value;
          return (
            <button
              aria-pressed={isSelected}
              className={`inline-flex min-h-9 items-center justify-center rounded-(--radius-small) px-3.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 ${isSelected ? "bg-primary/10 text-foreground ring-1 ring-primary/70" : "text-foreground-soft hover:bg-secondary hover:text-foreground"}`}
              key={value}
              onClick={() => choose(value)}
              type="button"
            >
              {SPEED_LEVELS[value].label}
            </button>
          );
        })}
      </div>
      <p className="max-w-[72ch] text-sm text-foreground-soft">
        {describeSpeedLevel(level)}
        {level === "standard"
          ? " Works well on most computers."
          : ` Uses up to about ${extraMemoryText(level)} more memory than Standard when it is busiest.`}
      </p>
      {level !== "standard" ? (
        <p
          className="max-w-[72ch] rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm leading-6 text-(--warning-text)"
          role="note"
        >
          {SPEED_LEVELS[level].label} uses more memory and spends your AI limits
          faster. Choose it on a computer with plenty of memory, and go back to
          Standard if things slow down.
        </p>
      ) : null}
      {failed ? (
        <p className="text-sm text-foreground-soft" role="status">
          That change was not saved. Pick the level again.
        </p>
      ) : null}
    </div>
  );
}
