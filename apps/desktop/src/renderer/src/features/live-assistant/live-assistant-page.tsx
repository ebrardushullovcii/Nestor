import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import type {
  DesktopWindowControlsState,
  InterviewExportResult,
  InterviewHotkeyAction,
  JobFinderInterviewFollowUpInput,
  InterviewOverlaySnapshot,
  SaveInterviewSetupInput,
  InterviewTranscriptSource,
  InterviewWorkspaceView,
  InterviewLiveSession,
} from "@nordri/contracts";
import {
  Archive,
  Camera,
  CheckCircle2,
  Clock,
  FileDown,
  ListChecks,
  LoaderCircle,
  Minus,
  PanelTop,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Send,
  Settings2,
  Shield,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@renderer/components/ui/button";
import { NordriWordmark } from "@renderer/components/brand/nordri-wordmark";
import { ModuleSwitch } from "@renderer/components/module-switch";
import { cn } from "@renderer/lib/cn";
import { AnswerCueOverlay, TranscriptOverlay } from "./interview-overlays";
import { InterviewAnswerPopup } from "./interview-answer-popup";
import { TranscriptAnnotationPanel } from "./interview-review-annotations";
import { InterviewCaptionFileWatcher } from "./interview-caption-file-watcher";
import { InterviewDiagnosticsPanel } from "./interview-diagnostics-panel";
import { InterviewDeleteSessionDialog } from "./interview-delete-session-dialog";
import { InterviewMediaStreamProbes } from "./interview-media-stream-probes";
import { InterviewNativeCaptionWatcher } from "./interview-native-caption-watcher";
import { InterviewSessionPreferences } from "./interview-session-preferences";
import { InterviewVisibleChat } from "./interview-visible-chat";
import { formatInterviewTranscriptSource } from "./interview-transcript-source-label";

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      workspace: InterviewWorkspaceView;
      exportResult: InterviewExportResult | null;
    }
  | { status: "error"; message: string };

function StatusPill(props: {
  label: string;
  tone?: "success" | "warning" | "critical" | "info";
}) {
  const tone = props.tone ?? "info";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-(--tracking-badge)",
        tone === "success" &&
          "border-(--success-border) bg-(--success-surface) text-(--success-text)",
        tone === "warning" &&
          "border-(--warning-border) bg-(--warning-surface) text-(--warning-text)",
        tone === "critical" &&
          "border-critical/35 bg-critical/10 text-critical",
        tone === "info" &&
          "border-(--info-border) bg-(--info-surface) text-(--info-text)",
      )}
    >
      {props.label}
    </span>
  );
}

function Panel(props: {
  children: React.ReactNode;
  className?: string;
  id?: string;
  title: string;
  index?: number;
}) {
  return (
    <section
      className={cn(
        "surface-panel-shell relative scroll-mt-32 overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) p-4",
        props.className,
      )}
      id={props.id}
    >
      <header className="mb-4 flex items-center gap-2">
        <h2 className="text-[0.78rem] font-bold uppercase tracking-(--tracking-badge)">
          {props.title}
        </h2>
      </header>
      {props.children}
    </section>
  );
}

function getTargetLabel(workspace: InterviewWorkspaceView) {
  return workspace.setup.targetContext?.label ?? "General interview";
}

function getInitialInterviewTab(workspace: InterviewWorkspaceView) {
  if (workspace.activeSession && workspace.activeSession.status !== "ended") {
    return "assist";
  }

  if (workspace.recentSessions.length > 0) {
    return "review";
  }

  return "setup";
}

export function getInterviewModeLabel(
  activeTab: "setup" | "assist" | "review" | "settings",
  isLiveSession: boolean,
) {
  if (isLiveSession) {
    return activeTab === "assist"
      ? "Live session"
      : `Live session · ${{ setup: "Setup", review: "Review", settings: "Settings" }[activeTab]}`;
  }

  switch (activeTab) {
    case "assist":
      return "Assist mode";
    case "review":
      return "Review mode";
    case "settings":
      return "Settings mode";
    default:
      return "Setup mode";
  }
}

export function inferInterviewRendererPlatform(
  rendererPlatform: string,
): "darwin" | "linux" | "win32" {
  const normalizedPlatform = rendererPlatform.toLowerCase();

  if (normalizedPlatform.includes("mac")) return "darwin";
  if (normalizedPlatform.includes("linux")) return "linux";
  return "win32";
}

export function formatRetainedCueCardCount(count: number) {
  return `${count} cue card${count === 1 ? "" : "s"} retained`;
}

export function getInterviewDocumentTitle(
  activeTab: "setup" | "assist" | "review" | "settings",
  isLiveSession: boolean,
) {
  return `${getInterviewModeLabel(activeTab, isLiveSession)} | Live Assistant | Nordri`;
}

export function shouldApplyInterviewWorkspaceSnapshot(
  currentGeneratedAt: string,
  nextGeneratedAt: string,
) {
  const currentTimestamp = Date.parse(currentGeneratedAt);
  const nextTimestamp = Date.parse(nextGeneratedAt);

  if (!Number.isFinite(currentTimestamp) || !Number.isFinite(nextTimestamp)) {
    return true;
  }

  return nextTimestamp >= currentTimestamp;
}

const LAST_JOB_FINDER_ROUTE_STORAGE_KEY =
  "nordri.live-assistant.last-job-finder-route";
