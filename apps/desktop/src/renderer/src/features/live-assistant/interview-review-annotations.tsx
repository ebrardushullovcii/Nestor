import { useEffect, useState } from "react";
import type {
  InterviewLiveSession,
  InterviewTranscriptAnnotationInput,
  InterviewWorkspaceView,
} from "@nordri/contracts";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { formatInterviewTranscriptSource } from "./interview-transcript-source-label";

export function TranscriptAnnotationPanel(props: {
  session: InterviewLiveSession;
  onWorkspaceChange: (workspace: InterviewWorkspaceView) => void;
}) {
  const firstSegmentId = props.session.transcriptSegments[0]?.id ?? null;
  const [kind, setKind] =
    useState<InterviewTranscriptAnnotationInput["kind"]>("correction");
  const [segmentId, setSegmentId] = useState<string | null>(firstSegmentId);
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setSegmentId(firstSegmentId);
    setBody("");
  }, [firstSegmentId, props.session.id]);

  async function saveAnnotation() {
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      return;
    }

    setPending(true);
    try {
      const workspace =
        await window.nordri.liveAssistant.addTranscriptAnnotation({
          sessionId: props.session.id,
          transcriptSegmentId: segmentId,
          kind,
          body: trimmedBody,
        });
      setBody("");
      props.onWorkspaceChange(workspace);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3">
      <div className="flex items-center gap-2">
        <MessageSquarePlus className="size-4 text-(--info-text)" />
        <h3 className="text-[0.78rem] uppercase tracking-(--tracking-badge) text-muted-foreground">
          Transcript annotations
        </h3>
      </div>
      <div className="grid gap-2 sm:grid-cols-[0.55fr_1fr]">
        <select
          className="h-9 rounded-sm border border-border-subtle bg-(--field) px-2 text-[0.78rem]"
          onChange={(event) => {
            setKind(
              event.target.value as InterviewTranscriptAnnotationInput["kind"],
            );
          }}
          value={kind}
        >
          <option value="correction">Correction</option>
          <option value="note">Note</option>
        </select>
        <select
          className="h-9 rounded-sm border border-border-subtle bg-(--field) px-2 text-[0.78rem]"
          onChange={(event) => {
            setSegmentId(
              event.target.value === "session" ? null : event.target.value,
            );
          }}
          value={segmentId ?? "session"}
        >
          <option value="session">Session-level note</option>
          {props.session.transcriptSegments.map((segment, index) => (
            <option key={segment.id} value={segment.id}>
              {index + 1}. {formatInterviewTranscriptSource(segment.source)}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="min-h-20 resize-y rounded-sm border border-border-subtle bg-(--field) p-2 text-[0.8rem] leading-5 outline-none focus:border-(--info-border)"
        onChange={(event) => {
          setBody(event.target.value);
        }}
        placeholder="Add a correction or review note without changing the original transcript."
        value={body}
      />
      <Button
        disabled={!body.trim()}
        onClick={() => {
          void saveAnnotation();
        }}
        pending={pending}
        size="compact"
        variant="secondary"
      >
        <MessageSquarePlus className="size-4" />
        Save annotation
      </Button>
      {props.session.transcriptAnnotations.length > 0 ? (
        <div className="grid max-h-28 gap-2 overflow-y-auto border-t border-border-subtle pt-2">
          {props.session.transcriptAnnotations.map((annotation) => (
            <p
              className="text-[0.76rem] leading-5 text-muted-foreground"
              key={annotation.id}
            >
              <span className="text-(--info-text)">{annotation.kind}</span>{" "}
              {annotation.body}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
