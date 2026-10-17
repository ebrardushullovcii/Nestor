import {
  app,
  BrowserWindow,
  desktopCapturer,
  nativeImage,
  screen,
  type Display,
  type Rectangle,
} from "electron";
import path from "node:path";
import type {
  InterviewOverlayMoveInput,
  InterviewOverlayPreference,
  InterviewOverlaySnapshot,
  InterviewProtectedSurface,
  InterviewProtectedSurfaceKind,
  InterviewWorkspaceView,
} from "@nestor/contracts";
import { getLiveAssistantService } from "../services/live-assistant";
import { resolveBrandIconPaths } from "./brand-icons";
import { resolveVisibleInterviewPopupInputMode } from "./interview-surface-mode";
import { publishLiveAssistantWorkspace } from "./publish-live-assistant-workspace";

type InterviewOverlayKind = "answer" | "transcript";
type InterviewDisplayChangeReason =
  | "display_added"
  | "display_removed"
  | "display_metrics_changed"
  | "manual_revalidation";

interface InterviewOverlayWindowEntry {
  readonly kind: InterviewOverlayKind;
  readonly route: string;
  readonly window: BrowserWindow;
}

let currentDirForOverlays: string | null = null;
let lastSnapshot: InterviewWorkspaceView | null = null;
let overlayEntries: InterviewOverlayWindowEntry[] = [];
let applyingSnapshot = false;
let overlayLayoutPersistenceChain =
  Promise.resolve<InterviewWorkspaceView | null>(null);
const overlayLayoutTimers = new WeakMap<BrowserWindow, NodeJS.Timeout>();
const programmaticOverlayCloses = new WeakSet<BrowserWindow>();
let displayRevalidationTimer: NodeJS.Timeout | null = null;
let displayRevalidationChain = Promise.resolve<InterviewWorkspaceView | null>(
  null,
);
let displayRevalidationListenersRegistered = false;

function toSurfaceKind(
  kind: InterviewOverlayKind,
): InterviewProtectedSurfaceKind {
  return kind === "answer" ? "live_answer_overlay" : "live_transcript_overlay";
}

function toWindowKind(kind: InterviewOverlayKind) {
  return kind === "answer"
    ? "interview-answer-overlay"
    : "interview-transcript-overlay";
}

function sameBounds(
  first: Rectangle,
  second: NonNullable<InterviewOverlayPreference["bounds"]>,
) {
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  );
}

function persistOverlayLayout(entry: InterviewOverlayWindowEntry) {
  if (applyingSnapshot || entry.window.isDestroyed()) {
    return;
  }

  const existingTimer = overlayLayoutTimers.get(entry.window);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    void (async () => {
      if (entry.window.isDestroyed()) {
        return;
      }

      const bounds = entry.window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      overlayLayoutPersistenceChain = overlayLayoutPersistenceChain
        .then(async () => {
          const service = await getLiveAssistantService();
          return service.updateOverlayPreference({
            surfaceKind: toSurfaceKind(entry.kind),
            bounds,
            displayId: String(display.id),
          });
        })
        .catch((error: unknown) => {
          console.warn(
            "[LiveAssistant] Failed to persist overlay layout.",
            error,
          );
          return lastSnapshot;
        });
      lastSnapshot = await overlayLayoutPersistenceChain;
    })();
  }, 250);

  overlayLayoutTimers.set(entry.window, timer);
}

function bindOverlayLayoutPersistence(entry: InterviewOverlayWindowEntry) {
  entry.window.on("move", () => {
    persistOverlayLayout(entry);
  });
  entry.window.on("resize", () => {
    persistOverlayLayout(entry);
  });
  entry.window.on("closed", () => {
    const timer = overlayLayoutTimers.get(entry.window);
    if (timer) {
      clearTimeout(timer);
    }
    overlayEntries = overlayEntries.filter((candidate) => candidate !== entry);

    if (programmaticOverlayCloses.has(entry.window)) {
      return;
    }

    overlayLayoutPersistenceChain = overlayLayoutPersistenceChain
      .then(async () => {
        const service = await getLiveAssistantService();
        const snapshot = await service.updateOverlayPreference({
          surfaceKind: toSurfaceKind(entry.kind),
          visible: false,
        });
        lastSnapshot = snapshot;
        syncInterviewOverlayWindows(snapshot);
        return snapshot;
      })
      .catch((error: unknown) => {
        console.warn(
          "[LiveAssistant] Failed to reconcile a closed popup.",
          error,
        );
        return lastSnapshot;
      });
  });
}

