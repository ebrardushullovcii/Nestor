import type {
  ResumeTemplateDefinition,
  ResumeTemplateId,
} from "@nestor/contracts";
import { getResumeTemplateDeliveryLane } from "@nestor/contracts";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import {
  getLaneBadgeVariant,
  getLaneLabel,
  getTemplateOptionLabel,
} from "./resume-theme-picker-helpers";

export function ResumeThemePickerCompact(props: {
  disabled: boolean;
  labelledBy: string;
  onChange: (themeId: ResumeTemplateId) => void;
  recommendationReasons: ReadonlyMap<ResumeTemplateId, string>;
  selectedThemeId: ResumeTemplateId;
  themes: readonly ResumeTemplateDefinition[];
}) {
  const {
    disabled,
    labelledBy,
    onChange,
    recommendationReasons,
    selectedThemeId,
    themes,
  } = props;

  return (
    <div
      className="grid min-w-0 gap-3"
      aria-labelledby={labelledBy}
      role="group"
    >
      <section className="surface-panel-shell relative min-w-0 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border)">
        <div className="grid min-w-0 content-start gap-3 p-3">
          <div className="grid min-w-0 gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/55 px-3 py-2.5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <p className="label-mono-xs">Choose a template</p>
              <Badge variant="section">{themes.length} options</Badge>
            </div>

            <div className="grid gap-1.5">
              {themes.map((theme) => (
                <CompactVariantCard
                  disabled={disabled}
                  key={theme.id}
                  onChange={onChange}
                  recommendationReason={recommendationReasons.get(theme.id)}
                  selected={theme.id === selectedThemeId}
                  theme={theme}
                />
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function CompactVariantCard(props: {
  disabled: boolean;
  onChange: (themeId: ResumeTemplateId) => void;
  recommendationReason: string | undefined;
  selected: boolean;
  theme: ResumeTemplateDefinition;
}) {
  const { disabled, onChange, recommendationReason, selected, theme } = props;
  const deliveryLane = getResumeTemplateDeliveryLane(theme);
  const compactReason =
    recommendationReason ?? theme.fitSummary ?? theme.description;

  return (
    <div
      data-resume-template-option={theme.id}
      className={cn(
        "grid gap-2 rounded-(--radius-field) border px-3 py-2.5 transition-[border-color,background-color,box-shadow]",
        selected
          ? "border-primary/38 bg-primary/8 shadow-[inset_0_1px_0_var(--focus-inset-highlight)]"
          : "border-(--surface-panel-border) bg-background/45",
      )}
    >
      <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {getTemplateOptionLabel(theme)}
            </span>
            {selected ? <Badge variant="default">Selected</Badge> : null}
            <Badge variant={getLaneBadgeVariant(deliveryLane)}>
              {getLaneLabel(deliveryLane)}
            </Badge>
          </div>
          <p className="text-(length:--text-small) leading-5 text-foreground-soft">
            {compactReason}
          </p>
        </div>
        <Button
          aria-label={`${selected ? "Selected template" : "Use template"}: ${getTemplateOptionLabel(theme)}`}
          aria-pressed={selected}
          className="xl:min-w-44"
          data-resume-template-select={theme.id}
          disabled={disabled}
          onClick={() => onChange(theme.id)}
          size="compact"
          type="button"
          variant="secondary"
        >
          {selected ? "Selected template" : "Use this template"}
        </Button>
      </div>
    </div>
  );
}
