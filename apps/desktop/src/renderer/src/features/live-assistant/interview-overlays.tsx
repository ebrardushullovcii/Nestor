import type {
  InterviewOverlaySnapshot,
  InterviewTranscriptSegment,
} from "@nestor/contracts";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Check, Copy, Mic, Shield, Sparkles, X } from "lucide-react";
import { cn } from "@renderer/lib/cn";

export const interviewPopupNoDragStyle = {
  WebkitAppRegion: "no-drag",
} as CSSProperties;

export const interviewPopupThemeStyle = {
  "--foreground": "#f1f2f3",
  "--foreground-soft": "#b8bdc3",
  "--muted-foreground": "#a4abb3",
  "--border-subtle": "#30353a",
  "--surface-panel-border-warm": "#48515a",
  "--warning-border": "rgba(190, 155, 99, 0.4)",
  "--warning-surface": "rgba(190, 155, 99, 0.12)",
  "--warning-text": "#d6bb8f",
  /*
   * Overlays render outside the app theme on near-black scrims, so these
   * scoped values mirror the dark-theme semantic families instead of
   * referencing theme tokens: success is the sage family, info stays
   * steel-blue. Never collapse them back into one shared family.
   */
  "--success-border": "rgba(150, 196, 160, 0.42)",
  "--success-surface": "rgba(150, 196, 160, 0.12)",
  "--success-text": "#96c4a0",
  "--info-border": "rgba(125, 145, 173, 0.42)",
  "--info-surface": "rgba(125, 145, 173, 0.12)",
  "--info-text": "#a6b9d1",
  "--surface-panel-raised": "rgba(255, 255, 255, 0.055)",
  "--surface-fill-soft": "rgba(255, 255, 255, 0.035)",
  "--critical": "#ff8d86",
} as CSSProperties;

export function createInterviewPopupDragProps(enabled: boolean) {
  if (!enabled) {
    return {};
  }

  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      const target = event.currentTarget;
      const surfaceKind = target.dataset.surfaceKind as
        | "live_answer_overlay"
        | "live_transcript_overlay";
      let lastX = event.screenX;
      let lastY = event.screenY;

      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Electron automation can deliver pointer events without capture support.
      }
      const handleMove = (moveEvent: PointerEvent) => {
        const deltaX = Math.round(moveEvent.screenX - lastX);
        const deltaY = Math.round(moveEvent.screenY - lastY);
        lastX = moveEvent.screenX;
        lastY = moveEvent.screenY;

        if (deltaX !== 0 || deltaY !== 0) {
          void window.nestor.liveAssistant
            .moveOverlayWindow({
              surfaceKind,
              deltaX,
              deltaY,
            })
            .catch(() => {
              window.moveBy(deltaX, deltaY);
            });
        }
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      window.addEventListener("pointercancel", cleanup, { once: true });
    },
  };
}

function formatSource(source: InterviewTranscriptSegment["source"]) {
  switch (source) {
    case "meeting_audio":
      return "Interviewer";
    case "microphone":
      return "You";
    case "meeting_native_transcript":
      return "Meeting";
    case "typed_question":
      return "Typed question";
  }
}

export function ProtectionBadge({
  state,
}: {
  state: InterviewOverlaySnapshot["protectionState"];
}) {
  const protectedState = state === "verified_protected";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-[10px] font-semibold uppercase tracking-(--tracking-badge)",
        protectedState
          ? "border-(--success-border) bg-(--success-surface) text-(--success-text)"
          : "border-(--warning-border) bg-(--warning-surface) text-(--warning-text)",
      )}
    >
      <Shield className="size-3" />
      {protectedState ? "Protected" : "Protection not verified"}
    </span>
  );
}

