import { useEffect, useState } from "react";
import type {
  ResumeTemplateDefinition,
  ResumeTemplateId,
} from "@nestor/contracts";
import {
  getResumeTemplateAtsConfidence,
  getResumeTemplateDeliveryLane,
} from "@nestor/contracts";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { ResumeThemePicker } from "../../components/resume-theme-picker";
import type { ResumeThemePickerRecommendationContext } from "../../components/resume-theme-picker";
import {
  getAtsConfidenceLabel,
  getLaneLabel,
  getTemplateOptionLabel,
} from "../../components/resume-theme-picker-helpers";

interface ResumeWorkspaceTemplatePanelProps {
  disabled: boolean;
  recommendationContext: ResumeThemePickerRecommendationContext | null;
  selectedTemplateApprovalEligible: boolean;
  selectedThemeId: ResumeTemplateId;
  themes: readonly ResumeTemplateDefinition[];
  onChange: (templateId: ResumeTemplateId) => void;
}

export function ResumeWorkspaceTemplatePanel(
  props: ResumeWorkspaceTemplatePanelProps,
) {
  const [chooserOpen, setChooserOpen] = useState(
    !props.selectedTemplateApprovalEligible,
  );

  useEffect(() => {
    if (!props.selectedTemplateApprovalEligible) {
      setChooserOpen(true);
    }
  }, [props.selectedTemplateApprovalEligible]);

  const selectedTheme =
    props.themes.find((theme) => theme.id === props.selectedThemeId) ?? null;
  const chooserId = "resume-template-chooser-options";

  return (
    <section className="surface-panel-shell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border)">
      {/* The header only earns its row while the chooser is open or the
          selection is blocked; the collapsed state is one self-describing
          line below. */}
      <div
        className={cn(
          "border-b border-(--surface-panel-border) px-3 py-2",
          selectedTheme &&
            !chooserOpen &&
            props.selectedTemplateApprovalEligible &&
            "hidden",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-display text-(length:--text-label) font-bold uppercase tracking-(--tracking-caps) text-primary">
            Template
          </p>
          {/* The selected row below already carries the lane and ATS badges,
              so repeating "Approval-compatible template" here was a fourth
              internal-state chip on one screen saying nothing new. Only the
              blocking case still needs a header, in plain words. */}
          {props.selectedTemplateApprovalEligible ? null : (
            <Badge variant="outline">Cannot be used for applications</Badge>
          )}
        </div>
      </div>

      <div className="grid gap-2 p-2">
        {selectedTheme && !chooserOpen ? (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1 py-0.5">
            <div className="grid min-w-0 gap-0.5">
              <span className="text-(length:--text-small) leading-4 text-foreground-soft">
                Template
              </span>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-semibold text-foreground">
                  {getTemplateOptionLabel(selectedTheme)}
                </span>
                <span className="text-(length:--text-small) leading-4 text-foreground-soft">
                  {getLaneLabel(getResumeTemplateDeliveryLane(selectedTheme))}
                  {" · "}
                  {getAtsConfidenceLabel(
                    getResumeTemplateAtsConfidence(selectedTheme),
                  )}
                </span>
              </div>
            </div>
            <Button
              aria-controls={chooserId}
              aria-expanded={false}
              data-resume-template-toggle
              disabled={props.disabled}
              onClick={() => setChooserOpen(true)}
              size="compact"
              type="button"
              variant="secondary"
            >
              Change template
            </Button>
          </div>
        ) : null}

        <div
          className={chooserOpen || !selectedTheme ? "min-w-0" : "hidden"}
          id={chooserId}
        >
          <div className="mb-2 flex justify-end xl:hidden">
            <span className="text-(length:--text-small) leading-4 text-foreground-soft">
              Template changes reset review state for the next export and
              approval.
            </span>
          </div>
          <ResumeThemePicker
            disabled={props.disabled}
            mode="compact"
            onChange={(templateId) => {
              props.onChange(templateId);
              setChooserOpen(false);
            }}
            recommendationContext={props.recommendationContext}
            selectedThemeId={props.selectedThemeId}
            themes={props.themes}
          />
          {selectedTheme ? (
            <div className="mt-2 flex justify-end">
              <Button
                aria-controls={chooserId}
                aria-expanded={true}
                data-resume-template-toggle
                disabled={props.disabled}
                onClick={() => setChooserOpen(false)}
                size="compact"
                type="button"
                variant="ghost"
              >
                Hide choices
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
