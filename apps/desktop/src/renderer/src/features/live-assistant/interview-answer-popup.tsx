import { useEffect, useRef, useState } from "react";
import type {
  InterviewChatImageAttachmentInput,
  InterviewWorkspaceView,
} from "@nestor/contracts";
import { interviewChatLimits } from "@nestor/contracts";
import {
  Camera,
  Check,
  Copy,
  ImagePlus,
  LoaderCircle,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import {
  createInterviewPopupDragProps,
  interviewPopupNoDragStyle,
  interviewPopupThemeStyle,
  ProtectionBadge,
} from "./interview-overlays";
import { InterviewMarkdownContent } from "./interview-markdown-content";

interface PendingImage {
  id: string;
  input: InterviewChatImageAttachmentInput;
  previewUrl: string;
}

interface InterviewAnswerPopupProps {
  onWorkspaceChange: (workspace: InterviewWorkspaceView) => void;
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

function getCopyableAnswer(workspace: InterviewWorkspaceView) {
  const session = workspace.activeSession;
  const latestAssistantMessage = session?.chatConversation?.messages
    .filter((message) => message.role === "assistant")
    .at(-1);
  if (latestAssistantMessage) return latestAssistantMessage.content;

  const cue = session?.cueCards.at(-1);
  if (!cue) return "";
  return [cue.question, ...cue.answerOutline].join("\n");
}

export function InterviewAnswerPopup(props: InterviewAnswerPopupProps) {
  const session = props.workspace.activeSession;
  const cue = session?.cueCards.at(-1) ?? null;
  const chatMessages = session?.chatConversation?.messages.slice(-8) ?? [];
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy answer");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  const conversationRef = useRef<HTMLDivElement | null>(null);

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
    const container = conversationRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [session?.chatConversation?.updatedAt, session?.cueCards.length]);

  async function addImageFiles(files: readonly File[]) {
    setErrorMessage(null);
    const availableSlots = Math.max(
      0,
      interviewChatLimits.maxAttachmentsPerMessage - pendingImages.length,
    );

    try {
      const nextImages = await Promise.all(
        files.slice(0, availableSlots).map(async (file, index) => {
          if (!supportedImageTypes.has(file.type)) {
            throw new Error(`${file.name} is not a PNG, JPEG, or WebP image.`);
          }
          if (file.size <= 0 || file.size > interviewChatLimits.maxImageBytes) {
            throw new Error(`${file.name} must be smaller than 12 MiB.`);
          }

          return {
            id: `popup_image_${Date.now()}_${index}`,
            input: {
              source: "file_picker" as const,
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
    if (!session || (draft.trim().length === 0 && pendingImages.length === 0)) {
      return;
    }

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

  async function captureScreen() {
    setErrorMessage(null);
    try {
      props.onWorkspaceChange(
        await window.nestor.liveAssistant.performAction("capture_screenshot"),
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not capture the screen.",
      );
    }
  }

  async function copyAnswer() {
    const text = getCopyableAnswer(props.workspace);
    if (!text) return;
    await window.nestor.liveAssistant.writeClipboardText({ text });
    setCopyLabel("Copied");
    window.setTimeout(() => setCopyLabel("Copy answer"), 1_500);
  }

  async function hidePopup() {
    props.onWorkspaceChange(
      await window.nestor.liveAssistant.updateOverlayPreference({
        surfaceKind: "live_answer_overlay",
        visible: false,
      }),
    );
  }

  const canSend = Boolean(
    session &&
    !sending &&
    (draft.trim().length > 0 || pendingImages.length > 0),
  );
  const canCopy = getCopyableAnswer(props.workspace).length > 0;

  return (
    <section
      className="flex h-screen flex-col overflow-hidden border border-(--surface-panel-border-warm) bg-[rgba(8,8,9,0.96)] text-foreground shadow-[0_24px_90px_rgba(0,0,0,0.58)] backdrop-blur-2xl"
      style={interviewPopupThemeStyle}
    >
      <header
        className="flex cursor-move items-center justify-between border-b border-border-subtle bg-white/[0.025] px-3 py-2.5"
        {...createInterviewPopupDragProps(true)}
        data-surface-kind="live_answer_overlay"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-(--warning-border) bg-(--warning-surface)">
            <Sparkles className="size-4 text-(--warning-text)" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-bold uppercase tracking-(--tracking-badge)">
              Interview copilot
            </p>
            <p className="truncate text-[0.68rem] text-muted-foreground">
              {props.workspace.answerOverlay.statusLabel}
            </p>
          </div>
        </div>
        <div
          className="flex shrink-0 items-center gap-1.5"
          style={interviewPopupNoDragStyle}
        >
          <ProtectionBadge
            state={props.workspace.answerOverlay.protectionState}
          />
          <button
            aria-label="Hide answer popup"
            className="grid size-8 place-items-center rounded-md border border-transparent text-muted-foreground transition hover:border-border-subtle hover:bg-white/[0.06] hover:text-foreground"
            onClick={() => void hidePopup()}
            title="Hide answer popup"
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
        ref={conversationRef}
      >
        {chatMessages.length === 0 && !cue ? (
          <div className="grid min-h-40 place-items-center px-6 text-center">
            <div>
              <Sparkles className="mx-auto size-6 text-(--warning-text)" />
              <p className="mt-3 text-sm font-semibold">Ready when you are</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Ask a question or attach a screenshot without leaving the call.
              </p>
            </div>
          </div>
        ) : null}

        {chatMessages.map((message) => (
          <article
            className={
              message.role === "user"
                ? "ml-auto max-w-[88%] rounded-xl rounded-br-sm border border-(--info-border) bg-[rgba(86,164,255,0.09)] px-3 py-2.5 text-xs leading-5 text-(--info-text)"
                : "max-w-[94%] rounded-xl rounded-bl-sm border border-border-subtle bg-white/[0.045] px-3 py-3 text-xs leading-5 text-foreground-soft"
            }
            key={message.id}
          >
            {message.role === "assistant" ? (
              <>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-(--tracking-badge) text-(--warning-text)">
                  Suggested answer
                </p>
                <InterviewMarkdownContent content={message.content} />
              </>
            ) : (
              <p className="whitespace-pre-wrap">{message.content}</p>
            )}
            {message.attachments.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {message.attachments.map((attachment) => (
                  <span
                    className="rounded border border-current/20 px-1.5 py-0.5 text-[10px]"
                    key={attachment.id}
                  >
                    {attachment.fileName}
                  </span>
                ))}
              </div>
            ) : null}
          </article>
        ))}

        {chatMessages.length === 0 && cue ? (
          <article className="rounded-xl border border-(--warning-border) bg-(--warning-surface) p-3">
            <p className="text-[10px] font-bold uppercase tracking-(--tracking-badge) text-(--warning-text)">
              Question detected
            </p>
            <h2 className="mt-2 text-sm font-semibold leading-5">
              {cue.question}
            </h2>
            <ul className="mt-3 grid gap-2 text-xs leading-5 text-foreground-soft">
              {cue.answerOutline.map((item) => (
                <li className="flex gap-2" key={item}>
                  <Check className="mt-0.5 size-3.5 shrink-0 text-(--success-text)" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </article>
        ) : null}
      </div>

      <div className="border-t border-border-subtle bg-(--surface-fill-subtle) p-3">
        {pendingImages.length > 0 ? (
          <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
            {pendingImages.map((image) => (
              <div className="relative shrink-0" key={image.id}>
                <img
                  alt={image.input.fileName}
                  className="h-14 w-20 rounded-md border border-border-subtle object-cover"
                  src={image.previewUrl}
                />
                <button
                  aria-label={`Remove ${image.input.fileName}`}
                  className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full border border-border-subtle bg-black text-foreground"
                  onClick={() => removePendingImage(image.id)}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          aria-label="Ask Interview Copilot"
          className="min-h-14 w-full resize-none rounded-lg border border-border-subtle bg-white/[0.045] px-3 py-2.5 text-xs leading-5 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-(--info-border)"
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
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (files.length > 0) {
              event.preventDefault();
              void addImageFiles(files);
            }
          }}
          placeholder="Ask for an answer, follow-up, or feedback…"
          value={draft}
        />
        {errorMessage ? (
          <p className="mt-2 text-[11px] text-(--critical)">{errorMessage}</p>
        ) : null}

        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <input
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              multiple
              onChange={(event) => {
                void addImageFiles(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            <button
              aria-label="Attach image"
              className="grid size-8 place-items-center rounded-md border border-border-subtle text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
              type="button"
            >
              <ImagePlus className="size-3.5" />
            </button>
            <button
              aria-label="Capture screen as answer context"
              className="grid size-8 place-items-center rounded-md border border-border-subtle text-muted-foreground transition enabled:hover:bg-white/[0.06] enabled:hover:text-foreground disabled:opacity-35"
              disabled={!props.workspace.setup.consent.screenshotCapture}
              onClick={() => void captureScreen()}
              title="Capture screen as answer context"
              type="button"
            >
              <Camera className="size-3.5" />
            </button>
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2 text-[11px] text-muted-foreground transition enabled:hover:bg-white/[0.06] enabled:hover:text-foreground disabled:opacity-35"
              disabled={!canCopy}
              onClick={() => void copyAnswer()}
              type="button"
            >
              <Copy className="size-3.5" />
              {copyLabel}
            </button>
          </div>
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 text-[11px] font-semibold text-(--warning-text) transition enabled:hover:brightness-110 disabled:opacity-35"
            disabled={!canSend}
            onClick={() => void sendMessage()}
            type="button"
          >
            {sending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            Send
          </button>
        </div>
      </div>
    </section>
  );
}
