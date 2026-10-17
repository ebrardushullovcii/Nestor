import { Eye, EyeOff, Lock, LockOpen, MoveDown, MoveUp } from "lucide-react";
import type { ResumeDraftBullet, ResumeDraftSection } from "@nestor/contracts";
import {
  getResumeEntryBulletTargetId,
  getResumeSectionBulletTargetId,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/cn";
import { EmptyState } from "../../components/empty-state";
import { StatusBadge } from "../../components/status-badge";
import {
  createResumeDraftPatch,
  updateEntryBulletText,
  updateSectionBulletText,
} from "./resume-section-editor-helpers";
import { isGeneratedResumeOrigin } from "./resume-workspace-utils";

interface ResumeBulletListEditorProps {
  bulletRows: readonly ResumeDraftBullet[];
  controlIdPrefix: string;
  /**
   * Skills and keywords are one short token per row. Rendering them with the
   * prose row height (a 3.9rem textarea stacked under its own 32px action
   * row) cost ~90px per word and was most of why the tools pane ran to
   * thousands of pixels. Compact puts the single-line field and its actions
   * on one row.
   */
  density?: "comfortable" | "compact";
  disabled: boolean;
  emptyState?: { description: string; title: string };
  entryId?: string | null;
  section: ResumeDraftSection;
  showGeneratedMarkers: boolean;
  onChange: (nextSection: ResumeDraftSection) => void;
  onPatch: (
    patch: ReturnType<typeof createResumeDraftPatch>,
    revisionReason?: string | null,
  ) => void;
}

const bulletTextareaClassName = "min-h-[3.9rem] [field-sizing:content]";
// A skill is one short token, so its field is one line beside its actions.
const compactBulletTextareaClassName =
  "min-h-8 w-full min-w-0 flex-1 resize-none py-1 leading-6 [field-sizing:content]";
// One 32px icon row per bullet keeps the editor dense; every control keeps
// its exact accessible name through aria-label and shows it as a tooltip.
const bulletActionClassName = "text-foreground-soft";

export function ResumeBulletListEditor(props: ResumeBulletListEditorProps) {
  const {
    bulletRows,
    controlIdPrefix,
    density = "comfortable",
    disabled,
    emptyState,
    entryId = null,
    section,
    showGeneratedMarkers,
    onChange,
    onPatch,
  } = props;
  const sectionLocked = section.locked;
  const isCompact = density === "compact";

  if (bulletRows.length === 0 && emptyState) {
    return (
      <EmptyState
        description={emptyState.description}
        title={emptyState.title}
      />
    );
  }

  return (
    <>
      {bulletRows.map((bullet, bulletIndex) => {
        const isEntryBullet = entryId !== null;
        const bulletNumber = bulletIndex + 1;
        const bulletId = isEntryBullet
          ? `${controlIdPrefix}_entry_bullet_${bullet.id}`
          : `${controlIdPrefix}_bullet_${bullet.id}`;
        const targetId = isEntryBullet
          ? getResumeEntryBulletTargetId(section.id, entryId, bullet.id)
          : getResumeSectionBulletTargetId(section.id, bullet.id);
        const rowLocked = disabled || sectionLocked;
        const moveUpDisabled = rowLocked || bulletIndex <= 0;
        const moveDownDisabled =
          rowLocked || bulletIndex >= bulletRows.length - 1;
        const textDisabled = rowLocked || bullet.locked;
        const bulletScope = isEntryBullet ? "entry " : "";
        const includeLabel = `${bullet.included ? "Hide" : "Show"} ${bulletScope}bullet ${bulletNumber}`;
        const lockLabel = bullet.locked ? "Unlock" : "Lock";
        const moveUpLabel = `Move ${bulletScope}bullet ${bulletNumber} up`;
        const moveDownLabel = `Move ${bulletScope}bullet ${bulletNumber} down`;

        return (
          <div
            className={cn(
              "min-w-0 gap-1",
              isCompact ? "flex items-center" : "grid",
            )}
            data-resume-bullet-row-density={density}
            key={bullet.id}
          >
            <div className="flex h-8 min-w-0 shrink-0 items-center gap-1">
              <Button
                aria-label={includeLabel}
                className={bulletActionClassName}
                disabled={rowLocked}
                onClick={() =>
                  onPatch(
                    createResumeDraftPatch({
                      bulletId: bullet.id,
                      entryId,
                      idPrefix: isEntryBullet
                        ? `resume_patch_entry_bullet_include_${bullet.id}`
                        : `resume_patch_bullet_include_${bullet.id}`,
                      newIncluded: !bullet.included,
                      operation: "toggle_include",
                      sectionId: section.id,
                    }),
                    `${bullet.included ? "Hidden" : "Shown"} bullet`,
                  )
                }
                size="icon-sm"
                title={includeLabel}
                type="button"
                variant="ghost"
              >
                {bullet.included ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </Button>
              <Button
                aria-label={lockLabel}
                className={bulletActionClassName}
                disabled={rowLocked}
                onClick={() =>
                  onPatch(
                    createResumeDraftPatch({
                      bulletId: bullet.id,
                      entryId,
                      idPrefix: isEntryBullet
                        ? `resume_patch_entry_bullet_lock_${bullet.id}`
                        : `resume_patch_bullet_lock_${bullet.id}`,
                      newLocked: !bullet.locked,
                      operation: "set_lock",
                      sectionId: section.id,
                    }),
                    `${bullet.locked ? "Unlocked" : "Locked"} bullet`,
                  )
                }
                aria-pressed={bullet.locked}
                size="icon-sm"
                title={`${lockLabel} ${bulletScope}bullet ${bulletNumber}`}
                type="button"
                variant="ghost"
              >
                {bullet.locked ? (
                  <LockOpen className="size-4" />
                ) : (
                  <Lock className="size-4" />
                )}
              </Button>
              <Button
                aria-label={moveUpLabel}
                className={bulletActionClassName}
                disabled={moveUpDisabled}
                onClick={() => {
                  const anchor =
                    bulletIndex > 0 ? bulletRows[bulletIndex - 1] : null;
                  if (!anchor) {
                    return;
                  }

                  onPatch(
                    createResumeDraftPatch({
                      anchorBulletId: anchor.id,
                      bulletId: bullet.id,
                      entryId,
                      idPrefix: isEntryBullet
                        ? `resume_patch_entry_bullet_up_${bullet.id}`
                        : `resume_patch_bullet_up_${bullet.id}`,
                      operation: "move_bullet",
                      position: "before",
                      sectionId: section.id,
                    }),
                    "Moved bullet up",
                  );
                }}
                size="icon-sm"
                title={moveUpLabel}
                type="button"
                variant="ghost"
              >
                <MoveUp className="size-4" />
              </Button>
              <Button
                aria-label={moveDownLabel}
                className={bulletActionClassName}
                disabled={moveDownDisabled}
                onClick={() => {
                  const anchor = bulletRows[bulletIndex + 1] ?? null;
                  if (!anchor) {
                    return;
                  }

                  onPatch(
                    createResumeDraftPatch({
                      anchorBulletId: anchor.id,
                      bulletId: bullet.id,
                      entryId,
                      idPrefix: isEntryBullet
                        ? `resume_patch_entry_bullet_down_${bullet.id}`
                        : `resume_patch_bullet_down_${bullet.id}`,
                      operation: "move_bullet",
                      position: "after",
                      sectionId: section.id,
                    }),
                    "Moved bullet down",
                  );
                }}
                size="icon-sm"
                title={moveDownLabel}
                type="button"
                variant="ghost"
              >
                <MoveDown className="size-4" />
              </Button>
              {showGeneratedMarkers &&
              isGeneratedResumeOrigin(bullet.origin) ? (
                <StatusBadge className="ml-1" tone="muted">
                  AI-generated
                </StatusBadge>
              ) : null}
            </div>
            <Textarea
              className={cn(
                isCompact
                  ? compactBulletTextareaClassName
                  : bulletTextareaClassName,
              )}
              aria-label={`${isEntryBullet ? "Entry" : "Section"} bullet ${bulletNumber}${bullet.included ? "" : " (hidden)"}`}
              data-resume-editor-target={targetId}
              id={bulletId}
              disabled={textDisabled}
              rows={isCompact ? 1 : 2}
              value={bullet.text}
              onChange={(event) =>
                onChange(
                  entryId
                    ? updateEntryBulletText(
                        section,
                        entryId,
                        bullet.id,
                        event.currentTarget.value,
                      )
                    : updateSectionBulletText(
                        section,
                        bullet.id,
                        event.currentTarget.value,
                      ),
                )
              }
            />
          </div>
        );
      })}
    </>
  );
}