const JOB_FINDER_ROUTE_FALLBACK = "/job-finder";
const JOB_FINDER_ROUTE_PATTERN = /^\/job-finder(?:$|[/?#])/;

type RouteRecordingHistory = Pick<History, "pushState" | "replaceState">;

export function recordLastJobFinderRoute(
  storage: Storage,
  url: string | URL | null | undefined,
) {
  if (!url) return;

  const raw = String(url);
  const hashIndex = raw.indexOf("#");
  const route = hashIndex === -1 ? raw : raw.slice(hashIndex + 1);

  if (!JOB_FINDER_ROUTE_PATTERN.test(route)) return;

  storage.setItem(LAST_JOB_FINDER_ROUTE_STORAGE_KEY, route);
}

export function getLastJobFinderRoute(storage?: Storage) {
  const stored = (storage ?? window.sessionStorage).getItem(
    LAST_JOB_FINDER_ROUTE_STORAGE_KEY,
  );

  if (stored && JOB_FINDER_ROUTE_PATTERN.test(stored)) {
    return stored;
  }

  return JOB_FINDER_ROUTE_FALLBACK;
}

const patchedJobFinderRecorderHistories = new WeakSet<RouteRecordingHistory>();

function patchHistoryRouteMethod(
  history: RouteRecordingHistory,
  method: "pushState" | "replaceState",
  storage: Storage,
) {
  const original = history[method].bind(history);
  history[method] = (
    data: Parameters<History["pushState"]>[0],
    unused: string,
    url?: string | URL | null,
  ) => {
    recordLastJobFinderRoute(storage, url);
    original(data, unused, url);
  };
}

export function installJobFinderRouteRecorder(
  history: RouteRecordingHistory,
  storage: Storage,
): void {
  if (patchedJobFinderRecorderHistories.has(history)) return;
  patchedJobFinderRecorderHistories.add(history);

  patchHistoryRouteMethod(history, "pushState", storage);
  patchHistoryRouteMethod(history, "replaceState", storage);
}

export function LiveAssistantPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(
    null,
  );
  const [reviewedSession, setReviewedSession] =
    useState<InterviewLiveSession | null>(null);
  const [reviewLoadError, setReviewLoadError] = useState<string | null>(null);
  const [reviewTranscriptPage, setReviewTranscriptPage] = useState(1);
  const [isTranscriptPagePending, startTranscriptPageTransition] =
    useTransition();
  const transcriptPreviousRef = useRef<HTMLButtonElement>(null);
  const transcriptNextRef = useRef<HTMLButtonElement>(null);
  const transcriptPageFocusRef = useRef<"previous" | "next" | null>(null);
  const [followUpDraft, setFollowUpDraft] = useState("");
  const [jobFinderWriteBackStatus, setJobFinderWriteBackStatus] = useState<
    string | null
  >(null);
  const [activeTab, setActiveTab] = useState<
    "setup" | "assist" | "review" | "settings"
  >("setup");
  const [transcriptSource, setTranscriptSource] =
    useState<InterviewTranscriptSource>("typed_question");
  const [transcriptDraft, setTranscriptDraft] = useState("");
  const [platform, setPlatform] = useState<"darwin" | "linux" | "win32">(() =>
    inferInterviewRendererPlatform(navigator.platform),
  );
  const [windowControlsState, setWindowControlsState] =
    useState<DesktopWindowControlsState>({
      isClosable: true,
      isFullScreen: false,
      isMaximized: false,
      isMinimizable: true,
    });
  const appliedTargetContextKeyRef = useRef<string | null>(null);
  const dragRegionStyle = { WebkitAppRegion: "drag" } as CSSProperties;
  const noDragRegionStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;
  const isMac = platform === "darwin";
  const closeDeleteConfirmation = useCallback(() => {
    setDeleteSessionError(null);
    setDeleteConfirmationOpen(false);
  }, []);

  function applyWorkspaceSnapshot(
    workspace: InterviewWorkspaceView,
    force = false,
  ) {
    setState((current) => {
      if (
        !force &&
        current.status === "ready" &&
        !shouldApplyInterviewWorkspaceSnapshot(
          current.workspace.generatedAt,
          workspace.generatedAt,
        )
      ) {
        return current;
      }

      return {
        status: "ready",
        workspace,
        exportResult: current.status === "ready" ? current.exportResult : null,
      };
    });
  }

  async function loadWorkspace() {
    try {
      const workspace = await window.nordri.liveAssistant.getWorkspace();
      setActiveTab(getInitialInterviewTab(workspace));
      setState({ status: "ready", workspace, exportResult: null });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Live Assistant failed to load.",
      });
    }
  }

  const jobFinderReturnRoute = getLastJobFinderRoute();

  useEffect(() => {
    installJobFinderRouteRecorder(window.history, window.sessionStorage);
  }, []);

  useEffect(() => {
    void loadWorkspace();
    return window.nordri.liveAssistant.onWorkspaceChange(
      applyWorkspaceSnapshot,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = window.nordri.window.onControlsStateChange(
      (controlsState) => {
        if (!cancelled) {
          setWindowControlsState(controlsState);
        }
      },
    );

    void Promise.all([
      window.nordri.ping(),
      window.nordri.window.getControlsState(),
    ])
      .then(([platformResponse, controlsState]) => {
        if (!cancelled) {
          setPlatform(platformResponse.platform);
          setWindowControlsState(controlsState);
        }
      })
      .catch(() => {
        // Keep the default Windows-like controls state when the bridge is unavailable.
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function runWindowAction(
    action: () => Promise<DesktopWindowControlsState>,
  ): Promise<void> {
    try {
      const nextControlsState = await action();
      setWindowControlsState(nextControlsState);
    } catch {
      // Keep current controls state if the desktop action fails.
    }
  }

  function minimizeWindow() {
    void runWindowAction(() => window.nordri.window.minimize());
  }

  function toggleWindowExpand() {
    void runWindowAction(() => window.nordri.window.toggleMaximize());
  }

  function closeWindow() {
    void window.nordri.window.close();
  }

  async function updateWorkspace(
    actionId: string,
    action: () => Promise<InterviewWorkspaceView>,
  ) {
    setPendingAction(actionId);
    try {
      const workspace = await action();
      applyWorkspaceSnapshot(workspace, true);
    } finally {
      setPendingAction(null);
    }
  }

  async function perform(action: InterviewHotkeyAction) {
    await updateWorkspace(action, () =>
      window.nordri.liveAssistant.performAction(action),
    );
    if (action === "end_session") {
      setActiveTab("review");
    }
  }

  function saveSetupPreference(input: SaveInterviewSetupInput) {
    void updateWorkspace("setup_preferences", () =>
      window.nordri.liveAssistant.saveSetup(input),
    );
  }

  async function verifyOverlayProtection() {
    await updateWorkspace("verify_overlay_protection", () =>
      window.nordri.liveAssistant.verifyOverlayProtection(),
    );
  }

  async function resetOverlayLayout() {
    await updateWorkspace("reset_overlay_layout", () =>
      window.nordri.liveAssistant.resetOverlayPreferences(),
    );
  }

  async function setOverlayVisibility(
    overlay: InterviewOverlaySnapshot,
    visible: boolean,
  ) {
    await updateWorkspace(`set_${overlay.surfaceKind}_${String(visible)}`, () =>
      window.nordri.liveAssistant.updateOverlayPreference({
        surfaceKind: overlay.surfaceKind,
        visible,
      }),
    );
  }

  async function toggleReconfiguration() {
    if (
      state.status === "ready" &&
      state.workspace.activeSession?.status === "reconfiguring"
    ) {
      await updateWorkspace("finish_reconfiguration", () =>
        window.nordri.liveAssistant.finishReconfiguration(),
      );
      return;
    }

    await updateWorkspace("begin_reconfiguration", () =>
      window.nordri.liveAssistant.beginReconfiguration(),
    );
  }

  useEffect(() => {
    const source = searchParams.get("source");
    const id = searchParams.get("id");
    const label = searchParams.get("label");
    const targetContextKey = searchParams.toString();

    const targetContextKind =
      source === "saved_job"
        ? "saved_job"
        : source === "job_application"
          ? "job_application"
          : null;

    if (
      state.status !== "ready" ||
      state.workspace.activeSession ||
      !targetContextKind ||
      !id ||
      !label ||
      appliedTargetContextKeyRef.current === targetContextKey
    ) {
      return;
    }

    appliedTargetContextKeyRef.current = targetContextKey;
    void window.nordri.liveAssistant
      .saveSetup({
        targetContext: {
          kind: targetContextKind,
          id,
          label,
          role: searchParams.get("role"),
          company: searchParams.get("company"),
          sourceUrl: searchParams.get("sourceUrl"),
          notes: searchParams.get("notes"),
          savedJob: null,
          profileSnapshot: null,
          confirmedAt: new Date().toISOString(),
        },
      })
      .then((workspace) => {
        applyWorkspaceSnapshot(workspace);
      });
  }, [searchParams, state]);

  async function submitTranscriptSegment() {
    const currentActiveSession =
      state.status === "ready" ? state.workspace.activeSession : null;

    if (!currentActiveSession || transcriptDraft.trim().length === 0) {
      return;
    }

    const text = transcriptDraft.trim();
    setTranscriptDraft("");
    await updateWorkspace("add_transcript_segment", () =>
      window.nordri.liveAssistant.addTranscriptSegment({
        sessionId: currentActiveSession.id,
        source: transcriptSource,
        text,
        engineKind:
          transcriptSource === "meeting_native_transcript" ||
          transcriptSource === "typed_question"
            ? "platform_local"
            : "browser_speech",
        language:
          state.status === "ready"
            ? state.workspace.setup.transcriptionLanguage
            : "en-US",
      }),
    );
  }

  const pageHasLiveSession =
    state.status === "ready" &&
    Boolean(
      state.workspace.activeSession &&
      state.workspace.activeSession.status !== "ended",
    );

  useEffect(() => {
    document.title = getInterviewDocumentTitle(activeTab, pageHasLiveSession);
  }, [activeTab, pageHasLiveSession]);

  const latestArchive =
    state.status === "ready" && !state.workspace.activeSession
      ? state.workspace.recentSessions[0]
      : null;
  useEffect(() => {
    setReviewTranscriptPage(1);
  }, [latestArchive?.id]);
  useLayoutEffect(() => {
    if (isTranscriptPagePending) return;
    const direction = transcriptPageFocusRef.current;
    if (!direction) return;
    transcriptPageFocusRef.current = null;
    const preferred =
      direction === "next"
        ? transcriptNextRef.current
        : transcriptPreviousRef.current;
    const fallback =
      direction === "next"
        ? transcriptPreviousRef.current
        : transcriptNextRef.current;
    (preferred && !preferred.disabled
      ? preferred
      : fallback && !fallback.disabled
        ? fallback
        : null
    )?.focus();
  }, [reviewTranscriptPage, isTranscriptPagePending]);
  useEffect(() => {
    let cancelled = false;
    setReviewedSession(null);
    setReviewLoadError(null);
    if (latestArchive && activeTab === "review") {
      void window.nordri.liveAssistant.getSession(latestArchive.id).then(
        (session) => {
          if (!cancelled) {
            setReviewedSession(session);
            if (!session) setReviewLoadError("Retained session was not found.");
          }
        },
        (error: unknown) => {
          if (!cancelled)
            setReviewLoadError(
              error instanceof Error
                ? error.message
                : "Session review failed to load.",
            );
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [latestArchive, activeTab]);

  if (state.status === "loading") {
    return (
      <main className="grid h-screen place-items-center bg-canvas">
        <p className="text-muted-foreground">Loading Live Assistant...</p>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="grid h-screen place-items-center bg-canvas">
        <div className="rounded-(--radius-panel) border border-critical/30 bg-critical/10 p-6">
          <p>{state.message}</p>
        </div>
      </main>
    );
  }

  const { workspace } = state;
  const activeSession = workspace.activeSession;
  const isLiveSession = pageHasLiveSession;
  const advancedSurfaceUiEnabled =
    import.meta.env.VITE_NORDRI_INTERVIEW_ADVANCED_SURFACES === "1";
  const rehearsal = workspace.setup.rehearsal;
  const reviewSession = activeSession ? null : reviewedSession;
  const transcriptSegments = reviewSession?.transcriptSegments ?? [];
  const transcriptPageSize = 40;
  const transcriptPageCount = Math.max(
    1,
    Math.ceil(transcriptSegments.length / transcriptPageSize),
  );
  const currentTranscriptPage = Math.min(
    reviewTranscriptPage,
    transcriptPageCount,
  );
  const transcriptStartIndex = (currentTranscriptPage - 1) * transcriptPageSize;
  const pagedTranscriptSegments = transcriptSegments.slice(
    transcriptStartIndex,
    transcriptStartIndex + transcriptPageSize,
  );
  const changeTranscriptPage = (
    page: number,
    direction: "previous" | "next",
  ) => {
    transcriptPageFocusRef.current = direction;
    startTranscriptPageTransition(() => setReviewTranscriptPage(page));
  };
  const latestCue = reviewSession?.cueCards.at(-1) ?? null;
  const checks = rehearsal?.checks ?? [];
  const rehearsalReady =
    rehearsal?.status === "passed" || rehearsal?.status === "degraded";
  const audioTranscriptionAvailable = Boolean(
    rehearsal?.meetingAudioEngine.ready &&
    rehearsal.meetingAudioEngine.kind !== "deterministic",
  );
  const hardBlocks = checks.filter(
    (check) => check.required && check.status !== "available",
  );
  const targetLabel = getTargetLabel(workspace);
  const canExport = Boolean(reviewSession);
  const liveOverlaySummaries: Array<{
    label: string;
    overlay: InterviewOverlaySnapshot;
  }> = [
    { label: "Answer cues", overlay: workspace.answerOverlay },
    { label: "Live transcript", overlay: workspace.transcriptOverlay },
  ];
  const overlayInteractionEnabled = liveOverlaySummaries.some(
    ({ overlay }) => overlay.interactionMode,
  );
  const consentAccepted = Boolean(
    workspace.setup.consent.modelTransmission &&
    workspace.setup.consent.localRetention &&
    workspace.setup.consent.overlayProtectionNotice &&
    workspace.setup.consent.acceptedAt,
  );
  const readinessBlocked = hardBlocks.length > 0 || !consentAccepted;
  const interviewModeLabel = getInterviewModeLabel(activeTab, isLiveSession);
  const activeTabDefinitions = [
    { id: "setup", label: "Setup" },
    { id: "assist", label: "Assist" },
    { id: "review", label: "Review" },
    { id: "settings", label: "Settings" },
  ] as const;
  const reviewDisabledButtonClass =
    "disabled:border-border/75 disabled:bg-(--surface-panel-raised) disabled:text-foreground-soft disabled:opacity-90 disabled:saturate-100";
  const reviewDisabledDangerButtonClass =
    "disabled:border-critical/35 disabled:bg-critical/35 disabled:text-critical-foreground disabled:opacity-90 disabled:saturate-100";
  const setupPrimaryAction = !consentAccepted
    ? {
        id: "accept_setup",
        label: "Accept notices and continue",
        detail:
          "Accept the assistant, local-retention, and visible-overlay notices. Microphone, system audio, and screenshots remain separate opt-ins.",
      }
    : !rehearsalReady
      ? {
          id: "rehearsal",
          label: "Run quick check",
          detail:
            "Check microphone, system audio, transcription, screenshots, and assistant responses before the interview.",
        }
      : {
          id: "start",
          label: "Start interview",
          detail:
            "Open the visible chat and begin listening for interview context.",
        };
  const setupPrimaryStage = !consentAccepted
    ? "Accept the required notices"
    : !rehearsalReady
      ? "Check your readiness"
      : "Ready to start";

  async function acceptSetup() {
    await updateWorkspace("accept_setup", () =>
      window.nordri.liveAssistant.saveSetup({
        consent: {
          ...workspace.setup.consent,
          modelTransmission: true,
          localRetention: true,
          overlayProtectionNotice: true,
          acceptedAt: new Date().toISOString(),
        },
      }),
    );
  }

  async function runQuickCheck() {
    await updateWorkspace("rehearsal", () =>
      window.nordri.liveAssistant.runRehearsal(),
    );
  }

  async function startInterview() {
    await updateWorkspace("start", () =>
      window.nordri.liveAssistant.startSession(),
    );
    setActiveTab("assist");
  }

  async function runSetupPrimaryAction() {
    if (!consentAccepted) {
      await acceptSetup();
      return;
    }

    if (!rehearsalReady) {
      await runQuickCheck();
      return;
    }

    await startInterview();
  }

  async function exportLatest(format: "markdown" | "json") {
    if (!reviewSession) return;

    setPendingAction(`export_${format}`);
    try {
      const exportResult = await window.nordri.liveAssistant.exportSession(
        reviewSession.id,
        format,
      );
      setState({ status: "ready", workspace, exportResult });
    } finally {
      setPendingAction(null);
    }
  }

  async function recordJobFinderFollowUp(
    action: JobFinderInterviewFollowUpInput["action"],
  ) {
    if (
      !reviewSession ||
      reviewSession.targetContext.kind !== "job_application"
    ) {
      return;
    }

    const note = followUpDraft.trim();
    const input: JobFinderInterviewFollowUpInput = {
      applicationRecordId: reviewSession.targetContext.id,
      sessionId: reviewSession.id,
      action,
      ...(note.length > 0 ? { note } : {}),
    };

    setPendingAction(action);
    setJobFinderWriteBackStatus(null);
    try {
      await window.nordri.liveAssistant.recordJobFinderFollowUp(input);
      setJobFinderWriteBackStatus(
        action === "mark_interviewed"
          ? "Job Finder application marked interviewed."
          : "Job Finder follow-up note added.",
      );
      if (action === "add_follow_up_note") {
        setFollowUpDraft("");
      }
    } catch (error) {
      setJobFinderWriteBackStatus(
        error instanceof Error
          ? error.message
          : "Job Finder follow-up update failed.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div
      className={cn(
        "h-screen overflow-hidden bg-canvas text-foreground",
        `platform-${platform}`,
      )}
      data-live-assistant-shell
    >
      <header
        className="fixed inset-x-0 top-0 z-50 border-b border-border/15 bg-(--shell-header-bg) backdrop-blur-sm"
        style={dragRegionStyle}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[2.5rem_4rem] items-stretch pl-2 pr-0 sm:pl-3 sm:pr-0 lg:grid-cols-[var(--job-finder-side-width-sm)_minmax(0,1fr)_auto]">
          <div
            className="col-start-1 row-start-1 flex min-w-0 items-center pl-2 sm:pl-3 lg:row-span-2"
            data-desktop-brand
            style={{
              ...dragRegionStyle,
              paddingInlineStart:
                isMac && !windowControlsState.isFullScreen
                  ? "5.5rem"
                  : undefined,
            }}
          >
            <div className="flex min-w-0 flex-col">
              <Link
                aria-label="Nordri"
                className="text-(--headline-primary)"
                style={noDragRegionStyle}
                to={jobFinderReturnRoute}
              >
                <NordriWordmark className="block h-[1.05rem] w-auto sm:h-[1.3rem]" />
              </Link>
              {/* Mirrors the Job Finder shell: the module switch sits
                  directly under the wordmark, at the head of the module's own
                  navigation surface, instead of floating in the caption row.
                  It replaces the caption that used to name the module here.
                  Icons are dropped here as they are in the Job Finder rail —
                  the two names carry the meaning, and they are what has to fit.
                  This header stays a single row rather than stacking: it is a
                  2.5rem caption row below the wide layout, so vertical space is
                  the scarce axis here, and the control sizes to its content
                  instead of to a 17rem rail, which is why both names fit
                  side by side. */}
              <ModuleSwitch
                activeModule="live-assistant"
                className="mt-1 hidden sm:inline-flex"
                onSelectModule={() => {
                  void navigate(jobFinderReturnRoute);
                }}
                style={noDragRegionStyle}
              />
            </div>
          </div>

          <div
            className="absolute right-0 top-0 z-20 flex h-10 items-start justify-end self-start"
            style={dragRegionStyle}
          >
            {!isMac ? (
              <div
                className="flex h-full items-stretch gap-0"
                role="group"
                aria-label="Window controls"
                style={noDragRegionStyle}
              >
                <Button
                  aria-label="Minimize window"
                  className="h-full w-11 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-(--surface-panel-raised) hover:text-foreground"
                  disabled={!windowControlsState.isMinimizable}
                  onClick={minimizeWindow}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Minus className="size-3.5" />
                </Button>
                <Button
                  aria-label={
                    windowControlsState.isMaximized
                      ? "Restore window"
                      : "Maximize window"
                  }
                  className="h-full w-11 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-(--surface-panel-raised) hover:text-foreground"
                  onClick={toggleWindowExpand}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Square className="size-3.5" />
                </Button>
                <Button
                  aria-label="Close window"
                  className="h-full w-12 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-(--button-close-hover) hover:text-primary-fill-foreground"
                  disabled={!windowControlsState.isClosable}
                  onClick={closeWindow}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>

          <nav
            aria-label="Live Assistant sections"
            className="col-span-2 col-start-1 row-start-2 flex min-w-0 items-center overflow-x-auto px-2 lg:absolute lg:inset-x-0 lg:top-10 lg:z-10 lg:h-16 lg:justify-center lg:overflow-visible lg:px-52"
            style={noDragRegionStyle}
          >
            <div className="inline-flex min-w-max items-center gap-1 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-panel) p-1 lg:max-w-full lg:min-w-0">
              <span className="shrink-0 px-2 text-[0.68rem] font-semibold uppercase tracking-(--tracking-badge) text-foreground lg:hidden">
                Live Assistant
              </span>
              <Link
                aria-label="Open Job Finder"
                className="shrink-0 rounded-(--radius-button) border border-border px-3 py-2 text-[0.68rem] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
                to={jobFinderReturnRoute}
              >
                Job Finder
              </Link>
              <span
                aria-hidden="true"
                className="mx-1 h-4 w-px shrink-0 bg-border/50 lg:hidden"
              />
              {activeTabDefinitions.map((tab) => (
                <button
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-(--radius-button) px-3 py-2 text-[0.72rem] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:gap-2 sm:px-3.5 sm:text-[0.76rem] xl:px-4 xl:text-(length:--text-small)",
                    activeTab === tab.id &&
                      "bg-accent font-semibold text-accent-foreground ring-1 ring-inset ring-(--surface-panel-border-active)",
                  )}
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  type="button"
                >
                  {tab.id === "settings" ? (
                    <Settings2 className="size-4" />
                  ) : null}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
          </nav>
        </div>
      </header>

      <p aria-live="polite" className="sr-only" role="status">
        {interviewModeLabel}
      </p>

      <main className="screen-scroll-area mt-[6.75rem] h-[calc(100vh-6.75rem)] scroll-pt-8 overflow-y-auto px-4 pb-8 pt-4 sm:px-6">
        <div className="mx-auto grid max-w-[118rem] gap-4">
          {activeTab !== "assist" ? (
            <section
              className="relative border-b border-(--surface-panel-border) px-1 py-2"
              id="setup"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                <h1 className="text-[1.75rem] leading-none font-semibold tracking-[-0.04em]">
                  Interview conversation
                </h1>
                <p className="min-w-64 flex-1 text-[0.8rem] leading-5 text-muted-foreground">
                  Prepare, test audio, and keep live assistance visible.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill
                      label={interviewModeLabel}
                      tone={isLiveSession ? "success" : "info"}
                    />
                    <StatusPill
                      label={
                        readinessBlocked ? "Needs attention" : "Ready path"
                      }
                      tone={readinessBlocked ? "warning" : "success"}
                    />
                    <span className="text-[0.72rem] uppercase tracking-(--tracking-badge) text-muted-foreground">
                      {targetLabel}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {activeTab === "setup" ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
              <Panel title="Start interview">
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
                  <div className="grid gap-5">
                    <div className="grid gap-2">
                      <p className="text-[1.25rem] font-semibold text-foreground">
                        {setupPrimaryStage}
                      </p>
                      <p className="max-w-2xl text-[0.9rem] leading-6 text-muted-foreground">
                        {setupPrimaryAction.detail}
                      </p>
                    </div>
                    <Button
                      onClick={() => {
                        void runSetupPrimaryAction();
                      }}
                      disabled={isLiveSession}
                      pending={pendingAction === setupPrimaryAction.id}
                      size="default"
                    >
                      <Play className="size-4" />
                      {setupPrimaryAction.label}
                    </Button>
                    <div className="grid border-y border-border-subtle sm:grid-cols-3">
                      {[
                        {
                          key: "microphoneCapture" as const,
                          label: "Microphone",
                          detail:
                            "Optional — enable when you are ready to test your mic.",
                        },
                        {
                          key: "meetingAudioCapture" as const,
                          label: "System audio",
                          detail:
                            "Listen to the interview, call, podcast, or video playing on this computer.",
                        },
                        {
                          key: "screenshotCapture" as const,
                          label: "Screenshots",
                          detail:
                            "Allow explicit screen captures as temporary answer context.",
                        },
                      ].map((option) => (
                        <label
                          className="flex items-start gap-3 p-3 text-[0.82rem] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border-subtle sm:[&:not(:last-child)]:border-r sm:[&:not(:last-child)]:border-b-0"
                          key={option.key}
                        >
                          <input
                            aria-label={`Enable ${option.label.toLowerCase()}`}
                            checked={workspace.setup.consent[option.key]}
                            className="mt-1 size-4 accent-(--info-text)"
                            disabled={Boolean(pendingAction)}
                            onChange={(event) => {
                              saveSetupPreference({
                                consent: {
                                  ...workspace.setup.consent,
                                  [option.key]: event.target.checked,
                                },
                              });
                            }}
                            type="checkbox"
                          />
                          <span className="grid gap-1">
                            <span className="font-semibold text-foreground">
                              {option.label}
                            </span>
                            <span className="text-[0.72rem] leading-5 text-muted-foreground">
                              {option.detail}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="grid border-t border-border-subtle text-[0.84rem] text-muted-foreground sm:grid-cols-3">
                      <div className="p-3 sm:border-r sm:border-border-subtle">
                        <CheckCircle2 className="mb-2 size-4 text-(--success-text)" />
                        <p className="font-semibold text-foreground">
                          1. Accept notices
                        </p>
                        <p className="mt-1 leading-5">
                          One click accepts the required capture and privacy
                          notices.
                        </p>
                      </div>
                      <div className="border-t border-border-subtle p-3 sm:border-t-0 sm:border-r">
                        <Shield className="mb-2 size-4 text-(--info-text)" />
                        <p className="font-semibold text-foreground">
                          2. Quick check
                        </p>
                        <p className="mt-1 leading-5">
                          We check the audio, transcription, screenshot, and
                          response paths before the interview.
                        </p>
                      </div>
                      <div className="border-t border-border-subtle p-3 sm:border-t-0">
                        <Sparkles className="mb-2 size-4 text-(--warning-text)" />
                        <p className="font-semibold text-foreground">
                          3. Start
                        </p>
                        <p className="mt-1 leading-5">
                          The visible chat opens with audio controls and a live
                          transcript beside it.
                        </p>
                      </div>
                    </div>
                  </div>
                  <aside className="grid gap-3 rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-4">
                    <div className="grid gap-1">
                      <span className="text-[10px] uppercase tracking-(--tracking-badge) text-muted-foreground">
                        Interview target
                      </span>
                      <p className="text-[0.92rem] font-semibold text-foreground">
                        {targetLabel}
                      </p>
                    </div>
                    <div className="grid gap-2 border-t border-border-subtle pt-3 text-[0.8rem] text-muted-foreground">
                      <p>
                        Language:{" "}
                        <span className="text-foreground">
                          {workspace.setup.transcriptionLanguage}
                        </span>
                      </p>
                      <p>
                        Cues:{" "}
                        <span className="text-foreground">
                          {workspace.setup.cueSensitivity.replaceAll("_", " ")}
                        </span>
                      </p>
                    </div>
                    <button
                      className="text-left text-[0.78rem] font-semibold text-(--info-text) hover:text-foreground"
                      onClick={() => setActiveTab("settings")}
                      type="button"
                    >
                      Change settings
                    </button>
                  </aside>
                </div>
              </Panel>
              <Panel title="Test audio before starting">
                <InterviewMediaStreamProbes
                  meetingAudioCaptureAllowed={
                    workspace.setup.consent.meetingAudioCapture
                  }
                  microphoneCaptureAllowed={
                    workspace.setup.consent.microphoneCapture
                  }
                  language={workspace.setup.transcriptionLanguage}
                  listening
                  audioTranscriptionAvailable={audioTranscriptionAvailable}
                />
              </Panel>
              <aside className="grid content-start gap-4">
                <Panel title="Need to know">
                  <div className="grid gap-3 text-[0.84rem] leading-5 text-muted-foreground">
                    <p>
                      Visible answer and transcript popups open with each live
                      session. The main conversation remains the control
                      surface; hidden mode, global shortcuts, and panic-hide
                      controls are deferred.
                    </p>
                    <div className="rounded-(--radius-small) border border-(--info-border) bg-(--info-surface) p-3 text-(--info-text)">
                      You can pause either audio source at any time and remove
                      an attached image before sending it.
                    </div>
                  </div>
                </Panel>
              </aside>
            </div>
          ) : null}

          {activeTab === "assist" ? (
            <InterviewVisibleChat
              audioTranscriptionAvailable={audioTranscriptionAvailable}
              onGoToReview={() => setActiveTab("review")}
              onGoToSetup={() => setActiveTab("setup")}
              onPerform={perform}
              onWorkspaceChange={applyWorkspaceSnapshot}
              pendingAction={pendingAction}
              workspace={workspace}
            />
          ) : null}

          {advancedSurfaceUiEnabled &&
          activeTab === "assist" &&
          isLiveSession ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="grid gap-4">
                <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
                  <Panel id="session" index={4} title="Session">
                    <div className="grid gap-4">
                      <div className="rounded-(--radius-small) border border-(--success-border) bg-(--success-surface) p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="grid gap-2">
                            <p className="font-mono text-[1.55rem]">
                              {activeSession
                                ? new Date(
                                    activeSession.startedAt,
                                  ).toLocaleTimeString()
                                : "00:00:00"}
                            </p>
                            <StatusPill
                              label={
                                activeSession?.listening
                                  ? "Listening"
                                  : "Paused"
                              }
                              tone={
                                activeSession?.listening ? "success" : "warning"
                              }
                            />
                            <p className="text-[0.78rem] text-muted-foreground">
                              {activeSession
                                ? activeSession.status.replaceAll("_", " ")
                                : "Session inactive"}
                            </p>
                          </div>
                          <div className="grid min-w-36 gap-2">
                            <Button
                              onClick={() => {
                                void perform("toggle_listening");
                              }}
                              pending={pendingAction === "toggle_listening"}
                              size="compact"
                              variant="secondary"
                            >
                              <Pause className="size-4" />
                              {activeSession?.listening ? "Pause" : "Resume"}
                            </Button>
                            <Button
                              onClick={() => {
                                void perform("end_session");
                              }}
                              pending={pendingAction === "end_session"}
                              size="compact"
                              variant="outline"
                            >
                              End session
                            </Button>
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Button
                          disabled={!workspace.setup.consent.screenshotCapture}
                          onClick={() => {
                            void perform("force_cue");
                          }}
                          pending={pendingAction === "force_cue"}
                          size="compact"
                          variant="secondary"
                        >
                          <Sparkles className="size-4" />
                          Generate cue now
                        </Button>
                        <Button
                          onClick={() => {
                            void perform("capture_screenshot");
                          }}
                          pending={pendingAction === "capture_screenshot"}
                          size="compact"
                          variant="secondary"
                        >
                          <Camera className="size-4" />
                          Screenshot
                        </Button>
                      </div>
                      <div className="grid gap-2 border-t border-border-subtle pt-3">
                        <p className="text-[0.72rem] font-semibold uppercase tracking-(--tracking-badge) text-muted-foreground">
                          Safety and overlays
                        </p>
                        <Button
                          onClick={() => {
                            void perform("panic_hide");
                          }}
                          pending={pendingAction === "panic_hide"}
                          size="compact"
                          variant="destructive"
                        >
                          <PanelTop className="size-4" />
                          Hide popups now
                        </Button>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Button
                            onClick={() => {
                              void perform("toggle_overlay_interaction_mode");
                            }}
                            pending={
                              pendingAction ===
                              "toggle_overlay_interaction_mode"
                            }
                            size="compact"
                            variant={
                              overlayInteractionEnabled
                                ? "primary"
                                : "secondary"
                            }
                          >
                            <Settings2 className="size-4" />
                            {overlayInteractionEnabled ? "Finish move" : "Move"}
                          </Button>
                          <Button
                            onClick={() => {
                              void verifyOverlayProtection();
                            }}
                            pending={
                              pendingAction === "verify_overlay_protection"
                            }
                            size="compact"
                            variant="secondary"
                          >
                            <Shield className="size-4" />
                            Verify
                          </Button>
                          <Button
                            onClick={() => {
                              void toggleReconfiguration();
                            }}
                            pending={
                              pendingAction === "begin_reconfiguration" ||
                              pendingAction === "finish_reconfiguration"
                            }
                            size="compact"
                            variant="secondary"
                          >
                            <Settings2 className="size-4" />
                            {activeSession?.status === "reconfiguring"
                              ? "Close config"
                              : "Reconfigure"}
                          </Button>
                          <Button
                            onClick={() => {
                              setDiagnosticsOpen((current) => !current);
                            }}
                            size="compact"
                            variant="secondary"
                          >
                            <ListChecks className="size-4" />
                            Diagnostics
                          </Button>
                        </div>
                      </div>
                      {activeSession?.status === "reconfiguring" ? (
                        <div className="rounded-(--radius-small) border border-(--info-border) bg-(--info-surface) p-3 text-[0.78rem] leading-5 text-(--info-text)">
                          Listening is paused while setup preferences and
                          rehearsal checks are adjusted.
                        </div>
                      ) : null}
                    </div>
                  </Panel>

                  <Panel index={5} title="Audio and questions">
                    {activeSession ? (
                      <div className="grid gap-3">
                        <InterviewMediaStreamProbes
                          meetingAudioCaptureAllowed={
                            workspace.setup.consent.meetingAudioCapture
                          }
                          microphoneCaptureAllowed={
                            workspace.setup.consent.microphoneCapture
                          }
                          language={workspace.setup.transcriptionLanguage}
                          listening={activeSession.listening}
                          onWorkspaceChange={applyWorkspaceSnapshot}
                          sessionId={activeSession.id}
                          audioTranscriptionAvailable={
                            audioTranscriptionAvailable
                          }
                        />
                        <div className="grid gap-2 rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3">
                          <p className="text-[0.82rem]">Send a question</p>
                          <textarea
                            className="min-h-24 resize-y rounded-(--radius-small) border border-border-subtle bg-(--field) p-3 text-[0.82rem] leading-5 text-foreground outline-none focus:border-(--info-border)"
                            onChange={(event) => {
                              setTranscriptDraft(event.target.value);
                            }}
                            placeholder="Paste or type the interviewer question here."
                            value={transcriptDraft}
                          />
                          <div className="grid gap-2 sm:grid-cols-[0.62fr_1fr]">
                            <select
                              className="h-9 rounded-(--radius-small) border border-border-subtle bg-(--field) px-2 text-[0.78rem] text-foreground"
                              onChange={(event) => {
                                setTranscriptSource(
                                  event.target
                                    .value as InterviewTranscriptSource,
                                );
                              }}
                              value={transcriptSource}
                            >
                              <option value="typed_question">
                                Interviewer question
                              </option>
                              <option value="meeting_audio">
                                Meeting audio
                              </option>
                              <option value="microphone">My answer</option>
                            </select>
                            <Button
                              disabled={transcriptDraft.trim().length === 0}
                              onClick={() => {
                                void submitTranscriptSegment();
                              }}
                              pending={
                                pendingAction === "add_transcript_segment"
                              }
                              size="compact"
                              variant="secondary"
                            >
                              <Radio className="size-4" />
                              Send question
                            </Button>
                          </div>
                        </div>
                        <div className="grid gap-2 rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3">
                          <p className="text-[0.82rem]">
                            Other transcript sources
                          </p>
                          <InterviewNativeCaptionWatcher
                            language={workspace.setup.transcriptionLanguage}
                            listening={activeSession.listening}
                            onWorkspaceChange={applyWorkspaceSnapshot}
                            sessionId={activeSession.id}
                          />
                          <InterviewCaptionFileWatcher
                            language={workspace.setup.transcriptionLanguage}
                            listening={activeSession.listening}
                            onWorkspaceChange={applyWorkspaceSnapshot}
                            sessionId={activeSession.id}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3 text-[0.82rem] text-muted-foreground">
                        Start the interview to use audio and send questions.
                      </div>
                    )}
                  </Panel>
                </div>
              </div>

              <aside className="grid content-start gap-4">
                {isLiveSession ? (
                  <Panel title="Overlay surfaces">
                    <div className="grid gap-3">
                      {liveOverlaySummaries.map(({ label, overlay }) => (
                        <div
                          className="rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3"
                          key={label}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[0.82rem]">{label}</span>
                            <StatusPill
                              label={overlay.visible ? "Visible" : "Hidden"}
                              tone={overlay.visible ? "success" : "warning"}
                            />
                          </div>
                          <p className="mt-2 text-[0.74rem] leading-5 text-muted-foreground">
                            {overlay.protectionState.replaceAll("_", " ")}
                          </p>
                          <Button
                            className="mt-3 w-full"
                            onClick={() => {
                              void setOverlayVisibility(
                                overlay,
                                !overlay.visible,
                              );
                            }}
                            pending={
                              pendingAction ===
                              `set_${overlay.surfaceKind}_${String(!overlay.visible)}`
                            }
                            size="compact"
                            variant="secondary"
                          >
                            {overlay.visible ? "Hide popup" : "Show popup"}
                          </Button>
                        </div>
                      ))}
                      <Button
                        onClick={() => {
                          void resetOverlayLayout();
                        }}
                        pending={pendingAction === "reset_overlay_layout"}
                        size="compact"
                        variant="secondary"
                      >
                        <RotateCcw className="size-4" />
                        Reset overlay layout
                      </Button>
                    </div>
                  </Panel>
                ) : (
                  <>
                    <AnswerCueOverlay
                      framed
                      snapshot={workspace.answerOverlay}
                    />
                    <TranscriptOverlay
                      framed
                      snapshot={workspace.transcriptOverlay}
                    />
                  </>
                )}
                <Panel title="Session summary">
                  <div className="grid gap-3 text-[0.82rem] text-muted-foreground">
                    <p>
                      {isLiveSession
                        ? "Use the answer and transcript popups during the call. Drag either popup by its header to place it where you want; the app restores that layout next time."
                        : "Start a session to use the assist controls."}
                    </p>
                    <div className="flex items-center gap-2">
                      <Clock className="size-4" />
                      <span>
                        {isLiveSession
                          ? `${activeSession?.transcriptSegments.length ?? 0} transcript segments`
                          : `${workspace.recentSessions.length} retained sessions`}
                      </span>
                    </div>
                  </div>
                </Panel>
                {diagnosticsOpen ? (
                  <Panel title="Diagnostics">
                    <InterviewDiagnosticsPanel
                      diagnostics={
                        activeSession?.diagnostics ??
                        reviewSession?.diagnostics ??
                        []
                      }
                    />
                  </Panel>
                ) : null}
              </aside>
            </div>
          ) : null}

          {activeTab === "review" ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="grid gap-4">
                <Panel id="review" title="Post-session review">
                  {isLiveSession ? (
                    <div className="rounded-(--radius-small) border border-(--info-border) bg-(--info-surface) p-4">
                      <p className="text-[0.88rem] text-(--info-text)">
                        Review opens after the live session ends.
                      </p>
                      <p className="mt-2 text-[0.78rem] leading-5 text-muted-foreground">
                        The main window keeps live cue-card and transcript text
                        out of this surface while capture is active.
                      </p>
                    </div>
                  ) : reviewLoadError ? (
                    <p role="alert">{reviewLoadError}</p>
                  ) : latestArchive && !reviewSession ? (
                    <p>Loading retained session...</p>
                  ) : !reviewSession ? (
                    <div className="grid min-h-[12rem] place-items-center rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-5 text-center">
                      <div className="grid max-w-md gap-2.5">
                        <Archive className="mx-auto size-6 text-muted-foreground" />
                        <div className="grid gap-1.5">
                          <h3 className="text-[0.95rem] font-semibold text-foreground">
                            No saved interview session yet
                          </h3>
                          <p className="text-[0.82rem] leading-5 text-muted-foreground">
                            Start and end a session before exporting notes,
                            saving prep, or deleting retained interview data.
                          </p>
                        </div>
                        <Button
                          onClick={() => setActiveTab("setup")}
                          size="compact"
                          variant="secondary"
                        >
                          <ListChecks className="size-4" />
                          Go to setup
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-4 lg:grid-cols-[1fr_0.8fr_0.7fr]">
                      <div className="grid gap-2">
                        <h3 className="text-[0.78rem] uppercase tracking-(--tracking-badge) text-muted-foreground">
                          Transcript
                        </h3>
                        <div
                          aria-label="Retained transcript"
                          role="region"
                          className="max-h-64 overflow-y-auto rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3"
                        >
                          {pagedTranscriptSegments.map((segment) => (
                            <p
                              className="mb-2 text-[0.82rem] leading-5 text-foreground-soft"
                              key={segment.id}
                            >
                              <span className="text-(--warning-text)">
                                {formatInterviewTranscriptSource(
                                  segment.source,
                                )}
                              </span>{" "}
                              {segment.text}
                            </p>
                          ))}
                        </div>
                        {transcriptPageCount > 1 ? (
                          <nav
                            aria-label="Transcript pagination"
                            aria-busy={isTranscriptPagePending}
                            className="flex flex-wrap items-center justify-between gap-2 text-[0.76rem] text-muted-foreground"
                          >
                            <p aria-live="polite">
                              {isTranscriptPagePending ? (
                                <span className="inline-flex items-center gap-1">
                                  <LoaderCircle
                                    aria-hidden="true"
                                    className="size-3 motion-safe:animate-spin"
                                  />
                                  Loading transcript…
                                </span>
                              ) : (
                                `${transcriptStartIndex + 1}–${Math.min(transcriptStartIndex + transcriptPageSize, transcriptSegments.length)} of ${transcriptSegments.length} transcript segments`
                              )}
                            </p>
                            <div className="flex items-center gap-1">
                              <Button
                                aria-label="Previous transcript page"
                                disabled={
                                  isTranscriptPagePending ||
                                  currentTranscriptPage === 1
                                }
                                onClick={() =>
                                  changeTranscriptPage(
                                    currentTranscriptPage - 1,
                                    "previous",
                                  )
                                }
                                ref={transcriptPreviousRef}
                                size="xs"
                                type="button"
                                variant="ghost"
                              >
                                Previous
                              </Button>
                              <span aria-current="page">
                                Page {currentTranscriptPage} of{" "}
                                {transcriptPageCount}
                              </span>
                              <Button
                                aria-label="Next transcript page"
                                disabled={
                                  isTranscriptPagePending ||
                                  currentTranscriptPage === transcriptPageCount
                                }
                                onClick={() =>
                                  changeTranscriptPage(
                                    currentTranscriptPage + 1,
                                    "next",
                                  )
                                }
                                ref={transcriptNextRef}
                                size="xs"
                                type="button"
                                variant="ghost"
                              >
                                Next
                              </Button>
                            </div>
                          </nav>
                        ) : null}
                      </div>
                      <div className="grid gap-2">
                        <h3 className="text-[0.78rem] uppercase tracking-(--tracking-badge) text-muted-foreground">
                          Latest cue
                        </h3>
                        <div className="rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3">
                          <p className="text-[0.86rem]">
                            {latestCue?.question ?? "No cue generated."}
                          </p>
                          <p className="mt-2 text-[0.76rem] text-muted-foreground">
                            {formatRetainedCueCardCount(
                              reviewSession?.cueCards.length ?? 0,
                            )}
                          </p>
                        </div>
                        {reviewSession ? (
                          <TranscriptAnnotationPanel
                            onWorkspaceChange={applyWorkspaceSnapshot}
                            session={reviewSession}
                          />
                        ) : null}
                      </div>
                      <div className="grid content-start gap-2">
                        <Button
                          className={reviewDisabledButtonClass}
                          disabled={!latestCue || !reviewSession}
                          onClick={() => {
                            if (latestCue && reviewSession) {
                              void updateWorkspace("prep", () =>
                                window.nordri.liveAssistant.saveCueAsPrepArtifact(
                                  {
                                    sessionId: reviewSession.id,
                                    cueCardId: latestCue.id,
                                  },
                                ),
                              );
                            }
                          }}
                          pending={pendingAction === "prep"}
                          size="compact"
                          variant="secondary"
                        >
                          <Archive className="size-4" />
                          Save prep
                        </Button>
                        <Button
                          className={reviewDisabledButtonClass}
                          disabled={!canExport}
                          onClick={() => {
                            void exportLatest("markdown");
                          }}
                          pending={pendingAction === "export_markdown"}
                          size="compact"
                          variant="secondary"
                        >
                          <FileDown className="size-4" />
                          Export notes
                        </Button>
                        {reviewSession?.targetContext.kind ===
                        "job_application" ? (
                          <div className="grid gap-2 border-t border-border-subtle pt-2">
                            <Button
                              className={reviewDisabledButtonClass}
                              disabled={!reviewSession}
                              onClick={() => {
                                void recordJobFinderFollowUp(
                                  "mark_interviewed",
                                );
                              }}
                              pending={pendingAction === "mark_interviewed"}
                              size="compact"
                              variant="secondary"
                            >
                              <CheckCircle2 className="size-4" />
                              Mark interviewed
                            </Button>
                            <textarea
                              className="min-h-20 resize-none rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-2 text-[0.8rem] text-foreground outline-none transition focus:border-primary"
                              onChange={(event) => {
                                setFollowUpDraft(event.target.value);
                              }}
                              placeholder="Follow-up note"
                              value={followUpDraft}
                            />
                            <Button
                              className={reviewDisabledButtonClass}
                              disabled={
                                !reviewSession ||
                                followUpDraft.trim().length === 0
                              }
                              onClick={() => {
                                void recordJobFinderFollowUp(
                                  "add_follow_up_note",
                                );
                              }}
                              pending={pendingAction === "add_follow_up_note"}
                              size="compact"
                              variant="secondary"
                            >
                              <Send className="size-4" />
                              Add follow-up
                            </Button>
                            {jobFinderWriteBackStatus ? (
                              <p className="text-[0.72rem] leading-5 text-muted-foreground">
                                {jobFinderWriteBackStatus}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                        <Button
                          className={reviewDisabledDangerButtonClass}
                          disabled={!reviewSession}
                          onClick={() => {
                            setDeleteSessionError(null);
                            setDeleteConfirmationOpen(true);
                          }}
                          pending={pendingAction === "delete"}
                          size="compact"
                          variant="destructive"
                        >
                          <Trash2 className="size-4" />
                          Delete session
                        </Button>
                      </div>
                    </div>
                  )}
                  {state.exportResult ? (
                    <div className="mt-4 rounded-(--radius-small) border border-(--info-border) bg-(--info-surface) p-3">
                      <p className="text-[0.78rem] text-(--info-text)">
                        {state.exportResult.fileName}
                      </p>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[0.72rem] text-muted-foreground">
                        {state.exportResult.content}
                      </pre>
                    </div>
                  ) : null}
                </Panel>
              </div>

              <aside className="grid content-start gap-4">
                {advancedSurfaceUiEnabled ? (
                  <>
                    {isLiveSession ? (
                      <Panel title="Overlay surfaces">
                        <div className="grid gap-3">
                          {liveOverlaySummaries.map(({ label, overlay }) => (
                            <div
                              className="rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3"
                              key={label}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[0.82rem]">{label}</span>
                                <StatusPill
                                  label={
                                    overlay.visible
                                      ? "Overlay window"
                                      : "Hidden"
                                  }
                                  tone={overlay.visible ? "success" : "warning"}
                                />
                              </div>
                              <p className="mt-2 text-[0.74rem] leading-5 text-muted-foreground">
                                {overlay.protectionState.replaceAll("_", " ")}
                              </p>
                            </div>
                          ))}
                        </div>
                      </Panel>
                    ) : (
                      <>
                        <AnswerCueOverlay
                          framed
                          snapshot={workspace.answerOverlay}
                        />
                        <TranscriptOverlay
                          framed
                          snapshot={workspace.transcriptOverlay}
                        />
                      </>
                    )}
                    <Panel title="Hotkeys and tray">
                      <div className="grid gap-2">
                        {[
                          ["Alt + H", "Hide popups now"],
                          ["Alt + Q", "Generate cue now"],
                          ["Alt + S", "Screenshot"],
                          ["Alt + T", "Transcript overlay"],
                        ].map(([keys, label]) => (
                          <div
                            className="flex items-center justify-between border-b border-border-subtle py-2 last:border-0"
                            key={keys}
                          >
                            <span className="text-[0.82rem]">{label}</span>
                            <kbd className="rounded-sm border border-border-subtle bg-(--field) px-2 py-1 font-mono text-[0.7rem] text-muted-foreground">
                              {keys}
                            </kbd>
                          </div>
                        ))}
                        <Button
                          onClick={() => {
                            void resetOverlayLayout();
                          }}
                          pending={pendingAction === "reset_overlay_layout"}
                          size="compact"
                          variant="secondary"
                        >
                          <RotateCcw className="size-4" />
                          Reset overlay layout
                        </Button>
                      </div>
                    </Panel>
                  </>
                ) : (
                  <Panel title="Visible mode">
                    <p className="text-[0.78rem] leading-5 text-muted-foreground">
                      The answer and transcript popups stay visible during a
                      session. Hidden mode, panic-hide, tray controls, and
                      global hotkeys are disabled; coaching controls stay in the
                      main conversation window.
                    </p>
                  </Panel>
                )}
                <Panel title="Session summary">
                  <div className="grid gap-3 text-[0.82rem] text-muted-foreground">
                    <p>
                      {isLiveSession
                        ? "Live summary text is kept out of the main window while capture is active."
                        : (reviewSession?.cueSummary ??
                          "No session summary yet.")}
                    </p>
                    <div className="flex items-center gap-2">
                      <Clock className="size-4" />
                      <span>
                        {isLiveSession
                          ? `${activeSession?.transcriptSegments.length ?? 0} live transcript segments`
                          : `${workspace.recentSessions.length} retained sessions`}
                      </span>
                    </div>
                  </div>
                </Panel>
                {diagnosticsOpen ? (
                  <Panel title="Diagnostics">
                    <InterviewDiagnosticsPanel
                      diagnostics={
                        activeSession?.diagnostics ??
                        reviewSession?.diagnostics ??
                        []
                      }
                    />
                  </Panel>
                ) : null}
              </aside>
            </div>
          ) : null}

          {activeTab === "settings" ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="grid gap-4">
                <Panel title="Preferences">
                  <InterviewSessionPreferences
                    onSave={saveSetupPreference}
                    pending={pendingAction === "setup_preferences"}
                    workspace={workspace}
                  />
                </Panel>
                <Panel title="Diagnostics">
                  <InterviewDiagnosticsPanel
                    diagnostics={
                      activeSession?.diagnostics ??
                      reviewSession?.diagnostics ??
                      []
                    }
                  />
                </Panel>
              </div>
              <aside className="grid content-start gap-4">
                {advancedSurfaceUiEnabled ? (
                  <>
                    <Panel title="Overlay layout">
                      <div className="grid gap-3">
                        {liveOverlaySummaries.map(({ label, overlay }) => (
                          <div
                            className="rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3"
                            key={label}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[0.82rem]">{label}</span>
                              <StatusPill
                                label={overlay.mode}
                                tone={overlay.visible ? "success" : "warning"}
                              />
                            </div>
                            <p className="mt-2 text-[0.74rem] leading-5 text-muted-foreground">
                              {overlay.protectionState.replaceAll("_", " ")}
                            </p>
                          </div>
                        ))}
                        <Button
                          onClick={() => {
                            void resetOverlayLayout();
                          }}
                          pending={pendingAction === "reset_overlay_layout"}
                          size="compact"
                          variant="secondary"
                        >
                          <RotateCcw className="size-4" />
                          Reset overlay layout
                        </Button>
                      </div>
                    </Panel>
                    <Panel title="Hotkeys">
                      <div className="grid gap-2">
                        {[
                          ["Alt + H", "Hide popups now"],
                          ["Alt + Q", "Generate cue now"],
                          ["Alt + S", "Screenshot"],
                          ["Alt + T", "Transcript overlay"],
                        ].map(([keys, label]) => (
                          <div
                            className="flex items-center justify-between border-b border-border-subtle py-2 last:border-0"
                            key={keys}
                          >
                            <span className="text-[0.82rem]">{label}</span>
                            <kbd className="rounded-sm border border-border-subtle bg-(--field) px-2 py-1 font-mono text-[0.7rem] text-muted-foreground">
                              {keys}
                            </kbd>
                          </div>
                        ))}
                      </div>
                    </Panel>
                  </>
                ) : (
                  <Panel title="Popup windows">
                    <div className="grid gap-3">
                      <p className="text-[0.78rem] leading-5 text-muted-foreground">
                        Answer and transcript popups open with every live
                        interview. Move and resize them like ordinary windows.
                      </p>
                      {liveOverlaySummaries.map(({ label, overlay }) => (
                        <div
                          className="rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-subtle) p-3"
                          key={label}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-[0.82rem]">{label}</p>
                              <p className="mt-1 text-[0.7rem] text-muted-foreground">
                                {overlay.visible
                                  ? "Open now"
                                  : "Currently hidden"}
                              </p>
                            </div>
                            <Button
                              onClick={() => {
                                void setOverlayVisibility(
                                  overlay,
                                  !overlay.visible,
                                );
                              }}
                              pending={
                                pendingAction ===
                                `set_${overlay.surfaceKind}_${String(!overlay.visible)}`
                              }
                              size="compact"
                              variant="secondary"
                            >
                              {overlay.visible ? "Hide" : "Show"}
                            </Button>
                          </div>
                        </div>
                      ))}
                      <Button
                        onClick={() => {
                          void resetOverlayLayout();
                        }}
                        pending={pendingAction === "reset_overlay_layout"}
                        size="compact"
                        variant="secondary"
                      >
                        <RotateCcw className="size-4" />
                        Reset saved positions
                      </Button>
                    </div>
                  </Panel>
                )}
              </aside>
            </div>
          ) : null}
        </div>
      </main>
      <InterviewDeleteSessionDialog
        error={deleteSessionError}
        onCancel={closeDeleteConfirmation}
        onConfirm={() => {
          if (!reviewSession) return;

          setDeleteSessionError(null);
          void updateWorkspace("delete", () =>
            window.nordri.liveAssistant.deleteSession(reviewSession.id),
          )
            .then(() => {
              setDeleteConfirmationOpen(false);
            })
            .catch(() => {
              setDeleteSessionError(
                "Could not delete this session. Nothing was removed. Try again.",
              );
            });
        }}
        open={deleteConfirmationOpen && Boolean(reviewSession)}
        pending={pendingAction === "delete"}
      />
    </div>
  );
}

function useInterviewPopupWorkspace() {
  const [workspace, setWorkspace] = useState<InterviewWorkspaceView | null>(
    null,
  );

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.nordri.liveAssistant.onWorkspaceChange(
      (nextWorkspace) => {
        if (mounted) setWorkspace(nextWorkspace);
      },
    );

    void window.nordri.liveAssistant.getWorkspace().then((nextWorkspace) => {
      if (mounted) setWorkspace(nextWorkspace);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return [workspace, setWorkspace] as const;
}

export function InterviewAnswerOverlayRoute() {
  const [workspace, setWorkspace] = useInterviewPopupWorkspace();

  return workspace ? (
    <InterviewAnswerPopup
      onWorkspaceChange={setWorkspace}
      workspace={workspace}
    />
  ) : null;
}

export function InterviewTranscriptOverlayRoute() {
  const [workspace, setWorkspace] = useInterviewPopupWorkspace();
  const [copyLabel, setCopyLabel] = useState("Copy transcript");

  async function copyTranscript() {
    if (!workspace) return;
    const segments = workspace.activeSession?.transcriptSegments ?? [];
    const text = segments.map((segment) => segment.text).join("\n");
    if (!text) return;
    await window.nordri.liveAssistant.writeClipboardText({ text });
    setCopyLabel("Copied");
    window.setTimeout(() => setCopyLabel("Copy transcript"), 1_500);
  }

  async function hideTranscript() {
    setWorkspace(
      await window.nordri.liveAssistant.updateOverlayPreference({
        surfaceKind: "live_transcript_overlay",
        visible: false,
      }),
    );
  }

  return workspace ? (
    <TranscriptOverlay
      copyLabel={copyLabel}
      onCopy={() => void copyTranscript()}
      onHide={() => void hideTranscript()}
      snapshot={workspace.transcriptOverlay}
    />
  ) : null;
}
