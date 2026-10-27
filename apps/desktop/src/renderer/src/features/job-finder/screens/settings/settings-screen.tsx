import {
  JOB_FINDER_SETTINGS_SECTIONS,
  JOB_FINDER_SETTINGS_SECTION_IDS,
  settingsSectionElementId,
  type JobFinderSettingsSection,
} from "@nestor/contracts";
import type {
  AppearanceTheme,
  DesktopBrowserState,
  JobFinderSettings,
  ResumeTemplateDefinition,
  UpdateAiBehaviorInput,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import {
  Activity,
  MonitorSmartphone,
  Palette,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { cn } from "@renderer/lib/cn";
import { SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CANCEL_CLASS } from "../../lib/job-finder-shell-gutters";
import { PageHeaderStack } from "../../components/page-header";
import {
  SETTINGS_AI_BEHAVIOR_LABEL,
  SettingsAiBehaviorSection,
} from "./settings-ai-behavior-section";
import { SettingsAppDeviceSection } from "./settings-app-device-section";
import {
  SETTINGS_RESUME_LOOK_LABEL,
  SettingsApplicationDefaultsSection,
} from "./settings-application-defaults-section";
import { SettingsApplyModeSection } from "./settings-apply-mode-section";
import {
  SettingsDirtySectionsProvider,
  useSettingsDirtySections,
} from "./settings-dirty-sections";
import { SettingsApplyingWritingSection } from "./settings-applying-writing-section";
import { SettingsRuntimeSummary } from "./settings-runtime-summary";
import { focusSettingsSection } from "./settings-section-anchor";
import { SettingsSupportControls } from "./settings-support-controls";
import { SettingsUnsavedChangesBar } from "./settings-unsaved-changes-bar";
import { SettingsWorkspaceControls } from "./settings-workspace-controls";

// `Application authority` was product vocabulary, not user vocabulary.
// The boundary and every permission it describes are
// ADR 0022: one switch decides whether Job Finder sends the application or
// leaves it filled in for the person to send. The section is named for the
// thing it decides.
export const SETTINGS_APPLICATION_AUTHORITY_LABEL =
  JOB_FINDER_SETTINGS_SECTIONS["application-authority"].label;

const sectionIcons: Record<JobFinderSettingsSection, typeof MonitorSmartphone> =
  {
    "app-device": MonitorSmartphone,
    "ai-behavior": Sparkles,
    "application-defaults": Palette,
    "application-authority": Send,
    diagnostics: Activity,
    "danger-zone": Trash2,
  };
const settingsSections = JOB_FINDER_SETTINGS_SECTION_IDS.map((section) => {
  const id = settingsSectionElementId(section);
  const entry = JOB_FINDER_SETTINGS_SECTIONS[section];
  const within: JobFinderSettingsSection | undefined =
    "within" in entry ? entry.within : undefined;
  return {
    ...entry,
    id,
    headingId: `${id}-heading`,
    href: `#${id}`,
    icon: sectionIcons[section],
    // The tab that shows this section as current.
    tabId: within ? settingsSectionElementId(within) : id,
  };
});
// One tab per home; a section within another has none of its own.
const settingsTabs = settingsSections.filter(
  (section) => section.tabId === section.id,
);

// The sticky section subnav sits over the page scroller. Its wrapped height is
// layout-dependent (it wraps at native zoom levels and narrow windows), so its
// scroll clearance is derived from the rendered nav height plus a breathing
// gap, with a raised fallback that covers the widest realistic wrap before the
// first measurement lands (and where ResizeObserver is unavailable).
export const SETTINGS_SUBNAV_BOTTOM_GAP_PX = 12;
export const SETTINGS_SUBNAV_WRAPPED_ROW_HEIGHT_PX = 40;
export const SETTINGS_SUBNAV_WRAPPED_ROW_GAP_PX = 4;
export const SETTINGS_SUBNAV_VERTICAL_PADDING_PX = 16;
export const SETTINGS_SUBNAV_SCROLL_OFFSET_FALLBACK_PX =
  SETTINGS_SUBNAV_WRAPPED_ROW_HEIGHT_PX * 2 +
  SETTINGS_SUBNAV_WRAPPED_ROW_GAP_PX +
  SETTINGS_SUBNAV_VERTICAL_PADDING_PX +
  SETTINGS_SUBNAV_BOTTOM_GAP_PX;
export const SETTINGS_SUBNAV_OFFSET_VARIABLE = "--settings-subnav-offset";

const SUBNAV_EDGE_FADE = "2.5rem";

/**
 * Fades the edge of the sideways-scrolling section row that has more sections
 * past it. Written to the row directly: it changes with every scroll, and as
 * React state it re-rendered the whole Settings screen each time.
 */
function paintSubnavEdges(row: HTMLElement | null): void {
  if (!row) return;
  const before = row.scrollLeft > 1;
  const after = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
  if (before) row.dataset.moreBefore = "true";
  else delete row.dataset.moreBefore;
  if (after) row.dataset.moreAfter = "true";
  else delete row.dataset.moreAfter;
  const start = before ? `transparent, black ${SUBNAV_EDGE_FADE}` : "black";
  const end = after
    ? `black calc(100% - ${SUBNAV_EDGE_FADE}), transparent`
    : "black";
  const mask =
    before || after ? `linear-gradient(to right, ${start}, ${end})` : "";
  row.style.maskImage = mask;
  row.style.setProperty("-webkit-mask-image", mask);
}

// The unsaved-changes bar is sticky to the bottom of the same scroller, so the
// last card needs at least the bar's own height of clearance beneath it —
// otherwise the bar sits over live card text with no scroll position that
// frees it. The bar wraps (narrow windows, several dirty sections), so the
// clearance is measured rather than assumed, with a wrap-aware fallback until
// the first measurement lands.
export const SETTINGS_UNSAVED_BAR_BOTTOM_GAP_PX = 12;
export const SETTINGS_UNSAVED_BAR_WRAPPED_ROW_HEIGHT_PX = 32;
export const SETTINGS_UNSAVED_BAR_VERTICAL_PADDING_PX = 16;
export const SETTINGS_UNSAVED_BAR_CLEARANCE_FALLBACK_PX =
  SETTINGS_UNSAVED_BAR_WRAPPED_ROW_HEIGHT_PX * 2 +
  SETTINGS_UNSAVED_BAR_VERTICAL_PADDING_PX +
  SETTINGS_UNSAVED_BAR_BOTTOM_GAP_PX;
export const SETTINGS_UNSAVED_BAR_CLEARANCE_VARIABLE =
  "--settings-unsaved-bar-clearance";

// Every section after the first starts below the fold. The browser skips
// their layout and paint until they come near the screen, and remembers the
// real height once shown, so the page does not move under the person.
const SETTINGS_LATER_SECTION_CLASS =
  "scroll-mt-(--settings-subnav-offset) min-w-0 [content-visibility:auto] [contain-intrinsic-size:auto_720px]";

export function SettingsScreen(props: {
  availableResumeTemplates: readonly ResumeTemplateDefinition[];
  browser: DesktopBrowserState | null;
  onResetWorkspace: () => void | Promise<boolean | void>;
  // Scoped saves resolve false when the save did not commit; sections treat
  // that as a failure instead of showing a local saved message.
  onUpdateAppearanceTheme: (
    theme: AppearanceTheme,
  ) => Promise<boolean | void> | void;
  onUpdateAiBehavior: (
    input: UpdateAiBehaviorInput,
    options?: { undo?: () => void },
  ) => Promise<boolean | void> | void;
  onUpdateApplicationDefaults: (
    input: UpdateApplicationDefaultsInput,
  ) => Promise<boolean | void> | void;
  onUpdateWorkspaceBehavior: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<boolean | void> | void;
  settings: JobFinderSettings;
}) {
  const {
    availableResumeTemplates,
    browser,
    onResetWorkspace,
    onUpdateAiBehavior,
    onUpdateAppearanceTheme,
    onUpdateApplicationDefaults,
    onUpdateWorkspaceBehavior,
    settings,
  } = props;

  // Measured sizes are written to these elements from ResizeObservers, which
  // report after layout: measuring before paint forced the whole screen's
  // layout early, and keeping the numbers in state rendered it all again.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const subnavRef = useRef<HTMLElement | null>(null);
  const subnavRowRef = useRef<HTMLDivElement | null>(null);
  const unsavedBarRef = useRef<HTMLDivElement | null>(null);
  // Labels at one colour with no current-item marker are a list, not
  // navigation. The active section is tracked so the nav can say where the
  // reader is.
  const [activeSectionId, setActiveSectionId] = useState<string>(
    settingsTabs[0]!.id,
  );
  const location = useLocation();
  const { dirtySections, registry } = useSettingsDirtySections();

  useLayoutEffect(() => {
    // A hash names a whole section or one group inside it (Find jobs links to
    // the search-pickiness group), and the nav marks the owning section.
    const targetId = location.hash.slice(1);
    if (!targetId) {
      return;
    }
    const target = document.getElementById(targetId);
    const owningSection = settingsSections.find(
      (section) =>
        section.id === targetId ||
        (target !== null &&
          document.getElementById(section.id)?.contains(target) === true),
    );
    if (owningSection && focusSettingsSection(targetId)) {
      setActiveSectionId(owningSection.tabId);
    }
  }, [location.hash, location.key]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }

    const visibleRatios = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visibleRatios.set(
            entry.target.id,
            entry.isIntersecting ? entry.intersectionRatio : 0,
          );
        }

        let mostVisibleId: string | null = null;
        let mostVisibleRatio = 0;
        // Document order breaks ties, so scrolling never flickers between two
        // equally visible neighbours.
        for (const section of settingsSections) {
          const ratio = visibleRatios.get(section.id) ?? 0;
          if (ratio > mostVisibleRatio) {
            mostVisibleRatio = ratio;
            mostVisibleId = section.id;
          }
        }

        if (mostVisibleId) {
          setActiveSectionId(
            settingsSections.find((section) => section.id === mostVisibleId)
              ?.tabId ?? mostVisibleId,
          );
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    for (const section of settingsSections) {
      const target = document.getElementById(section.id);
      if (target) {
        observer.observe(target);
      }
    }

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const subnav = subnavRef.current;
    if (!subnav || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      // The row inside resizes with the band, so its faded edges are
      // re-measured here too.
      paintSubnavEdges(subnavRowRef.current);
      const height = subnav.getBoundingClientRect().height;
      // Unmeasured layouts (jsdom) report 0px; keep the raised wrap-aware
      // floor so a wrapped subnav can never cover the headings it scrolls to.
      if (height <= 0) {
        return;
      }
      rootRef.current?.style.setProperty(
        SETTINGS_SUBNAV_OFFSET_VARIABLE,
        `${Math.ceil(height) + SETTINGS_SUBNAV_BOTTOM_GAP_PX}px`,
      );
    });
    observer.observe(subnav);
    return () => observer.disconnect();
  }, []);

  // The row scrolls sideways when it is wider than the page, so the current
  // section's link is brought into view as the page scrolls. Only the row's
  // own scrollLeft moves; the page's vertical scroll is never touched.
  useEffect(() => {
    const row = subnavRowRef.current;
    const link = row?.querySelector<HTMLElement>('[aria-current="location"]');
    if (row && link) {
      const start = link.offsetLeft - row.offsetLeft;
      const end = start + link.offsetWidth + 12;
      if (start < row.scrollLeft) {
        row.scrollLeft = Math.max(0, start - 12);
      } else if (end > row.scrollLeft + row.clientWidth) {
        row.scrollLeft = end - row.clientWidth;
      }
    }
    paintSubnavEdges(row ?? null);
  }, [activeSectionId]);

  const hasUnsavedBar = dirtySections.length > 0;
  useEffect(() => {
    const bar = unsavedBarRef.current;
    if (!bar || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const height = bar.getBoundingClientRect().height;
      // Unmeasured layouts (jsdom) report 0px; keep the wrap-aware floor so
      // the last card can always be scrolled clear of the sticky bar.
      if (height <= 0) {
        return;
      }
      rootRef.current?.style.setProperty(
        SETTINGS_UNSAVED_BAR_CLEARANCE_VARIABLE,
        `${Math.ceil(height) + SETTINGS_UNSAVED_BAR_BOTTOM_GAP_PX}px`,
      );
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, [hasUnsavedBar]);

  const handleSectionAnchorClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const isUnmodifiedPrimaryActivation =
      event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey;

    if (!isUnmodifiedPrimaryActivation) {
      return;
    }

    event.preventDefault();

    const sectionId = event.currentTarget.getAttribute("href")?.slice(1);
    if (!sectionId) {
      return;
    }

    if (!focusSettingsSection(sectionId)) {
      return;
    }

    setActiveSectionId(sectionId);
  };

  return (
    <section
      // The unsaved-changes bar is `sticky bottom-0`, and a sticky box is
      // clamped to its containing block. With the shell's own bottom gutter
      // still in place that block ended 40px above the window, so the bar came
      // to rest there with live cards rendering under and below it — it read
      // as a strip dropped into the middle of the page. The route cancels the
      // shell gutter (the bar is this route's bottom edge and paints its own)
      // and drops its trailing `pb-8` for the same reason: any padding after
      // the bar is padding the bar cannot cover at the end of the scroll.
      className={cn(
        "grid min-w-0 gap-3",
        SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CANCEL_CLASS,
      )}
      ref={rootRef}
      style={
        {
          // Floors until the observers report the real sizes.
          [SETTINGS_SUBNAV_OFFSET_VARIABLE]: `${SETTINGS_SUBNAV_SCROLL_OFFSET_FALLBACK_PX}px`,
          [SETTINGS_UNSAVED_BAR_CLEARANCE_VARIABLE]: hasUnsavedBar
            ? `${SETTINGS_UNSAVED_BAR_CLEARANCE_FALLBACK_PX}px`
            : "0px",
        } as CSSProperties
      }
    >
      <PageHeaderStack
        description="Choose how the AI works for you, and set reusable defaults for resumes and applications."
        title="Settings"
      />

      <nav
        aria-label="Settings sections"
        // Fully opaque with its own edge: a translucent blurred band let the
        // page scroll visibly through it and cut headings and helper text in
        // half as they passed underneath.
        //
        // `top-0` is the only correct sticky offset here, at every width. The
        // scroll owner is the shell's `<main>`, which already begins below the
        // fixed shell header (the shell pads its content wrapper by the header
        // height). A width-specific `sm:top-[7.25rem]` re-applied that same
        // header height a second time, so at scroll 0 the band was pushed 33px
        // past its own flow box and painted over the first card's top border,
        // padding and heading. Do not reintroduce a header-height offset here.
        //
        // The links use the same look as the Profile section tabs (the shared
        // `line` tabs): body-size labels with an icon, a hover fill, and the
        // primary underline on the current section. One row that scrolls
        // sideways, like Profile's strip, so the band never wraps into a
        // second row of underlined tabs.
        className="sticky top-0 z-30 -mx-1 min-w-0 border-b border-(--surface-panel-border) bg-(--background) px-1 shadow-[0_6px_16px_rgba(0,0,0,0.12)]"
        ref={subnavRef}
      >
        <div
          // The row hides its scrollbar (it sat under the tabs like a second
          // rule) and fades the edge that has more sections past it instead.
          // `min-w-0` here and on the band keeps the row's full width from
          // stretching the page; only the row scrolls.
          className="flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden px-3 scroll-px-3 [scrollbar-width:none]"
          data-settings-subnav-row
          onScroll={(event) => paintSubnavEdges(event.currentTarget)}
          ref={subnavRowRef}
        >
          {settingsTabs.map((section) => {
            const isActive = section.id === activeSectionId;
            const isDestructive = section.tone === "destructive";

            return (
              <a
                aria-current={isActive ? "location" : undefined}
                className={cn(
                  "relative inline-flex min-h-10 min-w-10 flex-none items-center justify-center gap-1.5 rounded-t-(--radius-small) px-2.5 py-2.5 text-(length:--text-body) font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 [&_svg]:size-4 [&_svg]:shrink-0",
                  // The current-section underline, drawn like the line tabs'.
                  "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:opacity-0 after:transition-opacity",
                  isActive &&
                    !isDestructive &&
                    "text-foreground after:bg-primary after:opacity-100",
                  isActive &&
                    isDestructive &&
                    "text-(--destructive) after:bg-(--destructive) after:opacity-100",
                  !isActive &&
                    !isDestructive &&
                    "text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:text-foreground",
                  !isActive &&
                    isDestructive &&
                    "text-(--destructive) hover:bg-(--destructive)/10",
                )}
                href={section.href}
                key={section.id}
                onFocus={(event) => {
                  const row = subnavRowRef.current;
                  if (!row) return;
                  const start = event.currentTarget.offsetLeft - row.offsetLeft;
                  const end = start + event.currentTarget.offsetWidth + 12;
                  if (start - 12 < row.scrollLeft)
                    row.scrollLeft = Math.max(0, start - 12);
                  else if (end > row.scrollLeft + row.clientWidth)
                    row.scrollLeft = end - row.clientWidth;
                  paintSubnavEdges(row);
                }}
                onClick={handleSectionAnchorClick}
              >
                <section.icon aria-hidden="true" />
                {section.label}
              </a>
            );
          })}
        </div>
      </nav>

      <SettingsDirtySectionsProvider registry={registry}>
        <section
          aria-labelledby="settings-ai-behavior-heading"
          className="scroll-mt-(--settings-subnav-offset) min-w-0"
          id="settings-ai-behavior"
          tabIndex={-1}
        >
          <h2 className="sr-only" id="settings-ai-behavior-heading">
            {SETTINGS_AI_BEHAVIOR_LABEL}
          </h2>
          <SettingsAiBehaviorSection
            onUpdateAiBehavior={onUpdateAiBehavior}
            onUpdateWorkspaceBehavior={onUpdateWorkspaceBehavior}
            settings={settings}
          />
        </section>

        <section
          aria-labelledby="settings-application-defaults-heading"
          className={SETTINGS_LATER_SECTION_CLASS}
          id="settings-application-defaults"
          tabIndex={-1}
        >
          <h2 className="sr-only" id="settings-application-defaults-heading">
            {SETTINGS_RESUME_LOOK_LABEL}
          </h2>
          <SettingsApplicationDefaultsSection
            availableResumeTemplates={availableResumeTemplates}
            onUpdateApplicationDefaults={onUpdateApplicationDefaults}
            settings={settings}
          />
        </section>

        <section
          aria-labelledby="settings-application-authority-heading"
          className={SETTINGS_LATER_SECTION_CLASS}
          id="settings-application-authority"
          tabIndex={-1}
        >
          {/* No sr-only h2 here: this section's visible heading already says
              exactly the region name, so a hidden duplicate above it read the
              same sentence twice at two different heading levels. */}
          <SettingsApplyModeSection
            salaryDisclosure={settings.salaryDisclosure ?? "pause_for_user"}
            onSaveSalaryDisclosure={async (salaryDisclosure) => {
              const saved = await onUpdateApplicationDefaults({
                salaryDisclosure,
              });
              if (saved === false)
                throw new Error("Your pay choice did not save.");
            }}
            headingId="settings-application-authority-heading"
            mode={settings.applicationAutomationMode ?? "confirm_before_submit"}
            onSave={async (input) => {
              const saved = await onUpdateApplicationDefaults({
                applicationAutomationMode: input.mode,
              });
              if (saved === false) {
                throw new Error("The application mode did not save.");
              }
            }}
          >
            <SettingsApplyingWritingSection
              onUpdateAiBehavior={onUpdateAiBehavior}
              settings={settings}
            />
          </SettingsApplyModeSection>
        </section>

        <section
          aria-labelledby="settings-app-device-heading"
          className={SETTINGS_LATER_SECTION_CLASS}
          id="settings-app-device"
          tabIndex={-1}
        >
          <h2 className="sr-only" id="settings-app-device-heading">
            App & device
          </h2>
          <SettingsAppDeviceSection
            onUpdateAppearanceTheme={onUpdateAppearanceTheme}
            onUpdateWorkspaceBehavior={onUpdateWorkspaceBehavior}
            settings={settings}
          />
        </section>

        <section
          aria-labelledby="settings-diagnostics-heading"
          className={SETTINGS_LATER_SECTION_CLASS}
          id="settings-diagnostics"
          tabIndex={-1}
        >
          <h2 className="sr-only" id="settings-diagnostics-heading">
            Diagnostics
          </h2>
          <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.32fr)_minmax(0,0.92fr)] xl:items-start">
            <SettingsRuntimeSummary browser={browser} settings={settings} />
            <div className="grid min-w-0 gap-3">
              <SettingsSupportControls />
            </div>
          </div>
        </section>

        <section
          aria-labelledby="settings-danger-zone-heading"
          // Scroll clearance for the sticky save bar below. Without it the
          // bar painted over the last card's live text at the bottom of the
          // scroll region, and no scroll position freed it.
          className="scroll-mt-(--settings-subnav-offset) mb-3 min-w-0 pb-(--settings-unsaved-bar-clearance)"
          id="settings-danger-zone"
          tabIndex={-1}
        >
          <h2 className="sr-only" id="settings-danger-zone-heading">
            Delete everything
          </h2>
          <SettingsWorkspaceControls onResetWorkspace={onResetWorkspace} />
        </section>
      </SettingsDirtySectionsProvider>

      <SettingsUnsavedChangesBar
        dirtySections={dirtySections}
        ref={unsavedBarRef}
      />
    </section>
  );
}
