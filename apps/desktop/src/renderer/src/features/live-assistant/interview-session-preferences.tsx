import type {
  InterviewWorkspaceView,
  SaveInterviewSetupInput,
} from "@nestor/contracts";
import { Camera, Languages, SlidersHorizontal } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";

const transcriptionLanguages = [
  { value: "en-US", label: "English US" },
  { value: "en-GB", label: "English UK" },
  { value: "es-ES", label: "Spanish" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "tr-TR", label: "Turkish" },
] as const;

const cueSensitivityOptions = [
  { value: "conservative", label: "Conservative" },
  { value: "balanced", label: "Balanced" },
  { value: "manual_only", label: "Manual only" },
] as const;

export function InterviewSessionPreferences(props: {
  workspace: InterviewWorkspaceView;
  pending: boolean;
  onSave: (input: SaveInterviewSetupInput) => void;
}) {
  const setup = props.workspace.setup;

  return (
    <div className="grid gap-3 rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3">
      <div className="grid gap-2">
        <label
          className="flex items-center gap-2 text-[0.72rem] font-bold uppercase tracking-(--tracking-badge) text-muted-foreground"
          htmlFor="interview-transcription-language"
        >
          <Languages className="size-3.5" />
          Transcript language
        </label>
        <Select
          disabled={props.pending}
          onValueChange={(value) => {
            props.onSave({ transcriptionLanguage: value });
          }}
          value={setup.transcriptionLanguage}
        >
          <SelectTrigger
            aria-label="Transcript language"
            className="h-9 rounded-(--radius-small) border-border-subtle bg-(--field) text-[0.78rem]"
            id="interview-transcription-language"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            align="start"
            className="border-border-subtle bg-popover text-foreground shadow-[0_18px_60px_rgba(0,0,0,0.5)]"
            position="popper"
          >
            {transcriptionLanguages.map((option) => (
              <SelectItem
                className="text-[0.78rem] focus:bg-secondary focus:text-foreground"
                key={option.value}
                value={option.value}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <label
          className="flex items-center gap-2 text-[0.72rem] font-bold uppercase tracking-(--tracking-badge) text-muted-foreground"
          htmlFor="interview-cue-sensitivity"
        >
          <SlidersHorizontal className="size-3.5" />
          Cue sensitivity
        </label>
        <Select
          disabled={props.pending}
          onValueChange={(value) => {
            props.onSave({
              cueSensitivity:
                value as SaveInterviewSetupInput["cueSensitivity"],
            });
          }}
          value={setup.cueSensitivity}
        >
          <SelectTrigger
            aria-label="Cue sensitivity"
            className="h-9 rounded-(--radius-small) border-border-subtle bg-(--field) text-[0.78rem]"
            id="interview-cue-sensitivity"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            align="start"
            className="border-border-subtle bg-popover text-foreground shadow-[0_18px_60px_rgba(0,0,0,0.5)]"
            position="popper"
          >
            {cueSensitivityOptions.map((option) => (
              <SelectItem
                className="text-[0.78rem] focus:bg-secondary focus:text-foreground"
                key={option.value}
                value={option.value}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <label className="flex items-start gap-3 border-t border-border-subtle pt-3 text-[0.82rem]">
        <input
          checked={setup.autoCaptureOnCue}
          className="mt-1 size-4 accent-(--info-text)"
          disabled={props.pending || !setup.consent.screenshotCapture}
          onChange={(event) => {
            props.onSave({ autoCaptureOnCue: event.target.checked });
          }}
          type="checkbox"
        />
        <span className="grid gap-1">
          <span className="flex items-center gap-2">
            <Camera className="size-3.5 text-(--info-text)" />
            Auto screenshot on cue
          </span>
          <span className="text-[0.72rem] leading-5 text-muted-foreground">
            {setup.autoCaptureOnCue
              ? "Automatic cues include a temporary visual batch."
              : setup.consent.screenshotCapture
                ? "Manual screenshot controls decide when visual context is captured."
                : "Enable screenshot capture before using visual context."}
          </span>
        </span>
      </label>
    </div>
  );
}
