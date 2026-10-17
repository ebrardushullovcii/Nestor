import type {
  InterviewCapabilityCheck,
  InterviewAudioTranscriptionInput,
  InterviewChatTurn,
  InterviewCueCard,
  InterviewCueInputDisclosure,
  InterviewCueVisualBatch,
  InterviewDiagnosticEvent,
  InterviewExportResult,
  InterviewHotkeyAction,
  InterviewLiveSession,
  InterviewOverlayPreference,
  InterviewOverlaySnapshot,
  InterviewProtectedSurface,
  InterviewProtectedSurfaceVerificationInput,
  InterviewProtectedSurfaceKind,
  InterviewRehearsalChecklist,
  InterviewSessionActionInput,
  InterviewSetupState,
  InterviewTargetContext,
  InterviewTranscriptAnnotation,
  InterviewTranscriptAnnotationInput,
  InterviewTranscriptSegmentInput,
  InterviewTranscriptionEngine,
  InterviewTranscriptSegment,
  InterviewVisualObservation,
  InterviewWorkspaceView,
  InterviewWorkspaceSnapshot,
  InterviewSessionSummary,
  SaveInterviewSetupInput,
  SendInterviewChatMessageInput,
  UpdateInterviewOverlayPreferenceInput,
} from "@nordri/contracts";
import {
  InterviewCueCardSchema,
  InterviewAudioTranscriptionInputSchema,
  InterviewChatImageAttachmentSchema,
  InterviewChatConversationSchema,
  InterviewChatTurnSchema,
  InterviewExportResultSchema,
  InterviewLiveSessionSchema,
  InterviewOverlayPreferenceSchema,
  InterviewOverlaySnapshotSchema,
  InterviewPrepArtifactSchema,
  InterviewProtectedSurfaceSchema,
  InterviewProtectedSurfaceVerificationInputSchema,
  InterviewRehearsalChecklistSchema,
  InterviewSetupStateSchema,
  InterviewTargetContextSchema,
  InterviewTranscriptAnnotationSchema,
  InterviewTranscriptSegmentInputSchema,
  InterviewTranscriptSegmentSchema,
  summarizeInterviewSession,
  SendInterviewChatMessageInputSchema,
  interviewChatLimits,
} from "@nordri/contracts";
import type {
  CaptureProtectionState,
  DesktopAudioCaptureAdapter,
  DesktopScreenshotCaptureAdapter,
  OverlayWindowState,
  ProtectedOverlaySurfaceAdapter,
} from "@nordri/os-integration";

export const liveAssistantPackageReady = true;

export const liveCuePriorities = ["low", "normal", "high"] as const;
export type LiveCuePriority = (typeof liveCuePriorities)[number];

export interface LiveCue {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly priority: LiveCuePriority;
}

export interface InterviewOverlayModel {
  readonly visible: boolean;
  readonly mode: "compact" | "expanded";
  readonly cues: readonly LiveCue[];
}

export interface LiveAssistantRepository {
  load(): Promise<InterviewWorkspaceSnapshot | null>;
  save(snapshot: InterviewWorkspaceSnapshot): Promise<void>;
  loadWorkspace(): Promise<InterviewWorkspaceView | null>;
  loadSession(sessionId: string): Promise<InterviewLiveSession | null>;
  saveWorkspace(
    snapshot: InterviewWorkspaceView,
    changedArchiveSessions?: readonly InterviewLiveSession[],
  ): Promise<void>;
  close(): Promise<void>;
}

export interface InterviewCueCardProvider {
  getStatus(): {
    ready: boolean;
    label: string;
    detail: string | null;
  };
  generateCueCard(input: {
    sessionId: string;
    triggerKind:
      | "automatic_question"
      | "force_cue"
      | "capture_and_force_cue"
      | "rehearsal_sample";
    question: string;
    targetLabel: string;
    targetContextKind: InterviewCueInputDisclosure["targetContextKind"];
    transcriptSegments: readonly InterviewTranscriptSegment[];
    visualObservations: readonly InterviewVisualObservation[];
    disclosure: InterviewCueInputDisclosure;
    createdAt: string;
  }): Promise<InterviewCueCard>;
}

export interface InterviewScreenshotVisionProvider {
  getStatus(): {
    ready: boolean;
    label: string;
    detail: string | null;
  };
  describeScreenshotBatch(input: {
    batchId: string;
    screenshotCount: number;
    overlayContaminated: boolean;
    images?: ReadonlyArray<{
      readonly mimeType: string;
      readonly base64: string;
    }>;
    createdAt: string;
  }): Promise<readonly InterviewVisualObservation[]>;
}

export interface InterviewSummaryProvider {
  summarize(input: {
    previousSummary: string;
    transcriptSegments: readonly InterviewTranscriptSegment[];
    cueCards: readonly InterviewCueCard[];
  }): Promise<string>;
}

export interface InterviewTranscriptionProvider {
  getEngines(): {
    microphone: InterviewTranscriptionEngine;
    meetingAudio: InterviewTranscriptionEngine;
  };
  transcribeAudioChunk?(input: InterviewAudioTranscriptionInput): Promise<{
    readonly text: string;
    readonly confidence: number | null;
    readonly language: string;
    readonly engineKind: InterviewTranscriptSegment["engineKind"];
  } | null>;
  createSampleSegments(input: {
    sessionId: string;
    createdAt: string;
    language: string;
  }): readonly InterviewTranscriptSegment[];
}

type InterviewAudioTranscriptionResult = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<InterviewTranscriptionProvider["transcribeAudioChunk"]>
    >
  >
>;

type InterviewAudioProviderOutcome =
  | { status: "transcribed"; result: InterviewAudioTranscriptionResult }
  | { status: "empty" }
  | { status: "unavailable" }
  | { status: "failed"; detail: string };

const NON_SPEECH_TRANSCRIPT_PATTERN =
  /^\s*(?:>{1,2}\s*)?[[(<]?\s*(?:blank[_\s-]*audio|silence|music|inaudible|no[_\s-]*speech|background[_\s-]*noise)\s*[\])>]?\s*[.!]?\s*$/iu;
const SHORT_NON_SPEECH_ANNOTATION_PATTERN =
  /^\s*(?:>{1,2}\s*)?[[(<][^\])>]{1,48}[\])>]\s*[.!]?\s*$/u;

function containsUsableSpeech(text: string) {
  const normalized = text.trim();
  if (
    normalized.length === 0 ||
    NON_SPEECH_TRANSCRIPT_PATTERN.test(normalized)
  ) {
    return false;
  }

  if (!SHORT_NON_SPEECH_ANNOTATION_PATTERN.test(normalized)) {
    return true;
  }

  return normalized.split(/\s+/u).length > 4;
}

export interface LiveAssistantService {
  getWorkspace(): Promise<InterviewWorkspaceView>;
  getSession(sessionId: string): Promise<InterviewLiveSession | null>;
  saveSetup(input: SaveInterviewSetupInput): Promise<InterviewWorkspaceView>;
  updateOverlayPreference(
    input: UpdateInterviewOverlayPreferenceInput,
  ): Promise<InterviewWorkspaceView>;
  resetOverlayPreferences(): Promise<InterviewWorkspaceView>;
  runRehearsal(): Promise<InterviewWorkspaceView>;
  startSession(): Promise<InterviewWorkspaceView>;
  beginSessionReconfiguration(): Promise<InterviewWorkspaceView>;
  finishSessionReconfiguration(): Promise<InterviewWorkspaceView>;
  performAction(
    input: InterviewSessionActionInput,
  ): Promise<InterviewWorkspaceView>;
  deleteSession(sessionId: string): Promise<InterviewWorkspaceView>;
  saveCueAsPrepArtifact(input: {
    sessionId: string;
    cueCardId: string;
  }): Promise<InterviewWorkspaceView>;
  addTranscriptAnnotation(
    input: InterviewTranscriptAnnotationInput,
  ): Promise<InterviewWorkspaceView>;
  addTranscriptSegment(
    input: InterviewTranscriptSegmentInput,
  ): Promise<InterviewWorkspaceView>;
  sendChatMessage(
    input: SendInterviewChatMessageInput,
  ): Promise<InterviewChatTurn>;
  recordProtectedSurfaceVerification(
    input: InterviewProtectedSurfaceVerificationInput,
  ): Promise<InterviewWorkspaceView>;
  recordDisplayChange(input: {
    reason:
      | "display_added"
      | "display_removed"
      | "display_metrics_changed"
      | "manual_revalidation";
    detail?: string | null;
  }): Promise<InterviewWorkspaceView>;
  transcribeAudioChunk(
    input: InterviewAudioTranscriptionInput,
  ): Promise<InterviewWorkspaceView>;
  exportSession(input: {
    sessionId: string;
    format: "markdown" | "json";
  }): Promise<InterviewExportResult>;
  close(): Promise<void>;
}