function createOverlayWindow(
  kind: InterviewOverlayKind,
  route: string,
): InterviewOverlayWindowEntry {
  if (!currentDirForOverlays) {
    throw new Error("Interview overlay windows were not initialized.");
  }

  const isAnswer = kind === "answer";
  const brandIcons =
    process.platform !== "darwin"
      ? resolveBrandIconPaths(app.getAppPath())
      : null;
  const window = new BrowserWindow({
    ...(brandIcons ? { icon: brandIcons.appIcon } : {}),
    width: isAnswer ? 600 : 680,
    height: isAnswer ? 640 : 460,
    minWidth: isAnswer ? 460 : 500,
    minHeight: isAnswer ? 400 : 320,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(currentDirForOverlays, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.setContentProtection(true);
  window.setIgnoreMouseEvents(true, { forward: true });
  window.setAlwaysOnTop(true, "screen-saver");
  window.removeMenu();

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(`${rendererUrl}#${route}`);
  } else {
    void window.loadFile(
      path.join(currentDirForOverlays, "../renderer/index.html"),
      {
        hash: route,
      },
    );
  }

  const entry = { kind, route, window };
  bindOverlayLayoutPersistence(entry);
  return entry;
}

function ensureOverlayEntries() {
  const liveEntries = overlayEntries.filter(
    (entry) => !entry.window.isDestroyed(),
  );
  overlayEntries = liveEntries;

  if (overlayEntries.length === 2) {
    return overlayEntries;
  }

  closeInterviewOverlayWindows();
  overlayEntries = [
    createOverlayWindow("answer", "/live-assistant/overlay/answer"),
    createOverlayWindow("transcript", "/live-assistant/overlay/transcript"),
  ];
  return overlayEntries;
}

function applyOverlaySnapshot(
  entry: InterviewOverlayWindowEntry,
  overlay: InterviewOverlaySnapshot,
  preference: InterviewOverlayPreference | undefined,
  shouldShow: boolean,
) {
  const window = entry.window;
  if (window.isDestroyed()) {
    return;
  }

  if (
    preference?.bounds &&
    !sameBounds(window.getBounds(), preference.bounds)
  ) {
    applyingSnapshot = true;
    try {
      window.setBounds(preference.bounds);
    } finally {
      applyingSnapshot = false;
    }
  }

  window.setOpacity(overlay.opacity);
  // Visible-first popup windows behave like ordinary desktop windows. Hidden,
  // click-through overlays can be reintroduced later behind an explicit mode.
  const inputMode = resolveVisibleInterviewPopupInputMode();
  window.setFocusable(inputMode.focusable);
  window.setIgnoreMouseEvents(inputMode.ignoreMouseEvents);

  if (shouldShow) {
    if (window.webContents.isLoading()) {
      window.once("ready-to-show", () => {
        if (!window.isDestroyed()) {
          window.showInactive();
        }
      });
    } else {
      window.showInactive();
    }
  } else {
    window.hide();
  }
}

export function initializeInterviewOverlayWindows(currentDir: string) {
  currentDirForOverlays = currentDir;
  registerDisplayChangeRevalidation();
}

export function syncInterviewOverlayWindows(snapshot: InterviewWorkspaceView) {
  lastSnapshot = snapshot;
  publishLiveAssistantWorkspace(snapshot, BrowserWindow.getAllWindows());
  const activeSession = snapshot.activeSession;

  if (!currentDirForOverlays) {
    closeInterviewOverlayWindows();
    return;
  }

  if (
    !activeSession ||
    activeSession.status === "ended" ||
    activeSession.status === "interrupted"
  ) {
    closeInterviewOverlayWindows();
    return;
  }

  const entries = ensureOverlayEntries();
  for (const entry of entries) {
    const overlay =
      entry.kind === "answer"
        ? snapshot.answerOverlay
        : snapshot.transcriptOverlay;
    const preference = snapshot.overlayPreferences.find(
      (item) => item.surfaceKind === toSurfaceKind(entry.kind),
    );
    applyOverlaySnapshot(entry, overlay, preference, overlay.visible);
  }
}

export function moveInterviewOverlayWindow(input: InterviewOverlayMoveInput) {
  const entry = overlayEntries.find(
    (candidate) => toSurfaceKind(candidate.kind) === input.surfaceKind,
  );
  if (!entry || entry.window.isDestroyed()) {
    return { moved: false };
  }

  const bounds = entry.window.getBounds();
  entry.window.setBounds({
    ...bounds,
    x: bounds.x + input.deltaX,
    y: bounds.y + input.deltaY,
  });
  persistOverlayLayout(entry);

  return { moved: true };
}

export function closeInterviewOverlayWindows() {
  for (const entry of overlayEntries) {
    if (!entry.window.isDestroyed()) {
      const timer = overlayLayoutTimers.get(entry.window);
      if (timer) {
        clearTimeout(timer);
      }
      programmaticOverlayCloses.add(entry.window);
      entry.window.close();
    }
  }
  overlayEntries = [];
}

export function resyncInterviewOverlayWindows() {
  if (lastSnapshot) {
    syncInterviewOverlayWindows(lastSnapshot);
  }
}

function hasActiveOverlaySession() {
  const session = lastSnapshot?.activeSession;
  return Boolean(
    session &&
    session.status !== "ended" &&
    session.status !== "interrupted" &&
    overlayEntries.some((entry) => !entry.window.isDestroyed()),
  );
}

function summarizeUnknownError(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "Unknown display revalidation failure";
}

function describeDisplayChange(
  reason: InterviewDisplayChangeReason,
  display: Display | null,
  changedMetrics: readonly string[] = [],
) {
  const displayLabel = display ? `display ${display.id}` : "display topology";
  const metrics =
    changedMetrics.length > 0 ? ` (${changedMetrics.join(", ")})` : "";
  return `${displayLabel} changed${metrics}; overlay protection evidence is being revalidated.`;
}

export async function revalidateInterviewOverlayProtectionAfterDisplayChange(input: {
  reason: InterviewDisplayChangeReason;
  detail?: string | null;
}) {
  if (!hasActiveOverlaySession()) {
    return lastSnapshot;
  }

  const service = await getLiveAssistantService();
  const marked = await service.recordDisplayChange(
    input.detail === undefined
      ? { reason: input.reason }
      : {
          reason: input.reason,
          detail: input.detail,
        },
  );
  syncInterviewOverlayWindows(marked);

  try {
    const protectedSurfaces = await verifyInterviewOverlayCaptureProtection();
    const verified = await service.recordProtectedSurfaceVerification({
      protectedSurfaces,
    });
    syncInterviewOverlayWindows(verified);
    return verified;
  } catch (error) {
    const failed = await service.recordDisplayChange({
      reason: input.reason,
      detail: `${input.detail ?? "Display topology changed."} Revalidation failed: ${summarizeUnknownError(error)}`,
    });
    syncInterviewOverlayWindows(failed);
    return failed;
  }
}

function scheduleDisplayChangeRevalidation(input: {
  reason: InterviewDisplayChangeReason;
  detail: string;
}) {
  if (displayRevalidationTimer) {
    clearTimeout(displayRevalidationTimer);
  }

  displayRevalidationTimer = setTimeout(() => {
    displayRevalidationChain = displayRevalidationChain
      .then(() =>
        revalidateInterviewOverlayProtectionAfterDisplayChange({
          reason: input.reason,
          detail: input.detail,
        }),
      )
      .catch((error: unknown) => {
        console.warn(
          "[LiveAssistant] Failed to revalidate overlay protection after display change.",
          error,
        );
        return lastSnapshot;
      });
  }, 500);
}

function registerDisplayChangeRevalidation() {
  if (displayRevalidationListenersRegistered) {
    return;
  }

  displayRevalidationListenersRegistered = true;
  screen.on("display-added", (_event, display) => {
    scheduleDisplayChangeRevalidation({
      reason: "display_added",
      detail: describeDisplayChange("display_added", display),
    });
  });
  screen.on("display-removed", (_event, display) => {
    scheduleDisplayChangeRevalidation({
      reason: "display_removed",
      detail: describeDisplayChange("display_removed", display),
    });
  });
  screen.on("display-metrics-changed", (_event, display, changedMetrics) => {
    scheduleDisplayChangeRevalidation({
      reason: "display_metrics_changed",
      detail: describeDisplayChange(
        "display_metrics_changed",
        display,
        changedMetrics,
      ),
    });
  });
}

function getPixel(bitmap: Buffer, width: number, x: number, y: number) {
  const index = (y * width + x) * 4;
  return [
    bitmap[index] ?? 0,
    bitmap[index + 1] ?? 0,
    bitmap[index + 2] ?? 0,
    bitmap[index + 3] ?? 255,
  ] as const;
}

function brightness(pixel: readonly number[]) {
  return (pixel[0]! + pixel[1]! + pixel[2]!) / 3;
}

export async function verifyInterviewOverlayCaptureProtection(): Promise<
  InterviewProtectedSurface[]
> {
  const entries = overlayEntries.filter((entry) => !entry.window.isDestroyed());
  if (entries.length === 0) {
    throw new Error("Interview overlay windows are not active.");
  }

  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: display.size,
  });
  const source = sources[0];
  if (!source) {
    throw new Error("No screen sources were returned by desktopCapturer.");
  }

  const capturedAt = new Date().toISOString();
  const screenImage = source.thumbnail;
  const screenBitmap = screenImage.toBitmap();
  const screenSize = screenImage.getSize();
  const scaleX = screenSize.width / display.bounds.width;
  const scaleY = screenSize.height / display.bounds.height;

  const surfaces: InterviewProtectedSurface[] = [];
  for (const entry of entries) {
    const bounds = entry.window.getBounds();
    const overlayImage = await entry.window.webContents.capturePage();
    const resizedOverlay = nativeImage
      .createFromBuffer(overlayImage.toPNG())
      .resize({
        width: Math.round(bounds.width * scaleX),
        height: Math.round(bounds.height * scaleY),
      });
    const overlayBitmap = resizedOverlay.toBitmap();
    const overlaySize = resizedOverlay.getSize();
    const cropOriginX = Math.max(0, Math.round(bounds.x * scaleX));
    const cropOriginY = Math.max(0, Math.round(bounds.y * scaleY));
    let comparedPixels = 0;
    let similarPixels = 0;
    let overlaySignalPixels = 0;
    let screenSignalPixels = 0;
    const step = 2;

    for (let y = 0; y < overlaySize.height; y += step) {
      const screenY = cropOriginY + y;
      if (screenY < 0 || screenY >= screenSize.height) continue;
      for (let x = 0; x < overlaySize.width; x += step) {
        const screenX = cropOriginX + x;
        if (screenX < 0 || screenX >= screenSize.width) continue;
        const overlayPixel = getPixel(overlayBitmap, overlaySize.width, x, y);
        const screenPixel = getPixel(
          screenBitmap,
          screenSize.width,
          screenX,
          screenY,
        );
        const overlayIsSignal =
          overlayPixel[3] > 180 && brightness(overlayPixel) > 52;
        if (!overlayIsSignal) continue;

        overlaySignalPixels += 1;
        if (brightness(screenPixel) > 52) {
          screenSignalPixels += 1;
        }
        comparedPixels += 1;

        const delta =
          Math.abs(overlayPixel[0] - screenPixel[0]) +
          Math.abs(overlayPixel[1] - screenPixel[1]) +
          Math.abs(overlayPixel[2] - screenPixel[2]);

        if (delta <= 72) {
          similarPixels += 1;
        }
      }
    }

    const similarRatio =
      comparedPixels > 0 ? similarPixels / comparedPixels : 1;
    const signalRatio =
      overlaySignalPixels > 0 ? screenSignalPixels / overlaySignalPixels : 1;
    const overlayVisibleInScreenCapture =
      similarRatio >= 0.08 && signalRatio >= 0.12;
    const surfaceKind = toSurfaceKind(entry.kind);
    surfaces.push({
      id: `${surfaceKind}_${toWindowKind(entry.kind)}`,
      kind: surfaceKind,
      requestedPolicy: "screen_share_private",
      protectionState: overlayVisibleInScreenCapture
        ? "failed"
        : "verified_protected",
      verificationMethod:
        "electron-desktopCapturer-screen-thumbnail-vs-overlay-window-pixels",
      displayLabel: source.name || `Display ${display.id}`,
      detail: overlayVisibleInScreenCapture
        ? `Overlay pixels were detected in ordinary Electron screen capture (${similarRatio.toFixed(3)} similar, ${signalRatio.toFixed(3)} signal). Meeting-app-specific exclusion is not verified.`
        : `Overlay pixels were not detected in ordinary Electron screen capture (${similarRatio.toFixed(3)} similar, ${signalRatio.toFixed(3)} signal). Meeting-app-specific exclusion is not verified.`,
      lastVerifiedAt: capturedAt,
    });
  }

  return surfaces;
}
