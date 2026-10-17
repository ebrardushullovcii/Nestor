import { useEffect, useRef, useState } from "react";
import { Captions, CaptionsOff } from "lucide-react";
import type { InterviewWorkspaceView } from "@nordri/contracts";
import { Button } from "@renderer/components/ui/button";

export function InterviewNativeCaptionWatcher(props: {
  sessionId: string;
  language: string;
  listening: boolean;
  onWorkspaceChange: (workspace: InterviewWorkspaceView) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [statusLabel, setStatusLabel] = useState("Native caption watcher idle");
  const lastTextRef = useRef("");
  const sessionIdRef = useRef(props.sessionId);
  const languageRef = useRef(props.language);
  const listeningRef = useRef(props.listening);

  useEffect(() => {
    sessionIdRef.current = props.sessionId;
  }, [props.sessionId]);

  useEffect(() => {
    languageRef.current = props.language;
  }, [props.language]);

  useEffect(() => {
    listeningRef.current = props.listening;
  }, [props.listening]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;
    const intervalId = window.setInterval(() => {
      if (disposed || !listeningRef.current) {
        return;
      }

      void window.nordri.liveAssistant
        .readClipboardText()
        .then((result) => {
          const text = result.text.trim();
          if (text.length === 0 || text === lastTextRef.current) {
            return;
          }

          lastTextRef.current = text;
          setStatusLabel("Native caption copied into transcript");
          return window.nordri.liveAssistant
            .addTranscriptSegment({
              sessionId: sessionIdRef.current,
              source: "meeting_native_transcript",
              state: "final",
              text,
              language: languageRef.current,
              engineKind: "platform_local",
            })
            .then(props.onWorkspaceChange);
        })
        .catch((error: unknown) => {
          setStatusLabel(
            error instanceof Error
              ? error.message
              : "Native caption watcher failed",
          );
        });
    }, 2000);

    setStatusLabel("Watching clipboard for copied native captions");

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, props.onWorkspaceChange]);

  return (
    <div className="grid gap-2 rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <p className="text-[0.82rem]">Native captions</p>
          <p className="text-[0.72rem] text-muted-foreground">{statusLabel}</p>
        </div>
        <Button
          className="justify-self-stretch"
          disabled={!props.listening}
          onClick={() => {
            setEnabled((current) => !current);
          }}
          size="compact"
          variant={enabled ? "outline" : "secondary"}
        >
          {enabled ? (
            <CaptionsOff className="size-4" />
          ) : (
            <Captions className="size-4" />
          )}
          {enabled ? "Stop captions" : "Watch captions"}
        </Button>
      </div>
    </div>
  );
}
