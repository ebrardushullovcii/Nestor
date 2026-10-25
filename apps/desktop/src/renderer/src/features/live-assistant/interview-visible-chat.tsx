import { useEffect, useRef, useState } from "react";
import type {
  InterviewChatImageAttachmentInput,
  InterviewHotkeyAction,
  InterviewWorkspaceView,
} from "@nestor/contracts";
import { interviewChatLimits } from "@nestor/contracts";
import {
  Camera,
  Headphones,
  ImagePlus,
  LoaderCircle,
  Mic,
  PanelTop,
  Pause,
  Play,
  Send,
  Square,
  X,
} from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { getJobFinderScrollBehavior } from "../job-finder/lib/job-finder-scroll-behavior";
import { InterviewMediaStreamProbes } from "./interview-media-stream-probes";
import { formatInterviewTranscriptSource } from "./interview-transcript-source-label";
import { InterviewMarkdownContent } from "./interview-markdown-content";

interface PendingImage {
  id: string;
  input: InterviewChatImageAttachmentInput;
  previewUrl: string;
}

interface InterviewVisibleChatProps {
  audioTranscriptionAvailable: boolean;
  onPerform: (action: InterviewHotkeyAction) => Promise<void>;
  onGoToReview: () => void;
  onGoToSetup: () => void;
  onWorkspaceChange: (workspace: InterviewWorkspaceView) => void;
  pendingAction: string | null;
  workspace: InterviewWorkspaceView;
}

const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",")
        ? result.slice(result.indexOf(",") + 1)
        : "";
      if (!base64) {
        reject(new Error(`Could not read ${file.name}.`));
        return;
      }
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

