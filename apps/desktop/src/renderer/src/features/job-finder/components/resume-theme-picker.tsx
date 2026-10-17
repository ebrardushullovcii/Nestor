import { useId, useMemo } from "react";
import type {
  ResumeTemplateDefinition,
  ResumeTemplateId,
} from "@nestor/contracts";
import { ResumeThemePickerCompact } from "./resume-theme-picker-compact";
import { ResumeThemePickerFull } from "./resume-theme-picker-full";
import {
  buildResumeThemePickerRecommendations,
  sortResumeThemeOptions,
  type ResumeThemePickerRecommendationContext,
} from "./resume-theme-picker-helpers";

export type { ResumeThemePickerRecommendationContext } from "./resume-theme-picker-helpers";
export { buildResumeThemePickerRecommendations } from "./resume-theme-picker-helpers";

interface ResumeThemePickerProps {
  disabled?: boolean;
  labelledBy?: string;
  mode?: "full" | "compact";
  recommendationContext?: ResumeThemePickerRecommendationContext | null;
  selectedThemeId: ResumeTemplateId;
  themes: readonly ResumeTemplateDefinition[];
  onChange: (themeId: ResumeTemplateId) => void;
}

export function ResumeThemePicker({
  disabled = false,
  labelledBy,
  mode = "full",
  recommendationContext = null,
  selectedThemeId,
  themes,
  onChange,
}: ResumeThemePickerProps) {
  const fallbackLabelId = useId();
  const resolvedLabelId = labelledBy ?? fallbackLabelId;
  const sortedThemes = useMemo(() => sortResumeThemeOptions(themes), [themes]);
  const recommendations = useMemo(
    () =>
      buildResumeThemePickerRecommendations({
        recommendationContext,
        themes: sortedThemes,
      }),
    [recommendationContext, sortedThemes],
  );
  const recommendationReasons = useMemo(
    () =>
      new Map(
        recommendations.map((recommendation) => [
          recommendation.templateId,
          recommendation.reason,
        ]),
      ),
    [recommendations],
  );
  const recommendedThemeIds = useMemo(
    () =>
      new Set(
        recommendations.map((recommendation) => recommendation.templateId),
      ),
    [recommendations],
  );
  const selectedTemplate =
    sortedThemes.find((theme) => theme.id === selectedThemeId) ??
    sortedThemes[0] ??
    null;
  const effectiveSelectedThemeId = selectedTemplate?.id ?? selectedThemeId;
  const heroTemplate = selectedTemplate;
  const heroReason = heroTemplate
    ? (recommendationReasons.get(heroTemplate.id) ?? null)
    : null;
  if (!heroTemplate) {
    return (
      <>
        {labelledBy ? null : (
          <span className="sr-only" id={fallbackLabelId}>
            Resume template
          </span>
        )}
        <div
          aria-labelledby={resolvedLabelId}
          className="rounded-(--radius-field) border border-dashed border-(--surface-panel-border) bg-background/55 px-4 py-5 text-sm leading-6 text-foreground-soft"
          role="group"
        >
          No templates are available right now.
        </div>
      </>
    );
  }

  return (
    <>
      {labelledBy ? null : (
        <span className="sr-only" id={fallbackLabelId}>
          Resume template
        </span>
      )}
      {mode === "compact" ? (
        <ResumeThemePickerCompact
          disabled={disabled}
          labelledBy={resolvedLabelId}
          onChange={onChange}
          recommendationReasons={recommendationReasons}
          selectedThemeId={effectiveSelectedThemeId}
          themes={sortedThemes}
        />
      ) : (
        <ResumeThemePickerFull
          disabled={disabled}
          heroReason={heroReason}
          heroTemplate={heroTemplate}
          labelledBy={resolvedLabelId}
          onChange={onChange}
          recommendedThemeIds={recommendedThemeIds}
          selectedThemeId={effectiveSelectedThemeId}
          themes={sortedThemes}
        />
      )}
    </>
  );
}
