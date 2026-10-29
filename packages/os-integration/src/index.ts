export const osIntegrationPackageReady = true;

export { unprotectWindowsCurrentUserData } from "./windows-dpapi";

export const appWindowKinds = [
  "main",
  "interview-panel",
  "interview-overlay",
  "interview-answer-overlay",
  "interview-transcript-overlay",
] as const;
export type AppWindowKind = (typeof appWindowKinds)[number];

export const overlayPresentationModes = [
  "hidden",
  "compact",
  "expanded",
] as const;
export type OverlayPresentationMode = (typeof overlayPresentationModes)[number];

export const capturePolicyModes = [
  "default",
  "screen-share-private",
  "platform-protected",
] as const;
export type CapturePolicyMode = (typeof capturePolicyModes)[number];

export const protectedOverlaySurfaceKinds = [
  "live-answer-overlay",
  "live-transcript-overlay",
] as const;
export type ProtectedOverlaySurfaceKind =
  (typeof protectedOverlaySurfaceKinds)[number];

export const captureProtectionStates = [
  "verified_protected",
  "requested_unverified",
  "best_effort",
  "unsupported",
  "failed",
  "unknown",
] as const;
export type CaptureProtectionState = (typeof captureProtectionStates)[number];

export const desktopCaptureCapabilityStates = [
  "available",
  "degraded",
  "unavailable",
  "unsupported",
  "permission_denied",
  "unknown",
] as const;
export type DesktopCaptureCapabilityState =
  (typeof desktopCaptureCapabilityStates)[number];

export const interviewSessionHotkeyActions = [
  "toggle_listening",
  "force_cue",
  "capture_screenshot",
  "capture_screenshot_and_force_cue",
  "toggle_answer_overlay",
  "toggle_transcript_overlay",
  "toggle_overlay_interaction_mode",
  "panic_hide",
  "end_session",
] as const;
export type InterviewSessionHotkeyAction =
  (typeof interviewSessionHotkeyActions)[number];

export interface OverlayWindowState {
  readonly kind:
    | "interview-overlay"
    | "interview-answer-overlay"
    | "interview-transcript-overlay";
  readonly mode: OverlayPresentationMode;
  readonly visible: boolean;
  readonly alwaysOnTop: boolean;
  readonly focusable: boolean;
  readonly ignoreMouseEvents: boolean;
  readonly opacity?: number;
  readonly capturePolicy?: CapturePolicyMode;
}

export interface OverlayWindowController {
  ensureWindow(kind: AppWindowKind): Promise<void>;
  syncOverlayWindow(state: OverlayWindowState): Promise<void>;
  closeWindow(kind: AppWindowKind): Promise<void>;
}

export interface WindowPolicyAdapter {
  setAlwaysOnTop(input: { kind: AppWindowKind; value: boolean }): Promise<void>;
  setFocusable(input: { kind: AppWindowKind; value: boolean }): Promise<void>;
  setIgnoreMouseEvents(input: {
    kind: AppWindowKind;
    value: boolean;
  }): Promise<void>;
}

export interface CapturePolicyAdapter {
  setCapturePolicy(input: {
    kind: AppWindowKind;
    mode: CapturePolicyMode;
  }): Promise<void>;
}

export interface GlobalShortcutAdapter {
  registerShortcut(accelerator: string, actionId: string): Promise<void>;
  unregisterShortcut(accelerator: string): Promise<void>;
}

export interface ProtectedOverlaySurfaceState {
  readonly id: string;
  readonly kind: ProtectedOverlaySurfaceKind;
  readonly windowKind: AppWindowKind;
  readonly requestedPolicy: CapturePolicyMode;
  readonly protectionState: CaptureProtectionState;
  readonly verificationMethod: string | null;
  readonly detail: string | null;
  readonly lastVerifiedAt: string | null;
}

export interface ProtectedOverlaySurfaceAdapter {
  requestProtection(input: {
    surface: ProtectedOverlaySurfaceKind;
    windowKind: AppWindowKind;
    policy: CapturePolicyMode;
  }): Promise<ProtectedOverlaySurfaceState>;
  verifyProtection(input: {
    surface: ProtectedOverlaySurfaceKind;
    windowKind: AppWindowKind;
  }): Promise<ProtectedOverlaySurfaceState>;
}

