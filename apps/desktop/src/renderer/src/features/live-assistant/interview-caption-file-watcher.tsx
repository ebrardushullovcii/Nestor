import { useEffect, useRef, useState } from "react";
import { FileText, FileX2 } from "lucide-react";
import type { InterviewWorkspaceView } from "@nordri/contracts";
import { Button } from "@renderer/components/ui/button";

function normalizeCaptionFileText(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      if (line === "WEBVTT") return false;
      if (/^\d+$/.test(line)) return false;
      if (
        /^\d\d:\d\d:\d\d[,.]\d{3}\s+-->\s+\d\d:\d\d:\d\d[,.]\d{3}/.test(line)
      ) {
        return false;
      }
      if (/^NOTE\b/.test(line)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export function InterviewCaptionFileWatcher(props: {
  sessionId: string;
  language: string;
  listening: boolean;
  onWorkspaceChange: (workspace: InterviewWorkspaceView) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState("Caption file watcher idle");
  const lastNormalizedTextRef = useRef("");
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

  async function selectCaptionFile() {
    const result = await window.nordri.liveAssistant.selectCaptionFile();
    if (!result.selected || !result.filePath) {
      setStatusLabel("Caption file selection canceled");
      return;
    }

    const normalizedText = normalizeCaptionFileText(result.text);
    lastNormalizedTextRef.current = normalizedText;
    setFilePath(result.filePath);
    setDisplayName(result.displayName ?? "Caption file");
    setEnabled(true);
    setStatusLabel(
      result.truncated
        ? "Watching latest caption file text"
        : "Watching caption file for new transcript text",
    );
  }

  useEffect(() => {
    if (!enabled || !filePath) {
      return;
    }

    let disposed = false;
    const intervalId = window.setInterval(() => {
      if (disposed || !listeningRef.current) {
        return;
      }

      void window.nordri.liveAssistant
        .readCaptionFile({ filePath })
        .then((result) => {
          const nextText = normalizeCaptionFileText(result.text);
          const previousText = lastNormalizedTextRef.current;

          if (
            nextText.length === 0 ||
            nextText === previousText ||
            !nextText.startsWith(previousText)
          ) {
            lastNormalizedTextRef.current = nextText;
            return;
          }

          const appendedText = nextText.slice(previousText.length).trim();
          lastNormalizedTextRef.current = nextText;
          if (appendedText.length === 0) {
            return;
          }

          setStatusLabel("Caption file text added to transcript");
          return window.nordri.liveAssistant
            .addTranscriptSegment({
              sessionId: sessionIdRef.current,
              source: "meeting_native_transcript",
              state: "final",
              text: appendedText,
              language: languageRef.current,
              engineKind: "platform_local",
            })
            .then(props.onWorkspaceChange);
        })
        .catch((error: unknown) => {
          setStatusLabel(
            error instanceof Error
              ? error.message
              : "Caption file watcher failed",
          );
        });
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, filePath, props.onWorkspaceChange]);

  return (
    <div className="grid gap-2 rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <p className="text-[0.82rem]">Caption file</p>
          <p className="text-[0.72rem] text-muted-foreground">
            {displayName ? `${displayName}: ${statusLabel}` : statusLabel}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-flow-col xl:grid-flow-row 2xl:grid-flow-col">
          <Button
            className="justify-self-stretch"
            disabled={!props.listening}
            onClick={() => {
              void selectCaptionFile();
            }}
            size="compact"
            variant="secondary"
          >
            <FileText className="size-4" />
            Watch file
          </Button>
          {enabled ? (
            <Button
              className="justify-self-stretch"
              onClick={() => {
                setEnabled(false);
                setStatusLabel("Caption file watcher stopped");
              }}
              size="compact"
              variant="outline"
            >
              <FileX2 className="size-4" />
              Stop file
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
