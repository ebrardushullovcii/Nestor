import { useRef } from "react";

import { useScrollEdgeFade } from "@renderer/components/ui/scroll-edge-fade";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs";
import {
  formatSectionProgressLabel,
  getSectionProgressState,
  type ProfileSection,
  type SectionProgress,
} from "../../lib/profile-screen-progress";

export interface ProfileSectionDescriptor {
  description: string;
  id: ProfileSection;
  label: string;
  progress: SectionProgress;
  needsConfirmationCount?: number;
}

interface ProfileSectionTabsProps {
  activeSection: ProfileSection;
  onSectionChange: (section: ProfileSection) => void;
  panelId: string;
  sections: readonly ProfileSectionDescriptor[];
}

function countRequiredRemaining(progress: SectionProgress): number {
  if (getSectionProgressState(progress) !== "remaining") {
    return 0;
  }

  return Math.max(
    0,
    (progress.required?.total ?? 0) - (progress.required?.filled ?? 0),
  );
}

export function ProfileSectionTabs({
  activeSection,
  onSectionChange,
  panelId,
  sections,
}: ProfileSectionTabsProps) {
  // Where the six tabs do not fit (a narrow window, larger text) the strip
  // scrolls sideways inside the page, its edge faded where more tabs wait.
  const root = useRef<HTMLDivElement>(null);
  useScrollEdgeFade(root, "[data-profile-section-tabs]");
  return (
    // These tabs used to be a bespoke full-width grid of bordered boxes, each
    // with a check icon and a truncated "REQUIRED DONE" / "OPTIONAL ADDED"
    // chip, and a selected state expressed as a different box border. Nothing
    // else in the app looked like that. They now run on the shared Tabs
    // primitive - the same treatment as Resume Studio's Preview/Tools strip -
    // so the selected state is the shared primary underline, there are no
    // per-tab boxes, and the labels are plain text that never ellipsizes.
    //
    // Spread evenly across the page in 12px text, the six labels read as
    // column headings, and people did not notice they could click them. They
    // now sit left-aligned at body size with a hover fill, the conventional
    // look of section tabs. No icons: every section tab in the app (Profile,
    // Settings, the list tabs) is words only, one idiom.
    //
    // Activation is Radix's default `automatic`, deliberately: arrowing to a
    // tab opens that section, which is the expected tab-pattern behaviour and
    // matches the rest of the app's tabs. It is safe here because focus only
    // ever reaches a NON-selected trigger by explicit user intent:
    //   - Tab-key entry lands on the strip, which forwards focus to the
    //     already-selected trigger (no activation).
    //   - A mouse click activates on mousedown anyway.
    //   - The one programmatic focus of `#<section>-tab` is the
    //     `focusProfileImportSuggestion` fallback, and its caller
    //     (`handleReviewImportSuggestion`) has already switched to that exact
    //     section, so the trigger it focuses is the selected one. Were that
    //     ever to change, opening the section the suggestion lives in is the
    //     intended outcome regardless.
    // Do not "fix" this to `activationMode="manual"` without a flow that
    // focuses a tab it does not mean to open.
    <Tabs
      className="min-w-0 gap-0 pb-1"
      ref={root}
      onValueChange={(value) => onSectionChange(value as ProfileSection)}
      value={activeSection}
    >
      <TabsList
        aria-label="Profile sections"
        // One row from 640px up. Below that the strip stays a single row and
        // scrolls sideways rather than stacking: the old two-column stack cost
        // ~85px of the section pane, which is what pushed a newly selected
        // section's content below the fold at 1200x640 and 1024x720.
        className="w-full max-w-full justify-start gap-1 overflow-x-auto overflow-y-hidden group-data-[orientation=horizontal]/tabs:h-auto"
        data-profile-section-tabs
        data-scroll-x
        variant="line"
      >
        {sections.map((section) => {
          const remaining = countRequiredRemaining(section.progress);

          return (
            <TabsTrigger
              // The panel is owned by the Profile screen, so the exact panel
              // and trigger ids are kept instead of Radix's generated pair:
              // the section deep links focus `#<section>-tab`, and the panel
              // is labelled by it.
              aria-controls={panelId}
              className="flex-none gap-2 rounded-t-(--radius-small) text-(length:--text-body) group-data-[orientation=horizontal]/tabs:px-3.5 group-data-[orientation=horizontal]/tabs:py-2.5"
              data-profile-section-progress-state={getSectionProgressState(
                section.progress,
              )}
              id={`${section.id}-tab`}
              key={section.id}
              // Radix activates a trigger on mousedown; this keeps a plain
              // click (and any programmatic click) changing the section too.
              onClick={() => onSectionChange(section.id)}
              value={section.id}
            >
              {section.label}
              {section.needsConfirmationCount ? (
                <span className="text-(length:--text-tiny) text-(--warning-text)">
                  {section.needsConfirmationCount} to confirm
                </span>
              ) : null}
              {remaining > 0 ? (
                <>
                  {/* Completion state is out of the label: no chip words and no
                      check on finished sections. What survives is the one
                      actionable fact - how many required fields a section still
                      needs - in words, like "2 to confirm", never a circled
                      figure (a count beside a tab elsewhere is a plain number
                      of rows, "Found 1,242"). */}
                  <span
                    aria-hidden
                    className="text-(length:--text-tiny) tabular-nums text-foreground-muted"
                    data-profile-section-remaining-count
                    title={formatSectionProgressLabel(
                      section.id,
                      section.progress,
                    )}
                  >
                    {remaining} to fill
                  </span>
                  <span className="sr-only">
                    {formatSectionProgressLabel(section.id, section.progress)}
                  </span>
                </>
              ) : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
