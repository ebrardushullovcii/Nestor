import { useEffect, useMemo, useRef } from "react";
import type {
  ResumeTemplateDefinition,
  ResumeTemplateId,
} from "@nestor/contracts";
import {
  getResumeTemplateAtsConfidence,
  getResumeTemplateDeliveryLane,
  getResumeTemplateVisualTags,
} from "@nestor/contracts";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { renderResumeTemplateCatalogPreviewHtml } from "../../../../../shared/job-finder-resume-renderer";
import {
  getAtsConfidenceLabel,
  getLaneLabel,
  getTemplateOptionLabel,
} from "./resume-theme-picker-helpers";

export function ResumeThemePickerFull(props: {
  disabled: boolean;
  heroReason: string | null;
  heroTemplate: ResumeTemplateDefinition;
  labelledBy: string;
  onChange: (themeId: ResumeTemplateId) => void;
  recommendedThemeIds: ReadonlySet<ResumeTemplateId>;
  selectedThemeId: ResumeTemplateId;
  themes: readonly ResumeTemplateDefinition[];
}) {
  const {
    disabled,
    heroReason,
    heroTemplate,
    labelledBy,
    onChange,
    recommendedThemeIds,
    selectedThemeId,
    themes,
  } = props;
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const heroVisualTags = getResumeTemplateVisualTags(heroTemplate).slice(0, 2);
  // The catalog preview runs the full 2,300-line template engine. Building it
  // inline in JSX regenerated the whole document — and forced the iframe to
  // re-parse it — on every unrelated render of this screen, so saving the
  // appearance theme re-rendered a resume that has nothing to do with it.
  const heroPreviewHtml = useMemo(
    () =>
      renderResumeTemplateCatalogPreviewHtml(heroTemplate.id, {
        layout: "panel",
      }),
    [heroTemplate.id],
  );

  useEffect(() => {
    const iframe = previewFrameRef.current;

    if (!iframe) {
      return;
    }

    const measureHeight = () => {
      const frameDocument = iframe.contentDocument;
      if (!frameDocument) {
        return;
      }

      const page = frameDocument.querySelector<HTMLElement>(".page");
      const body = frameDocument.body;
      const nextHeight = Math.ceil(
        (page?.getBoundingClientRect().height ?? body?.scrollHeight ?? 0) + 8,
      );

      if (nextHeight > 0) {
        iframe.style.height = `${nextHeight}px`;
      }
    };

    const handleLoad = () => {
      measureHeight();
    };

    handleLoad();
    iframe.addEventListener("load", handleLoad);
    window.addEventListener("resize", handleLoad);

    return () => {
      iframe.removeEventListener("load", handleLoad);
      window.removeEventListener("resize", handleLoad);
    };
  }, [heroTemplate.id]);

  return (
    <div
      className="grid min-w-0 gap-4"
      aria-labelledby={labelledBy}
      role="group"
    >
      <section className="surface-panel-shell relative min-w-0 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border)">
        <div className="grid min-w-0 gap-3 p-3.5 xl:gap-3.5">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2.5">
            <div className="grid min-w-0 gap-1.5">
              <p className="label-mono-xs">Current selection</p>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display font-semibold tracking-[-0.04em] text-(--text-headline)">
                  {heroTemplate.label}
                </h3>
                {heroVisualTags.map((tag) => (
                  <Badge key={tag} variant="section">
                    {tag}
                  </Badge>
                ))}
              </div>
              <p className="max-w-[64ch] text-[0.82rem] leading-4.5 text-foreground-soft">
                {heroTemplate.description}
              </p>
              {heroReason ? (
                <p className="text-[0.72rem] leading-4.5 text-primary/85">
                  {heroReason}
                </p>
              ) : null}
            </div>

            {/* "SAMPLE RENDERER PREVIEW" was one more uppercase micro-badge in
                a screen already carrying eight; it describes the picture below
                it, so it reads as the sentence it is. */}
            <p className="text-(length:--text-tiny) leading-5 text-foreground-soft">
              The preview below uses sample content, not your resume.
            </p>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Badge variant="section">
                {getLaneLabel(getResumeTemplateDeliveryLane(heroTemplate))}
              </Badge>
              <Badge variant="section">
                {getAtsConfidenceLabel(
                  getResumeTemplateAtsConfidence(heroTemplate),
                )}
              </Badge>
            </div>
          </div>

          <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.72fr)_minmax(18rem,19.5rem)] xl:items-start">
            <div className="min-w-0 max-w-full overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) bg-(--resume-preview-frame) p-1.5 shadow-[var(--resume-preview-shell-shadow)] xl:p-2">
              {/* Same script-free contract as the studio preview: the
                  catalog document carries `script-src 'none'` itself, so no
                  sandbox attribute is needed and Chromium logs no blocked
                  script execution for this frame. */}
              <iframe
                aria-hidden="true"
                className="block min-w-0 max-w-full w-full rounded-2xl border-0 bg-transparent"
                ref={previewFrameRef}
                srcDoc={heroPreviewHtml}
                style={{ height: "34rem" }}
                title={`${heroTemplate.label} preview`}
              />
            </div>

            <div className="sr-only">
              This preview uses sample resume content rendered through the
              shared production template engine.
            </div>

            <div className="grid min-w-0 gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/55 px-3 py-3">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="label-mono-xs">Choose a template</p>
                <Badge variant="section">{themes.length} options</Badge>
              </div>

              <div className="grid gap-1.5">
                {themes.map((theme) => (
                  <TemplateOptionCard
                    disabled={disabled}
                    key={theme.id}
                    onChange={onChange}
                    recommended={recommendedThemeIds.has(theme.id)}
                    selected={theme.id === selectedThemeId}
                    theme={theme}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function TemplateOptionCard(props: {
  disabled: boolean;
  onChange: (themeId: ResumeTemplateId) => void;
  recommended: boolean;
  selected: boolean;
  theme: ResumeTemplateDefinition;
}) {
  const { disabled, onChange, recommended, selected, theme } = props;
  const visualTags = getResumeTemplateVisualTags(theme).slice(0, 2);
  const templateName = getTemplateOptionLabel(theme);
  const actionLabel = selected
    ? `Selected template: ${templateName}`
    : `Use ${templateName}`;

  return (
    <div
      data-resume-template-option={theme.id}
      className={cn(
        "min-w-0 grid gap-1 rounded-(--radius-field) border px-2.5 py-2 transition-[border-color,background-color,box-shadow]",
        selected
          ? "border-primary/38 bg-primary/8 shadow-[inset_0_1px_0_var(--focus-inset-highlight)]"
          : "border-(--surface-panel-border) bg-background/55",
      )}
    >
      <div className="grid gap-2">
        <div className="grid min-w-0 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-[0.8rem] font-semibold leading-4 text-foreground">
              {templateName}
            </span>
            {selected ? <Badge variant="default">Selected</Badge> : null}
            {recommended ? <Badge variant="section">Recommended</Badge> : null}
          </div>
          {visualTags.length > 0 ? (
            <p className="text-[0.68rem] leading-4 text-foreground-soft">
              {visualTags.join(" · ")}
            </p>
          ) : null}
        </div>

        <Button
          aria-label={actionLabel}
          aria-pressed={selected}
          className="w-full"
          data-resume-template-select={theme.id}
          disabled={disabled}
          onClick={() => {
            if (disabled) {
              return;
            }

            onChange(theme.id);
          }}
          size="compact"
          type="button"
          variant={selected ? "primary" : "secondary"}
        >
          {selected ? "Selected template" : "Use this template"}
        </Button>
      </div>
    </div>
  );
}
