import type {
  ResumeCommandOutputs,
  ResumeDraft,
  ResumeDraftSection,
} from "@nestor/contracts";
import { useState } from "react";

import { ResumeIdentityEditor } from "./editor/resume-identity-editor";
import { ResumeSectionEditor } from "./editor/resume-section-editor";

import { cn } from "@renderer/lib/cn";

import { applyEditorPatch } from "./apply-editor-patch";

/**
 * The resume's fields. Every edit shows in the preview at once and saves
 * itself; Hide and Lock work per line, role and section.
 */
export function ResumeEditor(props: {
  draft: ResumeDraft;
  disabled: boolean;
  onChange: (draft: ResumeDraft) => void;
  className?: string;
  templates: ResumeCommandOutputs["get_resume"]["templates"];
}) {
  const { draft } = props;
  const [openSectionId, setOpenSectionId] = useState<string | null>(
    draft.sections[0]?.id ?? null,
  );
  const [selected, setSelected] = useState<{
    sectionId: string | null;
    entryId: string | null;
  }>({ sectionId: null, entryId: null });

  const changeSection = (next: ResumeDraftSection) =>
    props.onChange({
      ...draft,
      sections: draft.sections.map((section) =>
        section.id === next.id ? next : section,
      ),
    });

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1",
        props.className,
      )}
    >
      {props.templates.length > 1 ? (
        <label className="flex items-center gap-2 text-sm text-foreground-soft">
          Template
          <select
            className="h-8 rounded-(--radius-field) border border-(--control-border) bg-card px-2 text-sm text-foreground"
            disabled={props.disabled}
            onChange={(event) => {
              const template = props.templates.find(
                (entry) => entry.id === event.target.value,
              );
              if (template)
                props.onChange({ ...draft, templateId: template.id });
            }}
            value={draft.templateId}
          >
            {props.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ResumeIdentityEditor
        disabled={props.disabled}
        identity={draft.identity}
        onChange={(identity) => props.onChange({ ...draft, identity })}
        selectedTargetId={null}
      />
      {draft.sections.map((section) => (
        <ResumeSectionEditor
          disabled={props.disabled}
          isExpanded={openSectionId === section.id}
          isSelected={selected.sectionId === section.id}
          key={section.id}
          onChange={changeSection}
          onPatch={(patch) => props.onChange(applyEditorPatch(draft, patch))}
          onSelectEntry={(sectionId, entryId) =>
            setSelected({ sectionId, entryId })
          }
          onSelectSection={(sectionId) =>
            setSelected({ sectionId, entryId: null })
          }
          onToggleExpanded={(sectionId) =>
            setOpenSectionId((current) =>
              current === sectionId ? null : sectionId,
            )
          }
          section={section}
          selectedEntryId={
            selected.sectionId === section.id ? selected.entryId : null
          }
          selectedTargetId={null}
          showGeneratedMarkers={false}
          workHistoryReviewSuggestions={[]}
        />
      ))}
    </div>
  );
}