export interface LiveAssistantServiceOptions {
  repository: LiveAssistantRepository;
  audioCaptureAdapter: DesktopAudioCaptureAdapter;
  screenshotCaptureAdapter: DesktopScreenshotCaptureAdapter;
  protectedSurfaceAdapter: ProtectedOverlaySurfaceAdapter;
  cueCardProvider: InterviewCueCardProvider;
  screenshotVisionProvider: InterviewScreenshotVisionProvider;
  transcriptionProvider: InterviewTranscriptionProvider;
  summaryProvider: InterviewSummaryProvider;
  advancedSurfacesEnabled?: boolean;
  now?: () => string;
}

const defaultConsent = {
  microphoneCapture: false,
  meetingAudioCapture: false,
  screenshotCapture: false,
  modelTransmission: false,
  localRetention: false,
  overlayProtectionNotice: false,
  acceptedAt: null,
} as const;

const defaultOverlayPreferences: readonly InterviewOverlayPreference[] = [
  {
    surfaceKind: "live_answer_overlay",
    mode: "expanded",
    visible: true,
    interactionMode: false,
    opacity: 0.86,
    bounds: null,
    displayId: null,
    requestedProtectionPolicy: "screen_share_private",
  },
  {
    surfaceKind: "live_transcript_overlay",
    mode: "expanded",
    visible: true,
    interactionMode: false,
    opacity: 0.86,
    bounds: null,
    displayId: null,
    requestedProtectionPolicy: "screen_share_private",
  },
];

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultTargetContext(now: string): InterviewTargetContext {
  return InterviewTargetContextSchema.parse({
    kind: "general_interview",
    id: "general_interview",
    label: "General interview",
    role: "General interview",
    company: null,
    sourceUrl: null,
    notes:
      "General interview context. Confirm a job or notes before the real session when available.",
    savedJob: null,
    profileSnapshot: null,
    confirmedAt: now,
  });
}

function createUnavailableEngine(label: string): InterviewTranscriptionEngine {
  return {
    kind: "deterministic",
    label,
    ready: false,
    privacy: "unknown",
    cost: "unknown",
    latency: "unknown",
    detail: "Rehearsal has not run yet.",
  };
}

function createDefaultRehearsal(now: string): InterviewRehearsalChecklist {
  return InterviewRehearsalChecklistSchema.parse({
    status: "not_run",
    language: "en-US",
    microphoneEngine: createUnavailableEngine("Microphone transcript"),
    meetingAudioEngine: createUnavailableEngine("Meeting/system transcript"),
    checks: [],
    protectedSurfaces: [],
    updatedAt: now,
  });
}

function toProtectionState(
  state: CaptureProtectionState,
): InterviewProtectedSurface["protectionState"] {
  return state;
}

function createOverlaySnapshot(input: {
  surfaceKind: InterviewProtectedSurfaceKind;
  preferences: readonly InterviewOverlayPreference[];
  session: InterviewLiveSession | null;
  fallbackProtectionState: InterviewProtectedSurface["protectionState"];
}): InterviewOverlaySnapshot {
  const preference = input.preferences.find(
    (entry) => entry.surfaceKind === input.surfaceKind,
  );
  const protectedSurface = input.session?.protectedSurfaces.find(
    (entry) => entry.kind === input.surfaceKind,
  );
  const latestVisualBatch = input.session
    ? [...input.session.visualBatches]
        .reverse()
        .find((batch) => batch.clearedAt === null)
    : null;
  const latestCue = input.session?.cueCards.at(-1) ?? null;
  const transcriptSegments = input.session?.transcriptSegments.slice(-8) ?? [];
  const statusLabel = input.session
    ? input.session.status === "active"
      ? input.session.listening
        ? "Live"
        : "Paused"
      : input.session.status === "panic_hidden"
        ? "Hidden"
        : input.session.status
    : "Ready";
  const averageConfidence =
    transcriptSegments.length > 0
      ? transcriptSegments
          .map((segment) => segment.confidence)
          .filter(
            (confidence): confidence is number =>
              typeof confidence === "number",
          )
          .reduce(
            (sum, confidence, _index, values) =>
              sum + confidence / values.length,
            0,
          )
      : null;

  return InterviewOverlaySnapshotSchema.parse({
    surfaceKind: input.surfaceKind,
    mode: preference?.mode ?? "compact",
    visible:
      input.session?.status === "panic_hidden"
        ? false
        : (preference?.visible ?? true),
    interactionMode: preference?.interactionMode ?? false,
    opacity: preference?.opacity ?? 0.86,
    protectionState:
      protectedSurface?.protectionState ?? input.fallbackProtectionState,
    currentCue: latestCue,
    transcriptSegments,
    queuedScreenshotCount: latestVisualBatch?.screenshotCount ?? 0,
    statusLabel,
    confidenceLabel:
      averageConfidence === null
        ? null
        : `${Math.round(averageConfidence * 100)}% confidence`,
  });
}

function createWorkspace(input: {
  now: string;
  setup?: Partial<InterviewSetupState>;
  activeSession?: InterviewLiveSession | null;
  recentSessions?: InterviewSessionSummary[];
  overlayPreferences?: readonly InterviewOverlayPreference[];
}): InterviewWorkspaceView {
  const setup = InterviewSetupStateSchema.parse({
    consent: defaultConsent,
    targetContext: createDefaultTargetContext(input.now),
    prepArtifacts: [],
    rehearsal: createDefaultRehearsal(input.now),
    transcriptionLanguage: "en-US",
    cueSensitivity: "conservative",
    autoCaptureOnCue: false,
    ...(input.setup ?? {}),
  });
  const overlayPreferences = [
    ...(input.overlayPreferences ?? defaultOverlayPreferences),
  ];
  const activeSession = input.activeSession ?? null;
  const fallbackProtectionState =
    setup.rehearsal?.protectedSurfaces[0]?.protectionState ?? "unknown";

  return {
    module: "live-assistant",
    generatedAt: input.now,
    setup,
    activeSession,
    recentSessions: input.recentSessions ?? [],
    overlayPreferences,
    answerOverlay: createOverlaySnapshot({
      surfaceKind: "live_answer_overlay",
      preferences: overlayPreferences,
      session: activeSession,
      fallbackProtectionState,
    }),
    transcriptOverlay: createOverlaySnapshot({
      surfaceKind: "live_transcript_overlay",
      preferences: overlayPreferences,
      session: activeSession,
      fallbackProtectionState,
    }),
  };
}

function hasAcceptedSetupConsent(setup: InterviewSetupState): boolean {
  const consent = setup.consent;
  return Boolean(
    consent.modelTransmission &&
    consent.localRetention &&
    consent.overlayProtectionNotice &&
    consent.acceptedAt,
  );
}

function hasWorkingTranscriptPath(
  rehearsal: InterviewRehearsalChecklist | null,
): boolean {
  return Boolean(
    rehearsal &&
    (rehearsal.microphoneEngine.ready || rehearsal.meetingAudioEngine.ready),
  );
}

function buildStartBlockers(
  setup: InterviewSetupState,
  cueReady: boolean,
  advancedSurfacesEnabled: boolean,
): string[] {
  const blockers: string[] = [];

  if (!hasAcceptedSetupConsent(setup)) {
    blockers.push("Accept setup disclosures.");
  }

  if (!setup.targetContext) {
    blockers.push("Confirm interview target context.");
  }

  if (!hasWorkingTranscriptPath(setup.rehearsal)) {
    blockers.push("At least one transcript path must pass rehearsal.");
  }

  if (!cueReady) {
    blockers.push("Cue-card provider is unavailable.");
  }

  if (advancedSurfacesEnabled) {
    const panicHide = setup.rehearsal?.checks.find(
      (check) => check.id === "panic_hide",
    );
    if (!panicHide || panicHide.status !== "available") {
      blockers.push("Panic-hide hotkey must be available.");
    }
  }

  return blockers;
}

function createDiagnostic(input: {
  sessionId?: string | null;
  kind: InterviewDiagnosticEvent["kind"];
  severity: InterviewDiagnosticEvent["severity"];
  label: string;
  detail?: string | null;
  occurredAt: string;
}): InterviewDiagnosticEvent {
  return {
    id: createId("diagnostic"),
    sessionId: input.sessionId ?? null,
    kind: input.kind,
    severity: input.severity,
    label: input.label,
    detail: input.detail ?? null,
    occurredAt: input.occurredAt,
  };
}

function getLatestQuestion(
  segments: readonly InterviewTranscriptSegment[],
): string {
  return (
    [...segments]
      .reverse()
      .find(
        (segment) =>
          segment.source === "meeting_audio" ||
          segment.source === "meeting_native_transcript" ||
          segment.source === "typed_question",
      )?.text ??
    segments.at(-1)?.text ??
    "What should I focus on in this answer?"
  );
}