export function AnswerCueOverlay(props: {
  snapshot: InterviewOverlaySnapshot;
  framed?: boolean;
}) {
  const cue = props.snapshot.currentCue;
  const compact = props.snapshot.mode === "compact";

  return (
    <section
      className={cn(
        "overflow-hidden border border-(--surface-panel-border-warm) bg-[rgba(8,8,9,0.82)] text-foreground shadow-[0_24px_90px_rgba(0,0,0,0.48)] backdrop-blur-2xl",
        props.framed ? "rounded-(--radius-panel)" : "flex h-screen flex-col",
      )}
      style={
        props.framed
          ? { opacity: props.snapshot.opacity }
          : interviewPopupThemeStyle
      }
    >
      <header
        className={cn(
          "flex items-center justify-between border-b border-border-subtle bg-white/[0.025] px-4 py-3",
          !props.framed ? "cursor-move" : "",
        )}
        {...createInterviewPopupDragProps(!props.framed)}
        data-surface-kind={props.snapshot.surfaceKind}
      >
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-(--warning-text)" />
          <div className="grid gap-0.5">
            <span className="text-[11px] font-bold uppercase tracking-(--tracking-badge)">
              Answer cues
            </span>
            <span className="text-[0.68rem] text-muted-foreground">
              {props.snapshot.statusLabel}
            </span>
          </div>
        </div>
        <div
          className="flex items-center gap-2"
          style={interviewPopupNoDragStyle}
        >
          <span className="rounded-sm border border-border-subtle bg-(--surface-fill-subtle) px-2 py-1 text-[10px] uppercase tracking-(--tracking-badge) text-muted-foreground">
            {compact ? "Compact" : "Expanded"}
          </span>
          <ProtectionBadge state={props.snapshot.protectionState} />
        </div>
      </header>

      <div
        className={cn(
          "grid gap-4 p-4",
          !props.framed &&
            (compact
              ? "min-h-0 flex-1 overflow-hidden"
              : "min-h-0 flex-1 overflow-y-auto"),
        )}
      >
        {cue ? (
          <>
            <div className="grid gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-(--tracking-badge) text-muted-foreground">
                Question detected
              </span>
              <p className="text-[0.96rem] leading-6 text-foreground">
                {cue.question}
              </p>
            </div>

            <div className="grid gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-(--tracking-badge) text-muted-foreground">
                Answer outline
              </span>
              <ul className="grid gap-2 text-[0.88rem] leading-5 text-foreground-soft">
                {cue.answerOutline.map((item) => (
                  <li key={item} className="flex gap-2">
                    <Check className="mt-0.5 size-3.5 text-(--success-text)" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              {cue.executionReceipt?.fallbackUsed ? (
                <p className="text-xs text-muted-foreground">
                  AI could not finish this cue; a built-in grounded fallback was
                  used.
                </p>
              ) : null}
            </div>

            {cue.supportingPoints.length > 0 && !compact ? (
              <div className="rounded-(--radius-small) border border-border-subtle bg-white/[0.025] p-3">
                <span className="text-[10px] font-semibold uppercase tracking-(--tracking-badge) text-muted-foreground">
                  Key points
                </span>
                <ul className="mt-2 grid gap-1.5 text-[0.8rem] leading-5 text-muted-foreground">
                  {cue.supportingPoints.map((point) => (
                    <li key={point}>- {point}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {cue.clarifyingQuestion ? (
              <p className="border-t border-border-subtle pt-3 text-[0.82rem] leading-5 text-(--warning-text)">
                {cue.clarifyingQuestion}
              </p>
            ) : null}

            <footer className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3 text-[0.72rem] text-muted-foreground">
              <span>{cue.disclosure.transcriptWindow}</span>
              <span>{cue.disclosure.screenshotCount} screenshots</span>
              {cue.disclosure.overlayContaminated ? (
                <span>Visual context may be incomplete.</span>
              ) : null}
            </footer>
          </>
        ) : (
          <div className="grid place-items-center gap-1.5 px-4 py-8 text-center">
            <Sparkles className="mx-auto size-5 text-(--warning-text)" />
            <p className="text-[0.88rem] text-muted-foreground">
              No cue card yet.
            </p>
            <p className="max-w-xs text-[0.74rem] leading-5 text-muted-foreground">
              Ask a question or let audio detect one and the answer outline will
              appear here.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export function TranscriptOverlay(props: {
  snapshot: InterviewOverlaySnapshot;
  framed?: boolean;
  onCopy?: () => void;
  onHide?: () => void;
  copyLabel?: string;
}) {
  const compact = props.snapshot.mode === "compact";

  return (
    <section
      className={cn(
        "overflow-hidden border border-(--info-border) bg-[rgba(8,8,9,0.84)] text-foreground shadow-[0_24px_90px_rgba(0,0,0,0.48)] backdrop-blur-2xl",
        props.framed ? "rounded-(--radius-panel)" : "flex h-screen flex-col",
      )}
      style={
        props.framed
          ? { opacity: props.snapshot.opacity }
          : interviewPopupThemeStyle
      }
    >
      <header
        className={cn(
          "flex items-center justify-between border-b border-border-subtle bg-white/[0.025] px-4 py-3",
          !props.framed ? "cursor-move" : "",
        )}
        {...createInterviewPopupDragProps(!props.framed)}
        data-surface-kind={props.snapshot.surfaceKind}
      >
        <div className="flex items-center gap-2">
          <Mic className="size-4 text-(--info-text)" />
          <div className="grid gap-0.5">
            <span className="text-[11px] font-bold uppercase tracking-(--tracking-badge)">
              Live transcript
            </span>
            <span className="text-[0.68rem] text-muted-foreground">
              {props.snapshot.queuedScreenshotCount} queued screenshots
            </span>
          </div>
        </div>
        <div
          className="flex items-center gap-2"
          style={interviewPopupNoDragStyle}
        >
          <span className="rounded-sm border border-border-subtle bg-(--surface-fill-subtle) px-2 py-1 text-[10px] uppercase tracking-(--tracking-badge) text-muted-foreground">
            {compact ? "Compact" : "Expanded"}
          </span>
          <ProtectionBadge state={props.snapshot.protectionState} />
          {!props.framed && props.onHide ? (
            <button
              aria-label="Hide transcript popup"
              className="grid size-7 place-items-center rounded-md border border-transparent text-muted-foreground transition hover:border-border-subtle hover:bg-white/[0.06] hover:text-foreground"
              onClick={props.onHide}
              title="Hide transcript popup"
              type="button"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      <div
        className={cn(
          "grid gap-4 overflow-y-auto p-4",
          props.framed
            ? compact
              ? "max-h-[18rem]"
              : "max-h-[28rem]"
            : "min-h-0 flex-1",
        )}
      >
        {props.snapshot.transcriptSegments.length > 0 ? (
          props.snapshot.transcriptSegments.map((segment) => (
            <article
              key={segment.id}
              className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3"
            >
              <time className="text-[0.72rem] text-muted-foreground">
                {new Date(segment.startedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
              <div className="grid gap-1">
                <span
                  className={cn(
                    "text-[10px] font-bold uppercase tracking-(--tracking-badge)",
                    segment.source === "meeting_audio"
                      ? "text-(--warning-text)"
                      : "text-(--info-text)",
                  )}
                >
                  {formatSource(segment.source)}
                </span>
                <p className="text-[0.86rem] leading-5 text-foreground-soft">
                  {segment.text}
                </p>
              </div>
            </article>
          ))
        ) : (
          <div className="grid place-items-center gap-1.5 px-4 py-8 text-center">
            <Mic className="mx-auto size-5 text-(--info-text)" />
            <p className="text-[0.86rem] text-muted-foreground">
              No transcript segments yet.
            </p>
            <p className="max-w-xs text-[0.74rem] leading-5 text-muted-foreground">
              Start mic or system audio and captured speech will stream in here.
            </p>
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-border-subtle px-4 py-3 text-[0.72rem] text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-(--success-text)" />
          {props.snapshot.statusLabel}
        </span>
        {!props.framed && props.onCopy ? (
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-white/[0.05] px-2.5 py-1.5 text-[0.72rem] font-semibold text-foreground transition hover:bg-white/[0.09]"
            onClick={props.onCopy}
            type="button"
          >
            {props.copyLabel ?? "Copy transcript"}
            <Copy className="size-3.5" />
          </button>
        ) : (
          <span>{props.snapshot.confidenceLabel}</span>
        )}
      </footer>
    </section>
  );
}