export interface DesktopAudioCaptureCapability {
  readonly source: "microphone" | "meeting-audio";
  readonly status: DesktopCaptureCapabilityState;
  readonly label: string;
  readonly detail: string | null;
}

export interface DesktopAudioCaptureAdapter {
  checkAudioCapture(): Promise<readonly DesktopAudioCaptureCapability[]>;
}

export interface DesktopScreenshotCaptureResult {
  readonly id: string;
  readonly status: DesktopCaptureCapabilityState;
  readonly screenshotCount: number;
  readonly overlayContaminated: boolean;
  readonly images?: ReadonlyArray<{
    readonly mimeType: string;
    readonly base64: string;
  }>;
  readonly detail: string | null;
  readonly capturedAt: string;
}

export interface DesktopScreenshotCaptureAdapter {
  captureInterviewRegion(input: {
    reason:
      | "queued_visual_batch"
      | "capture_and_force_cue"
      | "automatic_cue"
      | "rehearsal";
  }): Promise<DesktopScreenshotCaptureResult>;
}

export interface InterviewTrayActionAdapter {
  setSessionActions(input: {
    enabled: boolean;
    actions: ReadonlyArray<{
      id: InterviewSessionHotkeyAction;
      label: string;
    }>;
  }): Promise<void>;
}

export function createStaticProtectedOverlaySurfaceAdapter(input: {
  platform: NodeJS.Platform;
  now?: () => string;
}): ProtectedOverlaySurfaceAdapter {
  const now = input.now ?? (() => new Date().toISOString());

  function buildState(
    surface: ProtectedOverlaySurfaceKind,
    windowKind: AppWindowKind,
    requestedPolicy: CapturePolicyMode,
  ): ProtectedOverlaySurfaceState {
    const supported = input.platform === "win32" || input.platform === "darwin";
    return {
      id: `${surface}_${windowKind}`,
      kind: surface,
      windowKind,
      requestedPolicy,
      protectionState: supported ? "requested_unverified" : "unsupported",
      verificationMethod: supported
        ? "electron-content-protection-request"
        : "platform-capability-static-check",
      detail: supported
        ? "Capture protection was requested. Full meeting-app exclusion still requires platform or authorized integration verification."
        : "This platform does not expose a verified protected-overlay capability through the current adapter.",
      lastVerifiedAt: now(),
    };
  }

  return {
    requestProtection(request) {
      return Promise.resolve(
        buildState(request.surface, request.windowKind, request.policy),
      );
    },
    verifyProtection(request) {
      return Promise.resolve(
        buildState(request.surface, request.windowKind, "screen-share-private"),
      );
    },
  };
}

export function createStaticDesktopAudioCaptureAdapter(
  platform: NodeJS.Platform,
): DesktopAudioCaptureAdapter {
  return {
    checkAudioCapture() {
      const meetingDetail =
        platform === "linux"
          ? "PipeWire/PulseAudio monitor-source capture must be verified on the target Linux desktop."
          : platform === "darwin"
            ? "macOS system audio usually needs ScreenCaptureKit permission or an approved audio device path."
            : "Windows meeting/system audio should use an approved loopback or Chromium capture path when available.";
      return Promise.resolve([
        {
          source: "microphone",
          status: "available",
          label: "Microphone input",
          detail:
            "Microphone capture is exposed to the renderer through standard desktop media permissions and must be confirmed in rehearsal.",
        },
        {
          source: "meeting-audio",
          status: "degraded",
          label: "Meeting/system audio",
          detail: meetingDetail,
        },
      ] as const);
    },
  };
}

export function createStaticDesktopScreenshotCaptureAdapter(
  input: {
    now?: () => string;
  } = {},
): DesktopScreenshotCaptureAdapter {
  const now = input.now ?? (() => new Date().toISOString());
  return {
    captureInterviewRegion(request) {
      return Promise.resolve({
        id: `interview_screenshot_${Date.now()}`,
        status: "available",
        screenshotCount: 1,
        overlayContaminated: true,
        detail:
          request.reason === "rehearsal"
            ? "Deterministic rehearsal capture succeeded. Overlay exclusion is not verified in this static adapter."
            : "Screenshot context was captured with possible overlay contamination and will be disclosed to the cue provider.",
        capturedAt: now(),
      });
    },
  };
}