export function InterviewVisibleChat(props: InterviewVisibleChatProps) {
  const session = props.workspace.activeSession;
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);
  const [captureSuspended, setCaptureSuspended] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => {
    return () => {
      for (const image of pendingImagesRef.current) {
        URL.revokeObjectURL(image.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    const container = conversationScrollRef.current;
    if (container) {
      // Shared Job Finder motion policy: instant under prefers-reduced-motion,
      // smooth otherwise. Never hardcode a behavior here.
      container.scrollTo({
        top: container.scrollHeight,
        behavior: getJobFinderScrollBehavior(),
      });
    }
  }, [session?.chatConversation?.updatedAt, session?.cueCards.length]);

  async function addImageFiles(files: readonly File[]) {
    setErrorMessage(null);
    const availableSlots = Math.max(
      0,
      interviewChatLimits.maxAttachmentsPerMessage - pendingImages.length,
    );
    const selectedFiles = files.slice(0, availableSlots);

    try {
      const nextImages = await Promise.all(
        selectedFiles.map(async (file, index): Promise<PendingImage> => {
          if (!supportedImageTypes.has(file.type)) {
            throw new Error(`${file.name} is not a PNG, JPEG, or WebP image.`);
          }
          if (file.size <= 0 || file.size > interviewChatLimits.maxImageBytes) {
            throw new Error(`${file.name} must be smaller than 12 MiB.`);
          }

          return {
            id: `pending_image_${Date.now()}_${index}`,
            input: {
              source: "file_picker",
              fileName: file.name,
              mimeType:
                file.type as InterviewChatImageAttachmentInput["mimeType"],
              dataBase64: await readFileAsBase64(file),
              byteSize: file.size,
              dimensions: null,
            },
            previewUrl: URL.createObjectURL(file),
          };
        }),
      );
      setPendingImages((current) => [...current, ...nextImages]);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not attach that image.",
      );
    }
  }

  function removePendingImage(id: string) {
    setPendingImages((current) => {
      const image = current.find((entry) => entry.id === id);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return current.filter((entry) => entry.id !== id);
    });
  }

  async function sendMessage() {
    if (!session || (draft.trim().length === 0 && pendingImages.length === 0))
      return;

    setSending(true);
    setErrorMessage(null);
    try {
      await window.nestor.liveAssistant.sendChatMessage({
        conversationId: `interview_${session.id}`,
        sessionId: session.id,
        content: draft,
        attachments: pendingImages.map((image) => image.input),
      });
      setDraft("");
      for (const image of pendingImages) URL.revokeObjectURL(image.previewUrl);
      setPendingImages([]);
      props.onWorkspaceChange(await window.nestor.liveAssistant.getWorkspace());
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Live Assistant could not answer.",
      );
    } finally {
      setSending(false);
    }
  }

  async function performSessionControl(
    action: Extract<InterviewHotkeyAction, "toggle_listening" | "end_session">,
  ) {
    const shouldStopCapture =
      action === "end_session" ||
      (action === "toggle_listening" && Boolean(session?.listening));
    if (shouldStopCapture) {
      setCaptureSuspended(true);
    }

    try {
      await props.onPerform(action);
    } finally {
      if (shouldStopCapture) {
        setCaptureSuspended(false);
      }
    }
  }

  async function setPopupVisibility(
    surfaceKind: "live_answer_overlay" | "live_transcript_overlay",
    visible: boolean,
  ) {
    props.onWorkspaceChange(
      await window.nestor.liveAssistant.updateOverlayPreference({
        surfaceKind,
        visible,
      }),
    );
  }

  const latestCue = session?.cueCards.at(-1) ?? null;
  const chatMessages = session?.chatConversation?.messages ?? [];
  const recentTranscript = session?.transcriptSegments.slice(-8) ?? [];
  const queuedScreenCaptures =
    props.workspace.answerOverlay.queuedScreenshotCount;

  if (!session || session.status === "ended") {
    return (
      <section className="surface-panel-shell grid min-h-[18rem] place-items-center rounded-(--radius-panel) border p-6 text-center">
        <div className="grid max-w-md gap-3">
          <div className="mx-auto grid size-10 place-items-center rounded-xl border border-(--info-border) bg-(--info-surface)">
            <Headphones className="size-5 text-(--info-text)" />
          </div>
          <h2 className="text-[1.05rem] font-semibold">
            No interview is active
          </h2>
          <p className="text-[0.84rem] leading-6 text-muted-foreground">
            Start a new interview from Setup, or return to Review to work with
            the most recently ended session.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={props.onGoToSetup} type="button">
              Start a new interview
            </Button>
            {props.workspace.recentSessions.length > 0 ? (
              <Button
                onClick={props.onGoToReview}
                type="button"
                variant="secondary"
              >
                Review last session
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="grid h-[calc(100vh-10rem)] min-h-[40rem] gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
      <section className="surface-panel-shell flex min-h-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border)">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div>
            <p className="text-[0.68rem] font-semibold uppercase tracking-(--tracking-badge) text-muted-foreground">
              Visible interview assistant
            </p>
            <h2 className="mt-1 text-[1.15rem] font-semibold">
              Ask, listen, and work through the answer
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.72rem] font-semibold",
                session?.listening
                  ? "border-(--success-border) bg-(--success-surface) text-(--success-text)"
                  : "border-(--warning-border) bg-(--warning-surface) text-(--warning-text)",
              )}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {session?.listening ? "Session listening" : "Session paused"}
            </span>
            <Button
              onClick={() => void performSessionControl("toggle_listening")}
              pending={props.pendingAction === "toggle_listening"}
              size="compact"
              variant="secondary"
            >
              {session?.listening ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
              {session?.listening ? "Pause" : "Resume"}
            </Button>
            <Button
              onClick={() => void performSessionControl("end_session")}
              pending={props.pendingAction === "end_session"}
              size="compact"
              variant="outline"
            >
              <Square className="size-3.5" />
              End
            </Button>
          </div>
        </header>

        <div
          className="flex-1 space-y-5 overflow-y-auto px-5 py-6"
          ref={conversationScrollRef}
        >
          {chatMessages.length === 0 ? (
            <div className="mx-auto grid max-w-xl place-items-center gap-3 py-14 text-center">
              <div className="grid size-12 place-items-center rounded-2xl border border-(--info-border) bg-(--info-surface)">
                <Headphones className="size-5 text-(--info-text)" />
              </div>
              <div>
                <h3 className="font-semibold">
                  The assistant is ready in this window
                </h3>
                <p className="mt-2 text-[0.84rem] leading-6 text-muted-foreground">
                  Type a question, paste an image, attach a screenshot, or let
                  the audio inputs add interview context.
                </p>
              </div>
            </div>
          ) : null}

          {chatMessages.map((message) =>
            message.role === "user" ? (
              <article
                className="ml-auto max-w-[82%] rounded-2xl rounded-br-sm border border-(--info-border) bg-(--info-surface) px-4 py-3 text-[0.86rem] leading-6 text-(--info-text)"
                key={message.id}
              >
                {message.content ? <p>{message.content}</p> : null}
                {message.attachments.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {message.attachments.map((attachment) => (
                      <span
                        className="rounded-md border border-(--info-border) px-2 py-1 text-[0.7rem]"
                        key={attachment.id}
                      >
                        {attachment.fileName}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            ) : (
              <article
                className="max-w-[88%] rounded-2xl rounded-bl-sm border border-border-subtle bg-(--surface-panel-raised) px-4 py-4"
                key={message.id}
              >
                <p className="mb-2 text-[0.66rem] font-semibold uppercase tracking-(--tracking-badge) text-(--warning-text)">
                  Live Assistant
                </p>
                <div className="text-[0.86rem] leading-6 text-foreground-soft">
                  <InterviewMarkdownContent content={message.content} />
                </div>
              </article>
            ),
          )}

          {latestCue && chatMessages.length === 0 ? (
            <article className="max-w-[88%] rounded-2xl rounded-bl-sm border border-border-subtle bg-(--surface-panel-raised) px-4 py-4">
              <p className="text-[0.66rem] font-semibold uppercase tracking-(--tracking-badge) text-(--warning-text)">
                Latest live coaching
              </p>
              <h3 className="mt-2 font-semibold">{latestCue.question}</h3>
              <ul className="mt-3 grid gap-2 text-[0.84rem] leading-5 text-foreground-soft">
                {latestCue.answerOutline.map((item) => (
                  <li className="flex gap-2" key={item}>
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-(--warning-text)" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
        </div>

        <div className="border-t border-border-subtle bg-(--surface-fill-soft) p-4">
          {pendingImages.length > 0 ? (
            <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
              {pendingImages.map((image) => (
                <div className="relative shrink-0" key={image.id}>
                  <img
                    className="h-20 w-28 rounded-lg border border-border-subtle object-cover"
                    src={image.previewUrl}
                    alt={image.input.fileName}
                  />
                  <button
                    aria-label={`Remove ${image.input.fileName}`}
                    className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-border bg-canvas text-foreground"
                    onClick={() => removePendingImage(image.id)}
                    type="button"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {queuedScreenCaptures > 0 ? (
            <p className="mb-2 text-[0.72rem] text-(--success-text)">
              {queuedScreenCaptures} captured screen{" "}
              {queuedScreenCaptures === 1 ? "is" : "are"} queued as context for
              the next answer.
            </p>
          ) : null}
          <textarea
            className="min-h-16 w-full resize-none rounded-xl border border-border-subtle bg-(--surface-panel-raised) px-4 py-3 text-[0.88rem] leading-6 text-foreground outline-none transition focus:border-(--info-border)"
            disabled={!session || sending}
            maxLength={interviewChatLimits.maxMessageCharacters}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (files.length > 0) {
                event.preventDefault();
                void addImageFiles(files);
              }
            }}
            placeholder="Ask a question, paste a screenshot, or type what you need help answering…"
            value={draft}
          />
          {errorMessage ? (
            <p className="mt-2 text-[0.76rem] text-critical">{errorMessage}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <input
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                multiple
                onChange={(event) => {
                  void addImageFiles(
                    Array.from(event.currentTarget.files ?? []),
                  );
                  event.currentTarget.value = "";
                }}
                ref={fileInputRef}
                type="file"
              />
              <Button
                onClick={() => fileInputRef.current?.click()}
                size="compact"
                variant="secondary"
              >
                <ImagePlus className="size-4" />
                Attach image
              </Button>
              <Button
                disabled={!props.workspace.setup.consent.screenshotCapture}
                onClick={() => void props.onPerform("capture_screenshot")}
                pending={props.pendingAction === "capture_screenshot"}
                size="compact"
                variant="secondary"
              >
                <Camera className="size-4" />
                Capture screen
              </Button>
            </div>
            <Button
              disabled={
                !session ||
                (draft.trim().length === 0 && pendingImages.length === 0) ||
                sending
              }
              onClick={() => void sendMessage()}
            >
              {sending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Send
            </Button>
          </div>
        </div>
      </section>

      <aside className="grid content-start gap-4">
        <section className="surface-card-tint rounded-(--radius-panel) border p-4">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-[0.75rem] font-bold uppercase tracking-(--tracking-badge)">
              Audio inputs
            </h2>
            <div className="flex items-center gap-2 text-[0.68rem] text-muted-foreground">
              <Mic className="size-3.5" />
              <span>live</span>
            </div>
          </div>
          {session ? (
            <InterviewMediaStreamProbes
              audioTranscriptionAvailable={props.audioTranscriptionAvailable}
              language={props.workspace.setup.transcriptionLanguage}
              listening={session.listening && !captureSuspended}
              meetingAudioCaptureAllowed={
                props.workspace.setup.consent.meetingAudioCapture
              }
              microphoneCaptureAllowed={
                props.workspace.setup.consent.microphoneCapture
              }
              onWorkspaceChange={props.onWorkspaceChange}
              sessionId={session.id}
              workspace={props.workspace}
            />
          ) : (
            <p className="text-[0.8rem] leading-5 text-muted-foreground">
              Start an interview to enable microphone and system audio.
            </p>
          )}
        </section>

        <section className="surface-card-tint rounded-(--radius-panel) border p-4">
          <h2 className="text-[0.75rem] font-bold uppercase tracking-(--tracking-badge)">
            Recent transcript
          </h2>
          <div className="mt-3 grid max-h-80 gap-3 overflow-y-auto">
            {recentTranscript.length === 0 ? (
              <p className="text-[0.78rem] leading-5 text-muted-foreground">
                No audio or typed transcript yet.
              </p>
            ) : (
              recentTranscript.map((segment) => (
                <div
                  className="rounded-lg border border-border-subtle bg-(--surface-fill-soft) p-3"
                  key={segment.id}
                >
                  <p className="text-[0.65rem] font-semibold uppercase tracking-(--tracking-badge) text-muted-foreground">
                    {formatInterviewTranscriptSource(segment.source)}
                  </p>
                  <p className="mt-1 text-[0.78rem] leading-5 text-foreground-soft">
                    {segment.text}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="surface-card-tint rounded-(--radius-panel) border p-4">
          <div className="mb-3 flex items-center gap-2">
            <PanelTop className="size-4 text-(--warning-text)" />
            <h2 className="text-[0.75rem] font-bold uppercase tracking-(--tracking-badge)">
              Popup windows
            </h2>
          </div>
          <div className="grid gap-2">
            {[
              {
                surfaceKind: "live_answer_overlay" as const,
                label: "Answer",
                visible: props.workspace.answerOverlay.visible,
              },
              {
                surfaceKind: "live_transcript_overlay" as const,
                label: "Transcript",
                visible: props.workspace.transcriptOverlay.visible,
              },
            ].map((popup) => (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-(--surface-fill-soft) p-3"
                key={popup.surfaceKind}
              >
                <div>
                  <p className="text-[0.78rem] font-medium">{popup.label}</p>
                  <p className="mt-0.5 text-[0.68rem] text-muted-foreground">
                    {popup.visible ? "Open" : "Hidden"}
                  </p>
                </div>
                <Button
                  aria-label={`Open ${popup.label.toLowerCase()} popup`}
                  onClick={() =>
                    void setPopupVisibility(popup.surfaceKind, true)
                  }
                  size="compact"
                  variant="secondary"
                >
                  Open
                </Button>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}