function summarizeServiceError(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  if (message.length === 0) {
    return "Unknown provider failure";
  }

  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function createCueProviderFailureCard(input: {
  sessionId: string;
  triggerKind: InterviewCueCard["triggerKind"];
  question: string;
  disclosure: InterviewCueInputDisclosure;
  createdAt: string;
}): InterviewCueCard {
  return InterviewCueCardSchema.parse({
    id: `cue_provider_failure_${input.createdAt.replace(/\W/g, "_")}`,
    sessionId: input.sessionId,
    title: "Cue unavailable",
    question: input.question,
    answerOutline: [
      "Ask for a moment to think, then answer from your own experience.",
      "Restate the question briefly and cover the most relevant tradeoff.",
    ],
    supportingPoints: [
      "The cue provider failed or returned invalid output, so no generated guidance was used.",
    ],
    clarifyingQuestion:
      "Could you clarify the main constraint you want me to optimize for?",
    avoidSaying:
      "Do not claim generated details or metrics that were not in your real experience.",
    expandedContent:
      "Live Assistant could not produce a validated cue card for this turn. Continue with a concise, honest answer grounded in the interview context.",
    triggerKind: input.triggerKind,
    disclosure: input.disclosure,
    createdAt: input.createdAt,
  });
}

function buildChatAssistantContent(cue: InterviewCueCard): string {
  return [
    cue.expandedContent,
    cue.answerOutline.length > 0
      ? cue.answerOutline.map((item) => `- ${item}`).join("\n")
      : null,
    cue.supportingPoints.length > 0
      ? `Supporting points:\n${cue.supportingPoints.map((item) => `- ${item}`).join("\n")}`
      : null,
    cue.clarifyingQuestion
      ? `Clarifying question: ${cue.clarifyingQuestion}`
      : null,
    cue.avoidSaying ? `Avoid: ${cue.avoidSaying}` : null,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
}

function shouldGenerateAutomaticCue(input: {
  session: InterviewLiveSession;
  segment: InterviewTranscriptSegment;
}): boolean {
  if (
    input.session.status !== "active" ||
    !input.session.listening ||
    input.session.automaticCueSensitivity === "manual_only" ||
    input.segment.source === "microphone" ||
    input.segment.state === "partial"
  ) {
    return false;
  }

  return (
    input.session.automaticCueSensitivity === "balanced" ||
    input.segment.text.includes("?")
  );
}

function buildCueDisclosure(input: {
  session: InterviewLiveSession;
  triggerSource: InterviewCueInputDisclosure["triggerSource"];
  visualBatch: InterviewCueVisualBatch | null;
}): InterviewCueInputDisclosure {
  const usedSegments = input.session.transcriptSegments.slice(-6);
  const degradedCapabilityIds = input.session.diagnostics
    .filter((event) => event.severity !== "info")
    .slice(-4)
    .map((event) => event.kind);

  return {
    transcriptWindow: `${usedSegments.length} recent segment${usedSegments.length === 1 ? "" : "s"}`,
    triggerSource: input.triggerSource,
    targetContextKind: input.session.targetContext.kind,
    screenshotCount: input.visualBatch?.screenshotCount ?? 0,
    overlayContaminated: input.visualBatch?.overlayContaminated ?? false,
    degradedCapabilityIds,
    usedPartialTranscript: usedSegments.some(
      (segment) => segment.state !== "final",
    ),
  };
}

function formatTranscriptSourceForExport(
  source: InterviewTranscriptSegment["source"],
): string {
  switch (source) {
    case "microphone":
      return "Your microphone";
    case "meeting_audio":
      return "System audio";
    case "meeting_native_transcript":
      return "Meeting transcript";
    case "typed_question":
      return "Typed question";
  }
}

function buildMarkdownExport(session: InterviewLiveSession): string {
  const lines = [
    `# ${session.targetContext.label}`,
    "",
    `Started: ${session.startedAt}`,
    `Ended: ${session.endedAt ?? "Active"}`,
    `Status: ${session.status}`,
    "",
    "## Summary",
    "",
    session.cueSummary,
    "",
    "## Transcript",
    "",
    ...session.transcriptSegments.map(
      (segment) =>
        `- ${segment.startedAt} [${formatTranscriptSourceForExport(segment.source)}] ${segment.text}`,
    ),
    ...(session.transcriptAnnotations.length > 0
      ? [
          "",
          "## Transcript Annotations",
          "",
          ...session.transcriptAnnotations.map(
            (annotation) =>
              `- ${annotation.createdAt} [${annotation.kind}] ${annotation.body}`,
          ),
        ]
      : []),
    "",
    "## Cue Cards",
    "",
    ...session.cueCards.flatMap((cue) => [
      `### ${cue.title}`,
      "",
      cue.question,
      "",
      ...cue.answerOutline.map((item) => `- ${item}`),
      ...(cue.clarifyingQuestion
        ? ["", `Clarify: ${cue.clarifyingQuestion}`]
        : []),
      "",
    ]),
  ];

  return lines.join("\n");
}

async function persist(
  repository: LiveAssistantRepository,
  snapshot: InterviewWorkspaceView,
  changedArchiveSessions: readonly InterviewLiveSession[] = [],
): Promise<InterviewWorkspaceView> {
  await repository.saveWorkspace(snapshot, changedArchiveSessions);
  return snapshot;
}

export function toOverlayWindowState(
  model: InterviewOverlayModel,
): OverlayWindowState {
  return {
    kind: "interview-overlay",
    mode: model.visible ? model.mode : "hidden",
    visible: model.visible,
    alwaysOnTop: true,
    focusable: false,
    ignoreMouseEvents: model.mode === "compact",
  };
}

export function toProtectedOverlayWindowState(
  snapshot: InterviewOverlaySnapshot,
): OverlayWindowState {
  return {
    kind:
      snapshot.surfaceKind === "live_answer_overlay"
        ? "interview-answer-overlay"
        : "interview-transcript-overlay",
    mode: snapshot.visible ? snapshot.mode : "hidden",
    visible: snapshot.visible,
    alwaysOnTop: true,
    focusable: snapshot.interactionMode,
    ignoreMouseEvents: !snapshot.interactionMode,
    opacity: snapshot.opacity,
    capturePolicy: "screen-share-private",
  };
}

export function createLiveAssistantService(
  options: LiveAssistantServiceOptions,
): LiveAssistantService {
  const now = options.now ?? (() => new Date().toISOString());
  const advancedSurfacesEnabled = options.advancedSurfacesEnabled ?? false;
  let snapshotPromise: Promise<InterviewWorkspaceView> | null = null;
  let workspaceMutationTail: Promise<void> = Promise.resolve();
  let audioProviderTail: Promise<void> = Promise.resolve();
  let audioCaptureEpoch = 0;

  function enqueueWorkspaceMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = workspaceMutationTail.then(task);
    workspaceMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function enqueueAudioProviderTask<T>(task: () => Promise<T>): Promise<T> {
    const result = audioProviderTail.then(task);
    audioProviderTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function invalidateInFlightAudioTranscriptions() {
    audioCaptureEpoch += 1;
  }

  async function loadSnapshot(): Promise<InterviewWorkspaceView> {
    snapshotPromise ??= options.repository
      .loadWorkspace()
      .then(async (persistedSnapshot) => {
        const currentNow = now();
        if (!persistedSnapshot) {
          return createWorkspace({ now: currentNow });
        }

        if (!persistedSnapshot.activeSession) {
          return persistedSnapshot;
        }

        const interruptedSession = InterviewLiveSessionSchema.parse({
          ...persistedSnapshot.activeSession,
          status: "interrupted",
          listening: false,
          endedAt: persistedSnapshot.activeSession.endedAt ?? currentNow,
          diagnostics: [
            ...persistedSnapshot.activeSession.diagnostics,
            createDiagnostic({
              sessionId: persistedSnapshot.activeSession.id,
              kind: "lifecycle",
              severity: "warning",
              label: "Session interrupted during app restart",
              detail:
                "Capture did not resume automatically. Start a new session after review.",
              occurredAt: currentNow,
            }),
          ],
        });
        return persist(
          options.repository,
          createWorkspace({
            now: currentNow,
            setup: persistedSnapshot.setup,
            activeSession: null,
            recentSessions: [
              summarizeInterviewSession(interruptedSession),
              ...persistedSnapshot.recentSessions.filter(
                (session) => session.id !== interruptedSession.id,
              ),
            ],
            overlayPreferences: persistedSnapshot.overlayPreferences,
          }),
          [interruptedSession],
        );
      });

    return snapshotPromise;
  }

  async function saveSnapshot(
    nextSnapshot: InterviewWorkspaceView,
    changedArchiveSessions: readonly InterviewLiveSession[] = [],
  ) {
    const savedSnapshot = await persist(
      options.repository,
      nextSnapshot,
      changedArchiveSessions,
    );
    snapshotPromise = Promise.resolve(savedSnapshot);
    return savedSnapshot;
  }

  async function findSession(
    sessionId: string,
  ): Promise<InterviewLiveSession | null> {
    const current = await loadSnapshot();
    if (current.activeSession?.id === sessionId) return current.activeSession;
    if (!current.recentSessions.some((session) => session.id === sessionId))
      return null;
    return options.repository.loadSession(sessionId);
  }

  async function rebuildWorkspace(input: {
    setup?: InterviewSetupState;
    activeSession?: InterviewLiveSession | null;
    recentSessions?: InterviewSessionSummary[];
    overlayPreferences?: readonly InterviewOverlayPreference[];
  }): Promise<InterviewWorkspaceView> {
    const current = await loadSnapshot();
    return createWorkspace({
      now: now(),
      setup: input.setup ?? current.setup,
      activeSession:
        input.activeSession === undefined
          ? current.activeSession
          : input.activeSession,
      recentSessions: input.recentSessions ?? current.recentSessions,
      overlayPreferences:
        input.overlayPreferences ?? current.overlayPreferences,
    });
  }

  async function generateCue(
    session: InterviewLiveSession,
    triggerKind: InterviewCueCard["triggerKind"],
  ): Promise<InterviewLiveSession> {
    const currentNow = now();
    const visualBatch =
      [...session.visualBatches]
        .reverse()
        .find((batch) => batch.clearedAt === null) ?? null;
    const disclosure = buildCueDisclosure({
      session,
      triggerSource: session.transcriptSegments.at(-1)?.source ?? null,
      visualBatch,
    });
    const cueInput = {
      sessionId: session.id,
      triggerKind,
      question: getLatestQuestion(session.transcriptSegments),
      targetLabel: session.targetContext.label,
      targetContextKind: session.targetContext.kind,
      transcriptSegments: session.transcriptSegments.slice(-8),
      visualObservations: visualBatch?.observations ?? [],
      disclosure,
      createdAt: currentNow,
    };
    const providerDiagnostics: InterviewDiagnosticEvent[] = [];
    let normalizedCue: InterviewCueCard;

    try {
      const cue = await options.cueCardProvider.generateCueCard(cueInput);
      normalizedCue = InterviewCueCardSchema.parse(cue);
      if (normalizedCue.executionReceipt?.fallbackUsed) {
        providerDiagnostics.push(
          createDiagnostic({
            sessionId: session.id,
            kind: "provider",
            severity: "warning",
            label: "Cue provider used safe fallback",
            detail:
              "The configured AI could not finish this cue, so Live Assistant used its built-in grounded fallback.",
            occurredAt: currentNow,
          }),
        );
      }
    } catch (error) {
      normalizedCue = createCueProviderFailureCard(cueInput);
      providerDiagnostics.push(
        createDiagnostic({
          sessionId: session.id,
          kind: "provider",
          severity: "warning",
          label: "Cue provider failed",
          detail: `A quiet fallback cue card was shown because cue generation failed validation or timed out: ${summarizeServiceError(error)}`,
          occurredAt: currentNow,
        }),
      );
    }

    const cueSummary = await options.summaryProvider.summarize({
      previousSummary: session.cueSummary,
      transcriptSegments: session.transcriptSegments,
      cueCards: [...session.cueCards, normalizedCue],
    });
    const cueContextSegmentIds = new Set(
      session.transcriptSegments.slice(-8).map((segment) => segment.id),
    );
    const transcriptSegments = session.transcriptSegments.map((segment) =>
      cueContextSegmentIds.has(segment.id)
        ? {
            ...segment,
            usedInCueIds: segment.usedInCueIds.includes(normalizedCue.id)
              ? segment.usedInCueIds
              : [...segment.usedInCueIds, normalizedCue.id],
          }
        : segment,
    );
    const clearedBatches = session.visualBatches.map((batch) =>
      batch.id === visualBatch?.id
        ? { ...batch, clearedAt: currentNow }
        : batch,
    );

    return InterviewLiveSessionSchema.parse({
      ...session,
      transcriptSegments,
      cueCards: [...session.cueCards, normalizedCue],
      cueSummary,
      visualBatches: clearedBatches,
      diagnostics: [
        ...session.diagnostics,
        ...providerDiagnostics,
        createDiagnostic({
          sessionId: session.id,
          kind: "cue",
          severity: providerDiagnostics.length > 0 ? "warning" : "info",
          label:
            providerDiagnostics.length > 0
              ? "Cue fallback card shown"
              : "Cue card generated",
          detail:
            providerDiagnostics.length > 0
              ? `${triggerKind} used ${disclosure.transcriptWindow}; generated provider output was unavailable.`
              : `${triggerKind} used ${disclosure.transcriptWindow}.`,
          occurredAt: currentNow,
        }),
      ],
    });
  }

  async function captureVisualBatchForCue(input: {
    session: InterviewLiveSession;
    reason: "queued_visual_batch" | "capture_and_force_cue" | "automatic_cue";
  }): Promise<InterviewLiveSession> {
    const currentNow = now();
    const capture =
      await options.screenshotCaptureAdapter.captureInterviewRegion({
        reason: input.reason,
      });
    const observations =
      await options.screenshotVisionProvider.describeScreenshotBatch({
        batchId: capture.id,
        screenshotCount: capture.screenshotCount,
        overlayContaminated: capture.overlayContaminated,
        ...(capture.images ? { images: capture.images } : {}),
        createdAt: capture.capturedAt,
      });
    const batch: InterviewCueVisualBatch = {
      id: capture.id,
      screenshotCount: capture.screenshotCount,
      overlayContaminated: capture.overlayContaminated,
      observations: [...observations],
      pinnedScreenshotIds: [],
      createdAt: capture.capturedAt,
      clearedAt: null,
    };

    return InterviewLiveSessionSchema.parse({
      ...input.session,
      visualBatches: [...input.session.visualBatches, batch],
      diagnostics: [
        ...input.session.diagnostics,
        createDiagnostic({
          sessionId: input.session.id,
          kind: "screenshot",
          severity: capture.overlayContaminated ? "warning" : "info",
          label:
            input.reason === "automatic_cue"
              ? "Screenshot captured for automatic cue"
              : "Screenshot queued for cue context",
          detail: capture.detail,
          occurredAt: currentNow,
        }),
      ],
    });
  }

  async function ingestTranscriptSegment(
    rawInput: InterviewTranscriptSegmentInput,
  ): Promise<InterviewWorkspaceView> {
    const input = InterviewTranscriptSegmentInputSchema.parse(rawInput);
    const current = await loadSnapshot();
    const activeSession = current.activeSession;

    if (!activeSession || activeSession.id !== input.sessionId) {
      return current;
    }

    const currentNow = now();
    const existingSegment = input.transcriptSegmentId
      ? activeSession.transcriptSegments.find(
          (segment) => segment.id === input.transcriptSegmentId,
        )
      : null;
    const segment = InterviewTranscriptSegmentSchema.parse({
      id:
        existingSegment?.id ??
        input.transcriptSegmentId ??
        createId("transcript_segment"),
      sessionId: activeSession.id,
      source: input.source,
      state: input.state,
      text: input.text,
      startedAt: input.startedAt ?? existingSegment?.startedAt ?? currentNow,
      endedAt:
        input.endedAt === undefined
          ? input.state === "final"
            ? currentNow
            : (existingSegment?.endedAt ?? null)
          : input.endedAt,
      language: input.language,
      confidence: input.confidence,
      engineKind: input.engineKind,
      usedInCueIds: existingSegment?.usedInCueIds ?? [],
    });
    const transcriptSegments = existingSegment
      ? activeSession.transcriptSegments.map((entry) =>
          entry.id === existingSegment.id ? segment : entry,
        )
      : [...activeSession.transcriptSegments, segment];
    let nextSession = InterviewLiveSessionSchema.parse({
      ...activeSession,
      transcriptSegments,
      diagnostics: [
        ...activeSession.diagnostics,
        createDiagnostic({
          sessionId: activeSession.id,
          kind: "provider",
          severity: "info",
          label: "Transcript segment ingested",
          detail: `${segment.source.replaceAll("_", " ")} transcript segment saved through the typed live ingestion path.`,
          occurredAt: currentNow,
        }),
      ],
    });

    if (shouldGenerateAutomaticCue({ session: nextSession, segment })) {
      if (
        current.setup.autoCaptureOnCue &&
        current.setup.consent.screenshotCapture
      ) {
        nextSession = await captureVisualBatchForCue({
          session: nextSession,
          reason: "automatic_cue",
        });
      }
      nextSession = await generateCue(nextSession, "automatic_question");
    }

    const nextSnapshot = await rebuildWorkspace({
      activeSession: nextSession,
    });
    return saveSnapshot(nextSnapshot);
  }

  async function applyAudioProviderOutcomeInOrder(input: {
    audioInput: InterviewAudioTranscriptionInput;
    expectedAudioCaptureEpoch: number;
    outcome: InterviewAudioProviderOutcome;
  }): Promise<InterviewWorkspaceView> {
    const current = await loadSnapshot();
    const activeSession = current.activeSession;
    const currentNow = now();

    if (!activeSession || activeSession.id !== input.audioInput.sessionId) {
      return current;
    }

    if (
      !activeSession.listening ||
      input.expectedAudioCaptureEpoch !== audioCaptureEpoch
    ) {
      const nextSession = InterviewLiveSessionSchema.parse({
        ...activeSession,
        diagnostics: [
          ...activeSession.diagnostics,
          createDiagnostic({
            sessionId: activeSession.id,
            kind: "provider",
            severity: "warning",
            label: "Audio transcription ignored while paused",
            detail: `${input.audioInput.source.replaceAll("_", " ")} audio chunk completed after capture was paused or changed.`,
            occurredAt: currentNow,
          }),
        ],
      });
      const nextSnapshot = await rebuildWorkspace({
        activeSession: nextSession,
      });
      return saveSnapshot(nextSnapshot);
    }

    if (input.outcome.status === "unavailable") {
      const nextSession = InterviewLiveSessionSchema.parse({
        ...activeSession,
        diagnostics: [
          ...activeSession.diagnostics,
          createDiagnostic({
            sessionId: activeSession.id,
            kind: "provider",
            severity: "warning",
            label: "Audio transcription provider unavailable",
            detail:
              "No provider is configured for transient audio chunk transcription.",
            occurredAt: currentNow,
          }),
        ],
      });
      const nextSnapshot = await rebuildWorkspace({
        activeSession: nextSession,
      });
      return saveSnapshot(nextSnapshot);
    }

    if (input.outcome.status === "failed") {
      const nextSession = InterviewLiveSessionSchema.parse({
        ...activeSession,
        diagnostics: [
          ...activeSession.diagnostics,
          createDiagnostic({
            sessionId: activeSession.id,
            kind: "provider",
            severity: "warning",
            label: "Audio transcription failed",
            detail: input.outcome.detail,
            occurredAt: currentNow,
          }),
        ],
      });
      const nextSnapshot = await rebuildWorkspace({
        activeSession: nextSession,
      });
      return saveSnapshot(nextSnapshot);
    }

    if (input.outcome.status === "empty") {
      return current;
    }

    return ingestTranscriptSegment({
      sessionId: activeSession.id,
      source: input.audioInput.source,
      state: "final",
      text: input.outcome.result.text,
      startedAt: input.audioInput.startedAt ?? currentNow,
      endedAt: input.audioInput.endedAt ?? currentNow,
      language: input.outcome.result.language,
      confidence: input.outcome.result.confidence,
      engineKind: input.outcome.result.engineKind,
    });
  }

  async function sendChatMessageInOrder(
    rawInput: SendInterviewChatMessageInput,
  ): Promise<InterviewChatTurn> {
    const input = SendInterviewChatMessageInputSchema.parse(rawInput);
    const current = await loadSnapshot();
    const activeSession = current.activeSession;

    if (!activeSession) {
      throw new Error("Start an interview session before sending a message.");
    }
    if (input.sessionId && input.sessionId !== activeSession.id) {
      throw new Error(
        "The chat message does not belong to the active interview session.",
      );
    }
    if (
      activeSession.chatConversation &&
      activeSession.chatConversation.id !== input.conversationId
    ) {
      throw new Error(
        "The chat message does not belong to this interview conversation.",
      );
    }

    const currentNow = now();
    const userMessageId = createId("interview_chat_user");
    let nextSession = activeSession;
    let visualObservations: readonly InterviewVisualObservation[] = [];
    let visualDiagnostic: InterviewDiagnosticEvent | null = null;

    if (input.attachments.length > 0) {
      const visualBatchId = createId("interview_chat_visual_batch");
      try {
        visualObservations =
          await options.screenshotVisionProvider.describeScreenshotBatch({
            batchId: visualBatchId,
            screenshotCount: input.attachments.length,
            overlayContaminated: false,
            images: input.attachments.map((attachment) => ({
              mimeType: attachment.mimeType,
              base64: attachment.dataBase64,
            })),
            createdAt: currentNow,
          });
      } catch (error) {
        visualDiagnostic = createDiagnostic({
          sessionId: activeSession.id,
          kind: "screenshot",
          severity: "warning",
          label: "Chat attachment analysis failed",
          detail: summarizeServiceError(error),
          occurredAt: currentNow,
        });
      }

      nextSession = InterviewLiveSessionSchema.parse({
        ...nextSession,
        visualBatches: [
          ...nextSession.visualBatches,
          {
            id: visualBatchId,
            screenshotCount: input.attachments.length,
            overlayContaminated: false,
            observations: visualObservations,
            pinnedScreenshotIds: [],
            createdAt: currentNow,
            clearedAt: null,
          },
        ],
        diagnostics: [
          ...nextSession.diagnostics,
          ...(visualDiagnostic ? [visualDiagnostic] : []),
          createDiagnostic({
            sessionId: activeSession.id,
            kind: "screenshot",
            severity: visualDiagnostic ? "warning" : "info",
            label: "Chat image attached",
            detail: `${input.attachments.length} temporary image attachment${input.attachments.length === 1 ? " was" : "s were"} added to this turn without retaining raw image bytes.`,
            occurredAt: currentNow,
          }),
        ],
      });
    }

    const question =
      input.content.trim() ||
      "What should I focus on in the attached interview screenshot?";
    const segment = InterviewTranscriptSegmentSchema.parse({
      id: createId("interview_chat_segment"),
      sessionId: activeSession.id,
      source: "typed_question",
      state: "final",
      text: question,
      startedAt: currentNow,
      endedAt: currentNow,
      language: current.setup.transcriptionLanguage,
      confidence: null,
      engineKind: "deterministic",
      usedInCueIds: [],
    });
    nextSession = InterviewLiveSessionSchema.parse({
      ...nextSession,
      transcriptSegments: [...nextSession.transcriptSegments, segment],
      diagnostics: [
        ...nextSession.diagnostics,
        createDiagnostic({
          sessionId: activeSession.id,
          kind: "provider",
          severity: "info",
          label: "Chat message received",
          detail:
            "The explicitly sent message will always produce a visible assistant response.",
          occurredAt: currentNow,
        }),
      ],
    });
    nextSession = await generateCue(nextSession, "force_cue");

    const cue = nextSession.cueCards.at(-1);
    if (!cue) {
      throw new Error(
        "Live Assistant did not produce a response for this message.",
      );
    }

    const attachments = input.attachments.map((attachment, index) =>
      InterviewChatImageAttachmentSchema.parse({
        id: `${userMessageId}_attachment_${index + 1}`,
        kind: "image",
        source: attachment.source,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize,
        dimensions: attachment.dimensions,
        retention: "temporary",
        altText:
          visualObservations[index]?.summary ??
          visualObservations[0]?.summary ??
          null,
        createdAt: currentNow,
      }),
    );
    const turn = InterviewChatTurnSchema.parse({
      userMessage: {
        id: userMessageId,
        conversationId: input.conversationId,
        sessionId: activeSession.id,
        role: "user",
        content: input.content,
        attachments,
        createdAt: currentNow,
      },
      assistantMessage: {
        id: createId("interview_chat_assistant"),
        conversationId: input.conversationId,
        sessionId: activeSession.id,
        role: "assistant",
        content: buildChatAssistantContent(cue),
        replyToMessageId: userMessageId,
        attachments: [],
        usedAttachmentIds: attachments.map((attachment) => attachment.id),
        createdAt: cue.createdAt,
      },
    });
    const existingConversation = activeSession.chatConversation;
    const conversationMessages = [
      ...(existingConversation?.messages ?? []),
      turn.userMessage,
      turn.assistantMessage,
    ].slice(-interviewChatLimits.maxConversationMessages);
    nextSession = InterviewLiveSessionSchema.parse({
      ...nextSession,
      chatConversation: InterviewChatConversationSchema.parse({
        id: input.conversationId,
        sessionId: activeSession.id,
        messages: conversationMessages,
        createdAt: existingConversation?.createdAt ?? currentNow,
        updatedAt: turn.assistantMessage.createdAt,
      }),
    });
    const nextSnapshot = await rebuildWorkspace({ activeSession: nextSession });
    await saveSnapshot(nextSnapshot);

    return turn;
  }

  return {
    getSession(sessionId) {
      return enqueueWorkspaceMutation(() => findSession(sessionId));
    },
    async getWorkspace() {
      return loadSnapshot();
    },
    saveSetup(input) {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        const currentNow = now();
        const nextSetup = InterviewSetupStateSchema.parse({
          ...current.setup,
          ...(input.consent ? { consent: input.consent } : {}),
          ...(input.targetContext !== undefined
            ? { targetContext: input.targetContext }
            : {}),
          ...(input.transcriptionLanguage
            ? { transcriptionLanguage: input.transcriptionLanguage }
            : {}),
          ...(input.cueSensitivity
            ? { cueSensitivity: input.cueSensitivity }
            : {}),
          ...(input.autoCaptureOnCue !== undefined
            ? { autoCaptureOnCue: input.autoCaptureOnCue }
            : {}),
        });
        const withConsentTimestamp =
          input.consent && !input.consent.acceptedAt
            ? InterviewSetupStateSchema.parse({
                ...nextSetup,
                consent: { ...nextSetup.consent, acceptedAt: currentNow },
              })
            : nextSetup;
        const nextSnapshot = await rebuildWorkspace({
          setup: withConsentTimestamp,
        });
        return saveSnapshot(nextSnapshot);
      });
    },
    updateOverlayPreference(input) {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        const fallbackPreference = defaultOverlayPreferences.find(
          (preference) => preference.surfaceKind === input.surfaceKind,
        );
        const matchingPreference = current.overlayPreferences.find(
          (preference) => preference.surfaceKind === input.surfaceKind,
        );
        const nextPreference = InterviewOverlayPreferenceSchema.parse({
          ...(fallbackPreference ?? {}),
          ...(matchingPreference ?? {}),
          ...input,
        });
        const replaced = current.overlayPreferences.some(
          (preference) => preference.surfaceKind === input.surfaceKind,
        );
        const nextOverlayPreferences = replaced
          ? current.overlayPreferences.map((preference) =>
              preference.surfaceKind === input.surfaceKind
                ? nextPreference
                : preference,
            )
          : [...current.overlayPreferences, nextPreference];
        const nextSnapshot = await rebuildWorkspace({
          overlayPreferences: nextOverlayPreferences,
        });
        return saveSnapshot(nextSnapshot);
      });
    },
    resetOverlayPreferences() {
      return enqueueWorkspaceMutation(async () => {
        const nextSnapshot = await rebuildWorkspace({
          overlayPreferences: defaultOverlayPreferences,
        });
        return saveSnapshot(nextSnapshot);
      });
    },
    runRehearsal() {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        const currentNow = now();
        const engines = options.transcriptionProvider.getEngines();
        const audioCapabilities =
          await options.audioCaptureAdapter.checkAudioCapture();
        const screenshotCapture =
          await options.screenshotCaptureAdapter.captureInterviewRegion({
            reason: "rehearsal",
          });
        const cueStatus = options.cueCardProvider.getStatus();
        const visionStatus = options.screenshotVisionProvider.getStatus();
        const protectedSurfaceRequests = advancedSurfacesEnabled
          ? [
              {
                kind: "live_answer_overlay" as const,
                result: await options.protectedSurfaceAdapter.requestProtection(
                  {
                    surface: "live-answer-overlay",
                    windowKind: "interview-answer-overlay",
                    policy: "screen-share-private",
                  },
                ),
              },
              {
                kind: "live_transcript_overlay" as const,
                result: await options.protectedSurfaceAdapter.requestProtection(
                  {
                    surface: "live-transcript-overlay",
                    windowKind: "interview-transcript-overlay",
                    policy: "screen-share-private",
                  },
                ),
              },
            ]
          : [];
        const protectionStates = protectedSurfaceRequests.map(
          ({ result }) => result.protectionState,
        );
        const protectionStatus = !advancedSurfacesEnabled
          ? "unsupported"
          : protectionStates.every((state) => state === "verified_protected")
            ? "available"
            : protectionStates.some((state) => state === "failed")
              ? "unavailable"
              : protectionStates.every((state) => state === "unsupported")
                ? "unsupported"
                : "degraded";
        const transcriptPathReady =
          engines.microphone.ready || engines.meetingAudio.ready;
        const checks: InterviewCapabilityCheck[] = [
          ...audioCapabilities.map((capability) => ({
            id:
              capability.source === "microphone"
                ? "microphone_audio"
                : "meeting_audio",
            label: capability.label,
            status: capability.status,
            required: false,
            detail: capability.detail,
            checkedAt: currentNow,
          })),
          {
            id: "transcription_language",
            label: "Selected transcription language",
            status: current.setup.transcriptionLanguage
              ? "available"
              : "unknown",
            required: false,
            detail: `Session transcripts will use ${current.setup.transcriptionLanguage}.`,
            checkedAt: currentNow,
          },
          {
            id: "transcription_engine_fallback",
            label: "Transcription engine selection and fallback",
            status: transcriptPathReady ? "available" : "unavailable",
            required: true,
            detail: `Microphone engine: ${engines.microphone.label} (${engines.microphone.ready ? "ready" : "not ready"}). Meeting/system engine: ${engines.meetingAudio.label} (${engines.meetingAudio.ready ? "ready" : "not ready"}). Engine order prefers platform/local, local model, browser speech, then cloud fallback.`,
            checkedAt: currentNow,
          },
          {
            id: "cue_card_provider",
            label: cueStatus.label,
            status: cueStatus.ready ? "available" : "unavailable",
            required: true,
            detail: cueStatus.detail,
            checkedAt: currentNow,
          },
          {
            id: "screenshot_capture",
            label: "Screenshot capture",
            status: screenshotCapture.status,
            required: false,
            detail: screenshotCapture.detail,
            checkedAt: currentNow,
          },
          {
            id: "screenshot_vision",
            label: visionStatus.label,
            status: visionStatus.ready ? "available" : "degraded",
            required: false,
            detail: visionStatus.detail,
            checkedAt: currentNow,
          },
          {
            id: "overlay_windows",
            label: "Protected overlay windows",
            status: advancedSurfacesEnabled ? "available" : "unsupported",
            required: advancedSurfacesEnabled,
            detail: advancedSurfacesEnabled
              ? "Answer and transcript overlays are modeled as separate protected surfaces."
              : "Advanced hidden/protected overlays are disabled in the default visible-chat mode.",
            checkedAt: currentNow,
          },
          {
            id: "overlay_capture_protection",
            label: "Overlay capture protection request",
            status: protectionStatus,
            required: false,
            detail:
              protectionStatus === "available"
                ? "Overlay capture protection is verified for this rehearsal."
                : "Overlay capture protection is requested but requires runtime verification before it can be labeled protected.",
            checkedAt: currentNow,
          },
          {
            id: "panic_hide",
            label: "Panic-hide hotkey",
            status: advancedSurfacesEnabled ? "available" : "unsupported",
            required: advancedSurfacesEnabled,
            detail: advancedSurfacesEnabled
              ? "Registered as a semantic session action; platform collisions are surfaced by the adapter."
              : "Panic-hide is intentionally disabled while Live Assistant uses the visible-chat experience.",
            checkedAt: currentNow,
          },
          {
            id: "tray_controls",
            label: "Tray controls",
            status: advancedSurfacesEnabled ? "available" : "unsupported",
            required: false,
            detail: advancedSurfacesEnabled
              ? "Tray actions mirror semantic session actions."
              : "Background tray controls are disabled in visible-chat mode.",
            checkedAt: currentNow,
          },
          {
            id: "retention_defaults",
            label: "Structured retention defaults",
            status: current.setup.consent.localRetention
              ? "available"
              : "unknown",
            required: false,
            detail:
              "Session history retains structured transcripts, cue cards, diagnostics, prep artifacts, annotations, and explicit pinned metadata; raw audio, raw prompts, raw provider payloads, and unpinned screenshots are not retained by default.",
            checkedAt: currentNow,
          },
        ];
        const blocked = checks.some(
          (check) => check.required && check.status !== "available",
        );
        const degraded = checks.some(
          (check) =>
            check.status === "degraded" ||
            check.status === "unknown" ||
            (check.required && check.status === "unsupported"),
        );
        const rehearsal = InterviewRehearsalChecklistSchema.parse({
          status: blocked ? "blocked" : degraded ? "degraded" : "passed",
          language: current.setup.transcriptionLanguage,
          microphoneEngine: engines.microphone,
          meetingAudioEngine: engines.meetingAudio,
          checks,
          protectedSurfaces: protectedSurfaceRequests.map(
            ({ kind, result }) => ({
              id: result.id,
              kind,
              requestedPolicy: "screen_share_private" as const,
              protectionState: toProtectionState(result.protectionState),
              verificationMethod: result.verificationMethod,
              displayLabel: result.windowKind,
              detail: result.detail,
              lastVerifiedAt: result.lastVerifiedAt,
            }),
          ),
          updatedAt: currentNow,
        });
        const nextSetup = InterviewSetupStateSchema.parse({
          ...current.setup,
          rehearsal,
          targetContext:
            current.setup.targetContext ??
            createDefaultTargetContext(currentNow),
        });
        const nextSnapshot = await rebuildWorkspace({ setup: nextSetup });
        return saveSnapshot(nextSnapshot);
      });
    },
    startSession() {
      return (async () => {
        const initial = await loadSnapshot();
        if (
          !initial.setup.rehearsal ||
          initial.setup.rehearsal.status === "not_run"
        ) {
          await this.runRehearsal();
        }

        return enqueueWorkspaceMutation(async () => {
          const current = await loadSnapshot();
          if (current.activeSession) {
            return current;
          }
          const currentNow = now();
          const setup = current.setup;
          const targetContext =
            setup.targetContext ?? createDefaultTargetContext(currentNow);
          const cueReady = options.cueCardProvider.getStatus().ready;
          const blockers = buildStartBlockers(
            { ...setup, targetContext },
            cueReady,
            advancedSurfacesEnabled,
          );

          if (blockers.length > 0) {
            const nextSetup = InterviewSetupStateSchema.parse({
              ...setup,
              rehearsal: setup.rehearsal
                ? {
                    ...setup.rehearsal,
                    status: "blocked",
                    checks: [
                      ...setup.rehearsal.checks,
                      ...blockers.map((blocker) => ({
                        id: `start_blocker_${blocker.toLowerCase().replace(/\W+/g, "_")}`,
                        label: blocker,
                        status: "unavailable",
                        required: true,
                        detail: blocker,
                        checkedAt: currentNow,
                      })),
                    ],
                    updatedAt: currentNow,
                  }
                : null,
            });
            const blockedSnapshot = await rebuildWorkspace({
              setup: nextSetup,
            });
            return saveSnapshot(blockedSnapshot);
          }

          const sessionId = createId("interview_session");
          const protectedSurfaces = setup.rehearsal?.protectedSurfaces ?? [];
          const diagnostics = [
            createDiagnostic({
              sessionId,
              kind: "lifecycle",
              severity: "info",
              label: "Interview live session started",
              detail: "Capture starts only after explicit setup and rehearsal.",
              occurredAt: currentNow,
            }),
            ...(setup.rehearsal?.status === "degraded"
              ? [
                  createDiagnostic({
                    sessionId,
                    kind: "capability",
                    severity: "warning" as const,
                    label: "Session started with degraded capabilities",
                    detail:
                      "Some platform capabilities require hardware or OS-level verification.",
                    occurredAt: currentNow,
                  }),
                ]
              : []),
          ];
          const session = InterviewLiveSessionSchema.parse({
            id: sessionId,
            status: "active",
            targetContext: InterviewTargetContextSchema.parse({
              ...targetContext,
              confirmedAt: targetContext.confirmedAt ?? currentNow,
            }),
            startedAt: currentNow,
            endedAt: null,
            listening: true,
            automaticCueSensitivity: setup.cueSensitivity,
            cueSummary: "No summary yet.",
            transcriptSegments: [],
            cueCards: [],
            visualBatches: [],
            diagnostics,
            protectedSurfaces,
          });
          const nextSnapshot = await rebuildWorkspace({
            setup,
            activeSession: session,
          });
          return saveSnapshot(nextSnapshot);
        });
      })();
    },
    beginSessionReconfiguration() {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        const activeSession = current.activeSession;

        if (!activeSession || activeSession.status === "reconfiguring") {
          return current;
        }

        invalidateInFlightAudioTranscriptions();
        const currentNow = now();
        const nextSession = InterviewLiveSessionSchema.parse({
          ...activeSession,
          status: "reconfiguring",
          listening: false,
          diagnostics: [
            ...activeSession.diagnostics,
            createDiagnostic({
              sessionId: activeSession.id,
              kind: "lifecycle",
              severity: "info",
              label: "Session entered reconfiguration",
              detail:
                "Listening and automatic cue triggers are paused while setup preferences and provider readiness are checked.",
              occurredAt: currentNow,
            }),
          ],
        });
        const nextSnapshot = await rebuildWorkspace({
          activeSession: nextSession,
        });
        return saveSnapshot(nextSnapshot);
      });
    },
    finishSessionReconfiguration() {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        const activeSession = current.activeSession;

        if (!activeSession || activeSession.status !== "reconfiguring") {
          return current;
        }

        const currentNow = now();
        const nextSession = InterviewLiveSessionSchema.parse({
          ...activeSession,
          status: "paused",
          listening: false,
          automaticCueSensitivity: current.setup.cueSensitivity,
          protectedSurfaces: current.setup.rehearsal?.protectedSurfaces.length
            ? current.setup.rehearsal.protectedSurfaces
            : activeSession.protectedSurfaces,
          diagnostics: [
            ...activeSession.diagnostics,
            createDiagnostic({
              sessionId: activeSession.id,
              kind: "lifecycle",
              severity: "info",
              label: "Session reconfiguration closed",
              detail:
                "Updated setup preferences are applied. Resume listening deliberately when ready.",
              occurredAt: currentNow,
            }),
          ],
        });
        const nextSnapshot = await rebuildWorkspace({
          activeSession: nextSession,
        });
        return saveSnapshot(nextSnapshot);
      });
    },
    performAction(input) {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        const activeSession = current.activeSession;

        if (!activeSession) {
          return current;
        }

        if (
          !advancedSurfacesEnabled &&
          new Set<InterviewHotkeyAction>([
            "toggle_answer_overlay",
            "toggle_transcript_overlay",
            "toggle_overlay_interaction_mode",
            "panic_hide",
          ]).has(input.action)
        ) {
          return current;
        }

        const currentNow = now();
        let nextSession = activeSession;
        let nextOverlayPreferences = current.overlayPreferences;

        if (
          (input.action === "capture_screenshot" ||
            input.action === "capture_screenshot_and_force_cue") &&
          !current.setup.consent.screenshotCapture
        ) {
          throw new Error(
            "Enable screenshot capture in Live Assistant before capturing the screen.",
          );
        }

        switch (input.action satisfies InterviewHotkeyAction) {
          case "toggle_listening":
            invalidateInFlightAudioTranscriptions();
            nextSession = InterviewLiveSessionSchema.parse({
              ...nextSession,
              listening: !nextSession.listening,
              status: nextSession.listening ? "paused" : "active",
            });
            break;
          case "force_cue":
            nextSession = await generateCue(nextSession, "force_cue");
            break;
          case "capture_screenshot":
            nextSession = await captureVisualBatchForCue({
              session: nextSession,
              reason: "queued_visual_batch",
            });
            break;
          case "capture_screenshot_and_force_cue":
            nextSession = await captureVisualBatchForCue({
              session: nextSession,
              reason: "capture_and_force_cue",
            });
            nextSession = await generateCue(
              nextSession,
              "capture_and_force_cue",
            );
            break;
          case "toggle_answer_overlay":
            nextOverlayPreferences = current.overlayPreferences.map(
              (preference) =>
                preference.surfaceKind === "live_answer_overlay"
                  ? { ...preference, visible: !preference.visible }
                  : preference,
            );
            break;
          case "toggle_transcript_overlay":
            nextOverlayPreferences = current.overlayPreferences.map(
              (preference) =>
                preference.surfaceKind === "live_transcript_overlay"
                  ? { ...preference, visible: !preference.visible }
                  : preference,
            );
            break;
          case "toggle_overlay_interaction_mode": {
            const nextInteractionMode = !current.overlayPreferences.some(
              (preference) => preference.interactionMode,
            );
            nextOverlayPreferences = current.overlayPreferences.map(
              (preference) => ({
                ...preference,
                interactionMode: nextInteractionMode,
              }),
            );
            break;
          }
          case "panic_hide":
            nextSession = InterviewLiveSessionSchema.parse({
              ...nextSession,
              status: "panic_hidden",
              diagnostics: [
                ...nextSession.diagnostics,
                createDiagnostic({
                  sessionId: nextSession.id,
                  kind: "lifecycle",
                  severity: "warning",
                  label: "Panic-hide activated",
                  detail:
                    "Overlays hidden and new cue generation paused. Audio transcript continuity is preserved.",
                  occurredAt: currentNow,
                }),
              ],
            });
            break;
          case "end_session":
            invalidateInFlightAudioTranscriptions();
            nextSession = InterviewLiveSessionSchema.parse({
              ...nextSession,
              status: "ended",
              listening: false,
              endedAt: currentNow,
            });
            break;
        }

        const nextRecentSessions =
          nextSession.status === "ended"
            ? [
                summarizeInterviewSession(nextSession),
                ...current.recentSessions.filter(
                  (session) => session.id !== nextSession.id,
                ),
              ]
            : current.recentSessions;
        const nextSnapshot = await rebuildWorkspace({
          activeSession: nextSession.status === "ended" ? null : nextSession,
          recentSessions: nextRecentSessions,
          overlayPreferences: nextOverlayPreferences,
        });
        return saveSnapshot(
          nextSnapshot,
          nextSession.status === "ended" ? [nextSession] : [],
        );
      });
    },
    deleteSession(sessionId) {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        if (current.activeSession?.id === sessionId) {
          invalidateInFlightAudioTranscriptions();
        }
        const nextSnapshot = await rebuildWorkspace({
          activeSession:
            current.activeSession?.id === sessionId
              ? null
              : current.activeSession,
          recentSessions: current.recentSessions.filter(
            (session) => session.id !== sessionId,
          ),
        });
        return saveSnapshot(nextSnapshot);
      });
    },
    saveCueAsPrepArtifact(input) {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        const session = await findSession(input.sessionId);

        if (!session) {
          return current;
        }

        const cue = session.cueCards.find(
          (entry) => entry.id === input.cueCardId,
        );
        if (!cue) {
          return current;
        }

        const currentNow = now();
        const artifact = InterviewPrepArtifactSchema.parse({
          id: createId("prep"),
          title: cue.title,
          body: [cue.question, ...cue.answerOutline].join("\n"),
          sourceSessionId: session.id,
          createdAt: currentNow,
          updatedAt: currentNow,
        });
        const nextSetup = InterviewSetupStateSchema.parse({
          ...current.setup,
          prepArtifacts: [artifact, ...current.setup.prepArtifacts],
        });
        const nextSnapshot = await rebuildWorkspace({ setup: nextSetup });
        return saveSnapshot(nextSnapshot);
      });
    },
    async addTranscriptSegment(rawInput) {
      return enqueueWorkspaceMutation(() => ingestTranscriptSegment(rawInput));
    },
    async sendChatMessage(rawInput) {
      return enqueueWorkspaceMutation(() => sendChatMessageInOrder(rawInput));
    },
    recordProtectedSurfaceVerification(rawInput) {
      return enqueueWorkspaceMutation(async () => {
        const input =
          InterviewProtectedSurfaceVerificationInputSchema.parse(rawInput);
        const current = await loadSnapshot();
        const activeSession = current.activeSession;
        const currentNow = now();

        if (!activeSession) {
          return current;
        }

        const surfacesByKind = new Map(
          input.protectedSurfaces.map((surface) => [surface.kind, surface]),
        );
        const existingSurfaces = activeSession.protectedSurfaces.map(
          (surface) => surfacesByKind.get(surface.kind) ?? surface,
        );
        const addedSurfaces = input.protectedSurfaces.filter(
          (surface) =>
            !existingSurfaces.some(
              (existingSurface) => existingSurface.kind === surface.kind,
            ),
        );
        const verifiedCount = input.protectedSurfaces.filter(
          (surface) => surface.protectionState === "verified_protected",
        ).length;
        const nextSession = InterviewLiveSessionSchema.parse({
          ...activeSession,
          protectedSurfaces: [...existingSurfaces, ...addedSurfaces],
          diagnostics: [
            ...activeSession.diagnostics,
            createDiagnostic({
              sessionId: activeSession.id,
              kind: "capture_protection",
              severity:
                verifiedCount === input.protectedSurfaces.length
                  ? "info"
                  : "warning",
              label: "Overlay capture protection verified",
              detail: `${verifiedCount}/${input.protectedSurfaces.length} protected overlay surfaces passed ordinary Electron screen-capture verification.`,
              occurredAt: currentNow,
            }),
          ],
        });
        const nextSnapshot = await rebuildWorkspace({
          activeSession: nextSession,
        });
        return saveSnapshot(nextSnapshot);
      });
    },
    recordDisplayChange(input) {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        const activeSession = current.activeSession;
        const currentNow = now();

        if (!activeSession) {
          return current;
        }

        const detail =
          input.detail ??
          "Display topology changed; ordinary Electron capture-protection verification must be refreshed.";
        const staleSurfaces = activeSession.protectedSurfaces.map((surface) =>
          InterviewProtectedSurfaceSchema.parse({
            ...surface,
            protectionState: "requested_unverified",
            verificationMethod: "display-change-revalidation-required",
            detail,
            lastVerifiedAt: null,
          }),
        );
        const nextSession = InterviewLiveSessionSchema.parse({
          ...activeSession,
          protectedSurfaces: staleSurfaces,
          diagnostics: [
            ...activeSession.diagnostics,
            createDiagnostic({
              sessionId: activeSession.id,
              kind: "display",
              severity: "warning",
              label: "Display change requires overlay revalidation",
              detail: `${input.reason}: ${detail}`,
              occurredAt: currentNow,
            }),
          ],
        });
        const nextSnapshot = await rebuildWorkspace({
          activeSession: nextSession,
        });
        return saveSnapshot(nextSnapshot);
      });
    },
    transcribeAudioChunk(rawInput) {
      const audioInput = InterviewAudioTranscriptionInputSchema.parse(rawInput);
      return enqueueAudioProviderTask(async () => {
        const current = await loadSnapshot();
        const captureAllowed =
          audioInput.source === "microphone"
            ? current.setup.consent.microphoneCapture
            : current.setup.consent.meetingAudioCapture;
        if (!captureAllowed) {
          throw new Error(
            audioInput.source === "microphone"
              ? "Enable microphone capture in Live Assistant before transcribing microphone audio."
              : "Enable system-audio capture in Live Assistant before transcribing meeting audio.",
          );
        }
        const activeSession = current.activeSession;
        const expectedAudioCaptureEpoch = audioCaptureEpoch;
        let outcome: InterviewAudioProviderOutcome;

        if (
          !activeSession ||
          activeSession.id !== audioInput.sessionId ||
          !activeSession.listening
        ) {
          outcome = { status: "empty" };
        } else if (!options.transcriptionProvider.transcribeAudioChunk) {
          outcome = { status: "unavailable" };
        } else {
          try {
            const result =
              await options.transcriptionProvider.transcribeAudioChunk(
                audioInput,
              );
            outcome =
              result && containsUsableSpeech(result.text)
                ? { status: "transcribed", result }
                : { status: "empty" };
          } catch (error) {
            outcome = {
              status: "failed",
              detail: summarizeServiceError(error),
            };
          }
        }

        return enqueueWorkspaceMutation(() =>
          applyAudioProviderOutcomeInOrder({
            audioInput,
            expectedAudioCaptureEpoch,
            outcome,
          }),
        );
      });
    },
    addTranscriptAnnotation(input) {
      return enqueueWorkspaceMutation(async () => {
        const current = await loadSnapshot();
        const session = await findSession(input.sessionId);

        if (!session) {
          return current;
        }

        const referencedSegment = input.transcriptSegmentId
          ? session.transcriptSegments.find(
              (segment) => segment.id === input.transcriptSegmentId,
            )
          : null;
        const currentNow = now();
        const annotation: InterviewTranscriptAnnotation =
          InterviewTranscriptAnnotationSchema.parse({
            id: createId("transcript_annotation"),
            sessionId: session.id,
            transcriptSegmentId: referencedSegment?.id ?? null,
            kind: input.kind,
            originalText: referencedSegment?.text ?? null,
            body: input.body,
            createdAt: currentNow,
          });
        const nextSession = InterviewLiveSessionSchema.parse({
          ...session,
          transcriptAnnotations: [...session.transcriptAnnotations, annotation],
          diagnostics: [
            ...session.diagnostics,
            createDiagnostic({
              sessionId: session.id,
              kind: "lifecycle",
              severity: "info",
              label: "Transcript annotation saved",
              detail:
                annotation.transcriptSegmentId === null
                  ? "A session-level transcript note was saved without changing transcript text."
                  : "A transcript correction/note was saved without overwriting the original segment.",
              occurredAt: currentNow,
            }),
          ],
        });
        const nextSnapshot = await rebuildWorkspace({
          activeSession:
            current.activeSession?.id === session.id
              ? nextSession
              : current.activeSession,
          recentSessions: current.recentSessions.map((entry) =>
            entry.id === session.id
              ? summarizeInterviewSession(nextSession)
              : entry,
          ),
        });
        return saveSnapshot(
          nextSnapshot,
          current.activeSession?.id === session.id ? [] : [nextSession],
        );
      });
    },
    async exportSession(input) {
      const session = await findSession(input.sessionId);

      if (!session) {
        throw new Error("Interview session was not found.");
      }

      const fileBase = session.targetContext.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      return InterviewExportResultSchema.parse({
        fileName: `${fileBase || "interview-session"}.${input.format === "json" ? "json" : "md"}`,
        mimeType:
          input.format === "json" ? "application/json" : "text/markdown",
        content:
          input.format === "json"
            ? JSON.stringify(session, null, 2)
            : buildMarkdownExport(session),
      });
    },
    async close() {
      await audioProviderTail;
      await workspaceMutationTail;
      return options.repository.close();
    },
  };
}
