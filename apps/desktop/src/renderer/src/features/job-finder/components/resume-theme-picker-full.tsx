import { useEffect, useMemo, useRef, useState } from "react";
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
import { Check } from "lucide-react";
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
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const heroVisualTags = getResumeTemplateVisualTags(heroTemplate).slice(0, 2);
  // The preview sits far down Settings; its sample resume is laid out only
  // once its box comes near the screen. The box keeps a page's ratio either
  // way, so nothing moves when it fills in.
  const [isPreviewNear, setIsPreviewNear] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  // The catalog preview runs the full 2,300-line template engine. Building it
  // inline in JSX regenerated the whole document — and forced the iframe to
  // re-parse it — on every unrelated render of this screen, so saving the
  // appearance theme re-rendered a resume that has nothing to do with it.
  const heroPreviewHtml = useMemo(
    () =>
      isPreviewNear
        ? renderResumeTemplateCatalogPreviewHtml(heroTemplate.id, {
            layout: "panel",
          })
        : "",
    [heroTemplate.id, isPreviewNear],
  );

  useEffect(() => {
    const box = previewBoxRef.current;
    if (isPreviewNear || !box) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsPreviewNear(true);
        }
      },
      {
        // The page's own scroller, so the margin starts the preview a little
        // before it scrolls into view (a viewport margin stops at its clip).
        root: box.closest<HTMLElement>(
          "[data-locked-screen-scroll-area], main",
        ),
        rootMargin: "600px 0px",
      },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [isPreviewNear]);

  return (
    <div
      className="grid min-w-0 gap-4"
      aria-labelledby={labelledBy}
      role="group"
    >
      {/* Two levels only: the section's card, then one card per template.
          The chosen template gets the accent ring and a check; the large
          preview beside the grid shows it at reading size. */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <div className="grid min-w-0 content-start gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
            <p className="text-(length:--text-small) font-medium text-foreground">
              Choose a template
            </p>
            <p className="text-xs text-foreground-muted">
              {themes.length} templates
            </p>
          </div>
          <div
            className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3"
            data-resume-template-grid
          >
            {themes.map((theme) => (
              <TemplateOptionCard
                disabled={disabled}
                // The name once: the template's own name, with its variant
                // only where two templates share that name.
                displayName={
                  themes.filter((other) => other.label === theme.label).length >
                  1
                    ? getTemplateOptionLabel(theme)
                    : theme.label
                }
                key={theme.id}
                onChange={onChange}
                recommended={recommendedThemeIds.has(theme.id)}
                selected={theme.id === selectedThemeId}
                showThumbnail={isPreviewNear}
                theme={theme}
              />
            ))}
          </div>
        </div>

        <section
          aria-label="Current selection"
          // Beside the gallery, exactly as tall as it: the preview window
          // takes what the gallery leaves (never less than 16rem) and adds
          // no height of its own, so both columns end on one line.
          className="grid min-w-0 content-start gap-2.5 xl:flex xl:flex-col"
        >
          <div className="grid min-w-0 gap-1">
            <p className="text-xs text-foreground-muted">Current selection</p>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display font-semibold text-(--text-headline)">
                {heroTemplate.label}
              </h3>
              {heroVisualTags.map((tag) => (
                <Badge key={tag} variant="section">
                  {tag}
                </Badge>
              ))}
            </div>
            <p className="max-w-[64ch] text-(length:--text-small) leading-5 text-foreground-soft">
              {heroTemplate.description}
            </p>
            <p className="text-xs leading-5 text-foreground-muted">
              {getLaneLabel(getResumeTemplateDeliveryLane(heroTemplate))} ·{" "}
              {getAtsConfidenceLabel(
                getResumeTemplateAtsConfidence(heroTemplate),
              )}
            </p>
            {heroReason ? (
              <p className="text-xs leading-5 text-primary">{heroReason}</p>
            ) : null}
            <p className="text-(length:--text-tiny) leading-5 text-foreground-soft">
              The preview below uses sample content, not your resume.
            </p>
          </div>
          {/* A bounded window on the top of the page at reading size, so
              the preview never runs a long empty column beside the gallery,
              nor a screen-long section below it when narrow. It does not
              scroll (no wheel trap inside the Settings page); the page fades
              out at the window's foot. Beside the gallery its flex basis is
              0 px, not 0%: a percentage basis in a column of indefinite
              height counts the whole page, which made the column outgrow
              the gallery by ~200 px. */}
          <div
            className="relative max-h-[26rem] min-w-0 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) bg-(--resume-preview-frame) p-3 xl:max-h-none xl:min-h-[16rem] xl:flex-[1_1_0px]"
            data-resume-preview-window
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-linear-to-t from-(--resume-preview-frame) to-transparent"
            />
            {/* Same script-free contract as the studio preview: the catalog
                document carries `script-src 'none'` itself. One letter page;
                the box keeps a page's ratio, so nothing moves when it fills. */}
            <div
              className="mx-auto aspect-[8.5/11] w-full min-w-0 bg-white"
              data-resume-preview-box
              ref={previewBoxRef}
              style={{ boxShadow: "var(--resume-preview-shell-shadow)" }}
            >
              {isPreviewNear ? (
                <iframe
                  aria-hidden="true"
                  className="pointer-events-none block size-full min-w-0 border-0 bg-transparent"
                  srcDoc={heroPreviewHtml}
                  title={`${heroTemplate.label} preview`}
                />
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** The thumbnail document: flush paper, no rounded tinted shell. */
function thumbnailHtml(templateId: ResumeTemplateId): string {
  const html = renderResumeTemplateCatalogPreviewHtml(templateId, {
    layout: "thumbnail",
  });
  const style =
    "<style>body.catalog-body.catalog-body-thumbnail,.catalog-shell-thumbnail{background:#fff!important;border-radius:0!important}</style>";
  return html.includes("</head>")
    ? html.replace("</head>", `${style}</head>`)
    : `${style}${html}`;
}

function TemplateOptionCard(props: {
  disabled: boolean;
  displayName: string;
  onChange: (themeId: ResumeTemplateId) => void;
  recommended: boolean;
  selected: boolean;
  showThumbnail: boolean;
  theme: ResumeTemplateDefinition;
}) {
  const { disabled, onChange, recommended, selected, theme } = props;
  const visualTags = getResumeTemplateVisualTags(theme).slice(0, 2);
  const templateName = getTemplateOptionLabel(theme);
  const thumbnail = useMemo(
    () => (props.showThumbnail ? thumbnailHtml(theme.id) : ""),
    [props.showThumbnail, theme.id],
  );

  return (
    <button
      aria-label={
        selected ? `Selected template: ${templateName}` : `Use ${templateName}`
      }
      aria-pressed={selected}
      className={cn(
        "group relative grid min-w-0 content-start gap-2 rounded-(--radius-panel) border bg-(--surface-panel) p-2.5 text-left transition-[border-color,box-shadow,background-color] duration-(--duration-fast) focus-ring disabled:cursor-not-allowed disabled:opacity-60",
        selected
          ? "border-primary ring-1 ring-primary"
          : "border-(--surface-panel-border) hover:border-primary/40",
      )}
      data-resume-template-option={theme.id}
      data-resume-template-select={theme.id}
      disabled={disabled}
      onClick={() => {
        if (!disabled && !selected) onChange(theme.id);
      }}
      type="button"
    >
      {/* The top of the page: header, rules and type are what tell the
          templates apart; a whole page per card made the gallery run for
          several screens of Settings. */}
      <span
        aria-hidden="true"
        className="flex h-32 items-start justify-center overflow-hidden rounded-(--radius-small) bg-(--resume-preview-frame) pt-2"
      >
        {/* The whole width of the page, scaled to the card (a 188 px page
            in a 140 px card was cut on both sides: "hn Doe"). */}
        <span
          className="block h-[243px] w-[188px] shrink-0 origin-top scale-[0.72] overflow-hidden bg-white"
          style={{ boxShadow: "var(--resume-preview-shell-shadow)" }}
        >
          {thumbnail ? (
            <iframe
              className="pointer-events-none block h-[243px] w-[188px] border-0"
              loading="lazy"
              srcDoc={thumbnail}
              tabIndex={-1}
              title=""
            />
          ) : null}
        </span>
      </span>
      {selected ? (
        <span
          aria-hidden="true"
          className="absolute right-3.5 top-3.5 inline-flex size-6 items-center justify-center rounded-full bg-primary-fill text-primary-fill-foreground shadow-sm"
        >
          <Check className="size-4" />
        </span>
      ) : null}
      <span className="grid min-w-0 gap-0.5 px-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-(length:--text-small) font-semibold leading-5 text-foreground">
            {props.displayName}
          </span>
          {recommended ? <Badge variant="section">Recommended</Badge> : null}
        </span>
        {visualTags.length > 0 ? (
          // Wraps to a second line rather than stop mid-word ("Clas…").
          <span className="text-xs leading-4 text-foreground-soft">
            {visualTags.join(" · ")}
          </span>
        ) : null}
      </span>
    </button>
  );
}
