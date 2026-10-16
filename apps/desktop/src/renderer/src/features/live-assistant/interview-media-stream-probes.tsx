import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, Monitor, Radio } from "lucide-react";
import type {
  InterviewTranscriptSource,
  InterviewWorkspaceView,
} from "@nordri/contracts";
import { Button } from "@renderer/components/ui/button";
import {
  createInterviewAudioChunkQueue,
  isInterviewAudioChunkQueueDropError,
} from "./interview-audio-chunk-queue";
import { InterviewHealthPanel } from "./interview-health-panel";
import { deriveInterviewHealthSummary } from "./interview-health-summary";

export type ProbeStatus =
  | "idle"
  | "checking"
  | "available"
  | "unavailable"
  | "failed";
export type CaptureStatus =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "failed";
const MIN_AUDIO_CHUNK_BYTES = 2048;
const MIN_AUDIO_CHUNK_DURATION_MS = 2000;
const AUDIO_SIGNAL_THRESHOLD = 0.015;
const RECORDER_CHUNK_INTERVAL_MS = 5000;

interface BrowserSpeechAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): BrowserSpeechAlternative;
}

interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  item(index: number): BrowserSpeechRecognitionResult;
}

interface BrowserSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: BrowserSpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

interface BrowserSpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
}

function describeStatus(status: ProbeStatus, detail: string) {
  if (status === "idle") {
    return detail;
  }

  return `${status}: ${detail}`;
}

function getBrowserSpeechRecognitionConstructor() {
  const speechWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };

  return (
    speechWindow.SpeechRecognition ??
    speechWindow.webkitSpeechRecognition ??
    null
  );
}

function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

async function measureAudioSignal(stream: MediaStream) {
  const AudioContextConstructor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextConstructor || stream.getAudioTracks().length === 0) {
    return null;
  }

  const audioContext = new AudioContextConstructor();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const samples = new Uint8Array(analyser.fftSize);
  let peak = 0;

  try {
    for (let sampleIndex = 0; sampleIndex < 18; sampleIndex += 1) {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      peak = Math.max(peak, Math.sqrt(sum / samples.length));
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
  } finally {
    source.disconnect();
    await audioContext.close();
  }

  return peak;
}

function toBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return window.btoa(binary);
}

function selectSupportedAudioMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];

  return (
    candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ??
    ""
  );
}

function getAudioSourceLabel(
  source: Extract<InterviewTranscriptSource, "microphone" | "meeting_audio">,
) {
  return source === "microphone" ? "Mic audio" : "System audio";
}

export function InterviewMediaStreamProbes(props: {
  sessionId?: string;
  language: string;
  listening: boolean;
  audioTranscriptionAvailable: boolean;
  microphoneCaptureAllowed: boolean;
  meetingAudioCaptureAllowed: boolean;
  onWorkspaceChange?: (workspace: InterviewWorkspaceView) => void;
  workspace?: InterviewWorkspaceView;
}) {
  const [microphoneStatus, setMicrophoneStatus] = useState<ProbeStatus>("idle");
  const [microphoneDetail, setMicrophoneDetail] = useState("Not checked yet.");
  const [displayStatus, setDisplayStatus] = useState<ProbeStatus>("idle");
  const [displayDetail, setDisplayDetail] = useState("Not checked yet.");
  const [captionEnabled, setCaptionEnabled] = useState(false);
  const [captionStatus, setCaptionStatus] = useState<CaptureStatus>("idle");
  const [captionDetail, setCaptionDetail] = useState("Mic captions are off.");
  const [captionPreview, setCaptionPreview] = useState("");
  const [microphoneRecorderStatus, setMicrophoneRecorderStatus] =
    useState<CaptureStatus>("idle");
  const [microphoneRecorderDetail, setMicrophoneRecorderDetail] = useState(
    props.audioTranscriptionAvailable
      ? "Mic audio transcription is off."
      : "Mic audio transcription is unavailable. Set up speech-to-text first.",
  );
  const [systemRecorderStatus, setSystemRecorderStatus] =
    useState<CaptureStatus>("idle");
  const [systemRecorderDetail, setSystemRecorderDetail] = useState(
    props.audioTranscriptionAvailable
      ? "System audio transcription is off."
      : "System audio transcription is unavailable. Set up speech-to-text first.",
  );
  const [activeMicrophoneRecorder, setActiveMicrophoneRecorder] = useState<{
    recorder: MediaRecorder;
    stream: MediaStream;
    startedAt: string;
  } | null>(null);
  const [activeSystemRecorder, setActiveSystemRecorder] = useState<{
    recorder: MediaRecorder;
    stream: MediaStream;
    startedAt: string;
  } | null>(null);
  const activeMicrophoneRecorderRef =
    useRef<typeof activeMicrophoneRecorder>(null);
  const activeSystemRecorderRef = useRef<typeof activeSystemRecorder>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const sessionIdRef = useRef(props.sessionId ?? null);
  const workspaceChangeRef = useRef(props.onWorkspaceChange);
  const languageRef = useRef(props.language);
  const listeningRef = useRef(props.listening);
  const captionEnabledRef = useRef(captionEnabled);
  const recognitionRunIdRef = useRef("");
  const acceptingAudioChunksRef = useRef(true);
  const captureLifecycleVersionRef = useRef(0);
  const audioChunkQueueRef = useRef(createInterviewAudioChunkQueue());
  const [audioQueueSnapshot, setAudioQueueSnapshot] = useState(() =>
    audioChunkQueueRef.current.getSnapshot(),
  );

  const refreshAudioQueueSnapshot = useCallback(() => {
    setAudioQueueSnapshot(audioChunkQueueRef.current.getSnapshot());
  }, []);

  useEffect(() => {
    activeMicrophoneRecorderRef.current = activeMicrophoneRecorder;
  }, [activeMicrophoneRecorder]);

  useEffect(() => {
    activeSystemRecorderRef.current = activeSystemRecorder;
  }, [activeSystemRecorder]);

  useEffect(() => {
    const nextSessionId = props.sessionId ?? null;
    if (sessionIdRef.current !== nextSessionId) {
      captureLifecycleVersionRef.current += 1;
      sessionIdRef.current = nextSessionId;
    }
  }, [props.sessionId]);

  useEffect(() => {
    workspaceChangeRef.current = props.onWorkspaceChange;
  }, [props.onWorkspaceChange]);

  useEffect(() => {
    languageRef.current = props.language;
  }, [props.language]);

  useEffect(() => {
    if (listeningRef.current && !props.listening) {
      captureLifecycleVersionRef.current += 1;
    }
    listeningRef.current = props.listening;
  }, [props.listening]);

  useEffect(() => {
    captionEnabledRef.current = captionEnabled;
  }, [captionEnabled]);

  useEffect(() => {
    if (!props.audioTranscriptionAvailable && !activeMicrophoneRecorder) {
      setMicrophoneRecorderDetail(
        "Mic audio transcription is unavailable. Set up speech-to-text first.",
      );
    }

    if (!props.audioTranscriptionAvailable && !activeSystemRecorder) {
      setSystemRecorderDetail(
        "System audio transcription is unavailable. Set up speech-to-text first.",
      );
    }
  }, [
    activeMicrophoneRecorder,
    activeSystemRecorder,
    props.audioTranscriptionAvailable,
  ]);

  useEffect(() => {
    if (props.listening) {
      return;
    }

    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setCaptionStatus(captionEnabled ? "idle" : "stopping");
      setCaptionDetail(
        captionEnabled ? "Mic captions paused." : "Stopping mic captions.",
      );
    }

    const microphoneRecorder = activeMicrophoneRecorderRef.current;
    if (
      microphoneRecorder &&
      microphoneRecorder.recorder.state !== "inactive"
    ) {
      setMicrophoneRecorderStatus("stopping");
      setMicrophoneRecorderDetail(
        "Stopping mic audio while the session is paused.",
      );
      microphoneRecorder.recorder.stop();
    }

    const systemRecorder = activeSystemRecorderRef.current;
    if (systemRecorder && systemRecorder.recorder.state !== "inactive") {
      setSystemRecorderStatus("stopping");
      setSystemRecorderDetail(
        "Stopping system audio while the session is paused.",
      );
      systemRecorder.recorder.stop();
    }

    audioChunkQueueRef.current.cancelPending(
      "The session was paused before this audio chunk was transcribed.",
    );
    refreshAudioQueueSnapshot();
  }, [captionEnabled, props.listening, refreshAudioQueueSnapshot]);

  useEffect(() => {
    if (props.listening && captionEnabled && !recognitionRef.current) {
      const restart = window.setTimeout(() => {
        startMicCaptions();
      }, 0);
      return () => window.clearTimeout(restart);
    }

    return undefined;
  }, [captionEnabled, props.listening]);

  useEffect(() => {
    return () => {
      acceptingAudioChunksRef.current = false;
      captureLifecycleVersionRef.current += 1;
      audioChunkQueueRef.current.cancelPending(
        "Audio capture closed before this chunk was transcribed.",
      );
      recognitionRef.current?.abort();
      recognitionRef.current = null;

      for (const recorderState of [
        activeMicrophoneRecorderRef.current,
        activeSystemRecorderRef.current,
      ]) {
        if (!recorderState) {
          continue;
        }

        if (recorderState.recorder.state !== "inactive") {
          recorderState.recorder.stop();
        } else {
          stopStream(recorderState.stream);
        }
      }
    };
  }, []);

  async function checkMicrophoneStream() {
    if (!props.microphoneCaptureAllowed) {
      setMicrophoneStatus("unavailable");
      setMicrophoneDetail(
        "Enable microphone capture in setup before testing it.",
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneStatus("unavailable");
      setMicrophoneDetail(
        "navigator.mediaDevices.getUserMedia is unavailable.",
      );
      return;
    }

    setMicrophoneStatus("checking");
    setMicrophoneDetail("Requesting a temporary microphone stream.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      const audioTracks = stream.getAudioTracks();
      const signalLevel = await measureAudioSignal(stream);
      const signalText =
        signalLevel === null
          ? "Audio level could not be measured."
          : signalLevel >= AUDIO_SIGNAL_THRESHOLD
            ? `Input signal detected (${signalLevel.toFixed(3)} peak).`
            : `No input signal detected (${signalLevel.toFixed(3)} peak); speak while testing.`;
      setMicrophoneStatus(audioTracks.length > 0 ? "available" : "unavailable");
      setMicrophoneDetail(
        audioTracks.length > 0
          ? `Temporary microphone stream opened with ${audioTracks.length} audio track${audioTracks.length === 1 ? "" : "s"} and was immediately stopped. ${signalText}`
          : "Temporary microphone stream opened without audio tracks.",
      );
      stopStream(stream);
    } catch (error) {
      setMicrophoneStatus("failed");
      setMicrophoneDetail(
        error instanceof Error
          ? error.message
          : "Microphone stream check failed.",
      );
    }
  }

  async function checkDisplayAudioStream() {
    if (!props.meetingAudioCaptureAllowed) {
      setDisplayStatus("unavailable");
      setDisplayDetail(
        "Enable system-audio capture in setup before testing it.",
      );
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setDisplayStatus("unavailable");
      setDisplayDetail(
        "navigator.mediaDevices.getDisplayMedia is unavailable.",
      );
      return;
    }

    setDisplayStatus("checking");
    setDisplayDetail("Requesting a temporary screen/system audio stream.");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      const audioTracks = stream.getAudioTracks();
      const signalLevel = await measureAudioSignal(stream);
      const signalText =
        signalLevel === null
          ? "Audio level could not be measured."
          : signalLevel >= AUDIO_SIGNAL_THRESHOLD
            ? `System audio signal detected (${signalLevel.toFixed(3)} peak).`
            : `No system audio signal detected (${signalLevel.toFixed(3)} peak); play audio while testing.`;
      setDisplayStatus(audioTracks.length > 0 ? "available" : "unavailable");
      setDisplayDetail(
        audioTracks.length > 0
          ? `Temporary display stream exposed ${audioTracks.length} audio track${audioTracks.length === 1 ? "" : "s"} and was immediately stopped. ${signalText}`
          : "Display capture completed, but no system audio track was exposed.",
      );
      stopStream(stream);
    } catch (error) {
      setDisplayStatus("failed");
      setDisplayDetail(
        error instanceof Error
          ? error.message
          : "Display/system audio stream check failed.",
      );
    }
  }

  function stopMicCaptions() {
    setCaptionEnabled(false);
    setCaptionStatus("stopping");
    setCaptionDetail("Stopping mic captions.");
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }

  function startMicCaptions() {
    if (!props.listening) {
      setCaptionStatus("failed");
      setCaptionDetail("Resume listening before starting mic captions.");
      return;
    }

    const SpeechRecognitionConstructor =
      getBrowserSpeechRecognitionConstructor();
    if (!SpeechRecognitionConstructor) {
      setCaptionStatus("failed");
      setCaptionDetail(
        "Audio test unavailable. Your browser does not support speech recognition.",
      );
      return;
    }

    const recognition = new SpeechRecognitionConstructor();
    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    recognitionRunIdRef.current = runId;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = languageRef.current;
    recognition.onresult = (event) => {
      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results.item(index);
        const alternative = result.item(0);
        const text = alternative.transcript.trim();
        if (text.length === 0) {
          continue;
        }

        setCaptionPreview(text);

        if (!sessionIdRef.current || !workspaceChangeRef.current) {
          setCaptionDetail(
            "Mic captions heard you. Preview is not saved until a session is running.",
          );
          continue;
        }

        void window.nordri.liveAssistant
          .addTranscriptSegment({
            sessionId: sessionIdRef.current,
            transcriptSegmentId: `browser_speech_${sessionIdRef.current}_${recognitionRunIdRef.current}_${index}`,
            source: "microphone",
            state: result.isFinal ? "final" : "stable_partial",
            text,
            language: languageRef.current,
            confidence: Number.isFinite(alternative.confidence)
              ? alternative.confidence
              : null,
            engineKind: "browser_speech",
          })
          .then(workspaceChangeRef.current);
      }
    };
    recognition.onerror = (event) => {
      setCaptionStatus("failed");
      setCaptionDetail(event.message || `Mic captions ${event.error}.`);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      if (captionEnabledRef.current && listeningRef.current) {
        startMicCaptions();
      } else {
        setCaptionStatus("idle");
        setCaptionDetail(
          captionEnabledRef.current
            ? "Mic captions paused."
            : "Mic captions are off.",
        );
      }
    };

    recognitionRef.current = recognition;
    setCaptionEnabled(true);
    setCaptionStatus("recording");
    setCaptionPreview("");
    setCaptionDetail(
      props.sessionId
        ? "Mic captions listening. Speak and watch the visible transcript."
        : "Mic captions listening. Speak and watch the preview here.",
    );

    try {
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setCaptionEnabled(false);
      setCaptionStatus("failed");
      setCaptionDetail(
        error instanceof Error
          ? error.message
          : "Mic captions failed to start.",
      );
    }
  }

  async function createMicrophoneRecorderStream() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("navigator.mediaDevices.getUserMedia is unavailable.");
    }

    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
  }

  async function createSystemAudioRecorderStream() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("navigator.mediaDevices.getDisplayMedia is unavailable.");
    }

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });
    const audioTracks = displayStream.getAudioTracks();
    for (const track of displayStream.getVideoTracks()) {
      track.stop();
    }

    if (audioTracks.length === 0) {
      stopStream(displayStream);
      throw new Error("Display capture did not expose a system audio track.");
    }

    return new MediaStream(audioTracks);
  }

  function setRecorderStatus(
    source: Extract<InterviewTranscriptSource, "microphone" | "meeting_audio">,
    status: CaptureStatus,
  ) {
    if (source === "microphone") {
      setMicrophoneRecorderStatus(status);
      return;
    }

    setSystemRecorderStatus(status);
  }

  function setRecorderDetail(
    source: Extract<InterviewTranscriptSource, "microphone" | "meeting_audio">,
    detail: string,
  ) {
    if (source === "microphone") {
      setMicrophoneRecorderDetail(detail);
      return;
    }

    setSystemRecorderDetail(detail);
  }

  function setActiveRecorderState(
    source: Extract<InterviewTranscriptSource, "microphone" | "meeting_audio">,
    recorderState: {
      recorder: MediaRecorder;
      stream: MediaStream;
      startedAt: string;
    } | null,
  ) {
    if (source === "microphone") {
      setActiveMicrophoneRecorder(recorderState);
      return;
    }

    setActiveSystemRecorder(recorderState);
  }

  async function startAudioTranscription(
    source: Extract<InterviewTranscriptSource, "microphone" | "meeting_audio">,
  ) {
    const sourceLabel = getAudioSourceLabel(source);
    const captureAllowed =
      source === "microphone"
        ? props.microphoneCaptureAllowed
        : props.meetingAudioCaptureAllowed;

    if (!captureAllowed) {
      setRecorderStatus(source, "failed");
      setRecorderDetail(
        source,
        `Enable ${source === "microphone" ? "microphone" : "system-audio"} capture in setup before starting ${sourceLabel.toLowerCase()}.`,
      );
      return;
    }

    if (!props.listening) {
      setRecorderStatus(source, "failed");
      setRecorderDetail(
        source,
        `Resume listening before starting ${sourceLabel.toLowerCase()}.`,
      );
      return;
    }

    if (!props.audioTranscriptionAvailable) {
      setRecorderStatus(source, "failed");
      setRecorderDetail(
        source,
        `${sourceLabel} transcription is unavailable. Set up speech-to-text first.`,
      );
      return;
    }

    if (!props.sessionId || !props.onWorkspaceChange) {
      setRecorderStatus(source, "failed");
      setRecorderDetail(
        source,
        `Start a session before recording ${sourceLabel.toLowerCase()} transcription.`,
      );
      return;
    }

    const sessionId = props.sessionId;
    const onWorkspaceChange = props.onWorkspaceChange;
    const captureLifecycleVersion = captureLifecycleVersionRef.current;

    if (!("MediaRecorder" in window)) {
      setRecorderStatus(source, "failed");
      setRecorderDetail(source, "Audio test unavailable.");
      return;
    }

    setRecorderStatus(source, "starting");
    setRecorderDetail(
      source,
      `Requesting ${sourceLabel.toLowerCase()} for transient transcription.`,
    );

    let acquiredStream: MediaStream | null = null;
    try {
      const stream =
        source === "microphone"
          ? await createMicrophoneRecorderStream()
          : await createSystemAudioRecorderStream();
      acquiredStream = stream;
      if (
        !acceptingAudioChunksRef.current ||
        !listeningRef.current ||
        sessionIdRef.current !== sessionId ||
        captureLifecycleVersionRef.current !== captureLifecycleVersion
      ) {
        stopStream(stream);
        acquiredStream = null;
        if (acceptingAudioChunksRef.current) {
          setRecorderStatus(source, "idle");
          setRecorderDetail(
            source,
            `${sourceLabel} start was cancelled because capture paused or the session changed.`,
          );
        }
        return;
      }
      const mimeType = selectSupportedAudioMimeType();
      const startedAt = new Date().toISOString();
      let stoppedByFailure = false;
      let consecutiveTranscriptionFailures = 0;
      const handledFailureDiagnosticIds = new Set<string>();
      let currentRecorder: MediaRecorder | null = null;
      let cycleTimer: number | null = null;

      function enqueueCapturedChunk(
        chunk: Blob,
        currentChunkStartedAt: string,
        chunkEndedAt: string,
      ) {
        if (!acceptingAudioChunksRef.current || !listeningRef.current) {
          return;
        }

        const chunkDurationMs =
          Date.parse(chunkEndedAt) - Date.parse(currentChunkStartedAt);
        if (chunkDurationMs < MIN_AUDIO_CHUNK_DURATION_MS) {
          setRecorderDetail(
            source,
            `${sourceLabel} is recording; a short trailing fragment was discarded.`,
          );
          return;
        }

        if (chunk.size < MIN_AUDIO_CHUNK_BYTES) {
          setRecorderDetail(
            source,
            `${sourceLabel} is recording; waiting for a usable audio chunk.`,
          );
          return;
        }

        if (stoppedByFailure) {
          return;
        }

        const queuedTranscription = audioChunkQueueRef.current
          .enqueue(async () => {
            const buffer = await chunk.arrayBuffer();
            const workspace =
              await window.nordri.liveAssistant.transcribeAudioChunk({
                sessionId,
                source,
                mimeType: chunk.type || mimeType || "audio/webm",
                audioBase64: toBase64(buffer),
                startedAt: currentChunkStartedAt,
                endedAt: chunkEndedAt,
                language: languageRef.current,
              });
            onWorkspaceChange(workspace);
            const savedSpeech =
              workspace.activeSession?.transcriptSegments.some(
                (segment) =>
                  segment.source === source && segment.endedAt === chunkEndedAt,
              ) ?? false;
            setRecorderDetail(
              source,
              savedSpeech
                ? `${sourceLabel} chunk transcribed into the live transcript.`
                : `${sourceLabel} chunk processed; no speech was detected.`,
            );
            const latestDiagnostic =
              workspace.activeSession?.diagnostics.at(-1);
            if (
              (latestDiagnostic?.label === "Audio transcription failed" ||
                latestDiagnostic?.label ===
                  "Audio transcription provider unavailable") &&
              !handledFailureDiagnosticIds.has(latestDiagnostic.id)
            ) {
              handledFailureDiagnosticIds.add(latestDiagnostic.id);
              throw new Error(
                latestDiagnostic.detail ?? latestDiagnostic.label,
              );
            }
            consecutiveTranscriptionFailures = 0;
          })
          .catch((error: unknown) => {
            if (isInterviewAudioChunkQueueDropError(error)) {
              setRecorderDetail(
                source,
                `${sourceLabel} is recording; ${error.message}`,
              );
              return;
            }

            consecutiveTranscriptionFailures += 1;
            if (consecutiveTranscriptionFailures < 2) {
              setRecorderStatus(source, "recording");
              setRecorderDetail(
                source,
                `${sourceLabel} skipped one failed chunk and is still recording. Open diagnostics for technical details.`,
              );
              return;
            }

            stoppedByFailure = true;
            setRecorderStatus(source, "failed");
            setRecorderDetail(
              source,
              `${sourceLabel} stopped after two consecutive transcription failures. Open diagnostics for technical details.`,
            );
            if (currentRecorder && currentRecorder.state !== "inactive") {
              currentRecorder.stop();
            } else {
              stopStream(stream);
            }
          })
          .finally(() => {
            refreshAudioQueueSnapshot();
          });
        refreshAudioQueueSnapshot();
        void queuedTranscription;
      }

      function finishRecorderCapture() {
        if (cycleTimer !== null) {
          window.clearTimeout(cycleTimer);
          cycleTimer = null;
        }
        currentRecorder = null;
        stopStream(stream);
        acquiredStream = null;
        setActiveRecorderState(source, null);
        if (!stoppedByFailure) {
          setRecorderStatus(source, "idle");
          setRecorderDetail(source, `${sourceLabel} transcription stopped.`);
        }
      }

      function startRecorderCycle() {
        if (
          stoppedByFailure ||
          !acceptingAudioChunksRef.current ||
          !listeningRef.current ||
          sessionIdRef.current !== sessionId ||
          captureLifecycleVersionRef.current !== captureLifecycleVersion
        ) {
          finishRecorderCapture();
          return;
        }

        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        );
        const cycleStartedAt = new Date().toISOString();
        const cycleChunks: Blob[] = [];
        let rotateAfterStop = false;
        currentRecorder = recorder;

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            cycleChunks.push(event.data);
          }
        };
        recorder.onstop = () => {
          if (cycleTimer !== null) {
            window.clearTimeout(cycleTimer);
            cycleTimer = null;
          }
          const chunkEndedAt = new Date().toISOString();
          const chunk = new Blob(cycleChunks, {
            type: recorder.mimeType || mimeType || "audio/webm",
          });
          enqueueCapturedChunk(chunk, cycleStartedAt, chunkEndedAt);

          if (
            rotateAfterStop &&
            !stoppedByFailure &&
            acceptingAudioChunksRef.current &&
            listeningRef.current &&
            sessionIdRef.current === sessionId &&
            captureLifecycleVersionRef.current === captureLifecycleVersion
          ) {
            startRecorderCycle();
            return;
          }

          finishRecorderCapture();
        };

        recorder.start();
        setActiveRecorderState(source, { recorder, stream, startedAt });
        cycleTimer = window.setTimeout(() => {
          cycleTimer = null;
          if (recorder.state !== "inactive") {
            rotateAfterStop = true;
            recorder.stop();
          }
        }, RECORDER_CHUNK_INTERVAL_MS);
      }

      startRecorderCycle();
      setRecorderStatus(source, "recording");
      setRecorderDetail(
        source,
        `${sourceLabel} is recording in transient 5s chunks.`,
      );
    } catch (error) {
      if (acquiredStream) {
        stopStream(acquiredStream);
        acquiredStream = null;
      }
      setActiveRecorderState(source, null);
      setRecorderStatus(source, "failed");
      setRecorderDetail(
        source,
        error instanceof Error
          ? error.message
          : `${sourceLabel} recorder failed.`,
      );
    }
  }

  function stopAudioTranscription(
    source: Extract<InterviewTranscriptSource, "microphone" | "meeting_audio">,
  ) {
    const recorderState =
      source === "microphone" ? activeMicrophoneRecorder : activeSystemRecorder;
    if (!recorderState) {
      return;
    }

    setRecorderStatus(source, "stopping");
    setRecorderDetail(
      source,
      `Stopping ${getAudioSourceLabel(source).toLowerCase()} transcription.`,
    );
    recorderState.recorder.stop();
  }

  function stopLiveAudio() {
    if (captionEnabled || recognitionRef.current) {
      stopMicCaptions();
    }
    if (activeMicrophoneRecorder) {
      stopAudioTranscription("microphone");
    }
    if (activeSystemRecorder) {
      stopAudioTranscription("meeting_audio");
    }
  }

  const anyRecorderActive = Boolean(
    activeMicrophoneRecorder || activeSystemRecorder,
  );
  const anyRecorderBusy =
    microphoneRecorderStatus === "stopping" ||
    systemRecorderStatus === "stopping";
  const health = useMemo(
    () =>
      props.workspace && props.sessionId
        ? deriveInterviewHealthSummary({
            audioTranscriptionAvailable: props.audioTranscriptionAvailable,
            microphoneDetail,
            microphoneRecorderDetail,
            microphoneRecorderStatus,
            microphoneStatus,
            queue: audioQueueSnapshot,
            systemAudioDetail: displayDetail,
            systemRecorderDetail,
            systemRecorderStatus,
            systemStatus: displayStatus,
            workspace: props.workspace,
          })
        : null,
    [
      audioQueueSnapshot,
      displayDetail,
      displayStatus,
      microphoneDetail,
      microphoneRecorderDetail,
      microphoneRecorderStatus,
      microphoneStatus,
      props.audioTranscriptionAvailable,
      props.sessionId,
      props.workspace,
      systemRecorderDetail,
      systemRecorderStatus,
    ],
  );

  return (
    <>
      {health && props.workspace?.activeSession ? (
        <InterviewHealthPanel
          health={health}
          sessionStatus={props.workspace.activeSession.status}
        />
      ) : null}
      <div className="grid gap-2 rounded-(--radius-small) border border-border-subtle bg-(--surface-fill-soft) p-3">
        <div className="grid gap-1">
          <p className="text-[0.82rem]">
            {props.sessionId ? "Live audio" : "Audio test"}
          </p>
          <p className="text-[0.72rem] leading-5 text-muted-foreground">
            {props.sessionId
              ? "Start mic and system audio to save temporary speech-to-text segments into the visible transcript."
              : "Test mic captions and capture readiness before the interview. Preview text stays local here."}{" "}
            Local speech-to-text keeps audio transcription free when configured.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <Button
            disabled={
              !props.microphoneCaptureAllowed || microphoneStatus === "checking"
            }
            onClick={() => {
              void checkMicrophoneStream();
            }}
            pending={microphoneStatus === "checking"}
            size="compact"
            variant="secondary"
          >
            <Mic className="size-4" />
            Test mic
          </Button>
          <Button
            disabled={
              !props.meetingAudioCaptureAllowed || displayStatus === "checking"
            }
            onClick={() => {
              void checkDisplayAudioStream();
            }}
            pending={displayStatus === "checking"}
            size="compact"
            variant="secondary"
          >
            <Monitor className="size-4" />
            Test system
          </Button>
        </div>
        <div className="grid gap-1 text-[0.72rem] leading-5 text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Microphone:</span>{" "}
            {describeStatus(microphoneStatus, microphoneDetail)}
          </p>
          <p>
            <span className="font-semibold text-foreground">System audio:</span>{" "}
            {describeStatus(displayStatus, displayDetail)}
          </p>
        </div>
        <div className="grid gap-2 border-t border-border-subtle pt-2">
          {props.sessionId ? (
            <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
              <Button
                disabled={
                  !props.microphoneCaptureAllowed ||
                  !props.listening ||
                  !props.audioTranscriptionAvailable ||
                  microphoneRecorderStatus === "starting" ||
                  microphoneRecorderStatus === "recording"
                }
                onClick={() => {
                  void startAudioTranscription("microphone");
                }}
                pending={microphoneRecorderStatus === "starting"}
                size="compact"
                variant="secondary"
              >
                <Mic className="size-4" />
                Start mic audio
              </Button>
              <Button
                disabled={
                  !props.meetingAudioCaptureAllowed ||
                  !props.listening ||
                  !props.audioTranscriptionAvailable ||
                  systemRecorderStatus === "starting" ||
                  systemRecorderStatus === "recording"
                }
                onClick={() => {
                  void startAudioTranscription("meeting_audio");
                }}
                pending={systemRecorderStatus === "starting"}
                size="compact"
                variant="secondary"
              >
                <Monitor className="size-4" />
                Start system audio
              </Button>
              <Button
                disabled={
                  (!captionEnabled && !anyRecorderActive) || anyRecorderBusy
                }
                onClick={stopLiveAudio}
                pending={captionStatus === "stopping" || anyRecorderBusy}
                size="compact"
                variant="outline"
              >
                {captionEnabled || anyRecorderActive ? (
                  <MicOff className="size-4" />
                ) : (
                  <Mic className="size-4" />
                )}
                Stop audio
              </Button>
            </div>
          ) : null}
          <div className="grid gap-1 text-[0.72rem] leading-5 text-muted-foreground">
            {props.sessionId ? (
              <>
                <p>{microphoneRecorderDetail}</p>
                <p>{systemRecorderDetail}</p>
                {audioQueueSnapshot.active || audioQueueSnapshot.pending > 0 ? (
                  <p>
                    Transcription queue:{" "}
                    {audioQueueSnapshot.active ? "1 transcribing" : "idle"}
                    {audioQueueSnapshot.pending > 0
                      ? `, ${audioQueueSnapshot.pending} waiting (maximum ${audioQueueSnapshot.maxPending})`
                      : ", no chunks waiting"}
                    .
                  </p>
                ) : null}
              </>
            ) : null}
            <div className="grid gap-2 pt-1 sm:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_auto]">
              <p>
                Browser captions are a mic-only fallback when your browser
                supports speech recognition.
              </p>
              <Button
                disabled={
                  !props.listening ||
                  captionStatus === "starting" ||
                  captionStatus === "recording"
                }
                onClick={startMicCaptions}
                pending={captionStatus === "starting"}
                size="compact"
                variant="secondary"
              >
                <Radio className="size-4" />
                {props.sessionId
                  ? "Start browser captions"
                  : "Test mic captions"}
              </Button>
            </div>
            <p>{captionDetail}</p>
            {captionPreview ? (
              <p className="rounded-(--radius-small) border border-(--info-border) bg-(--info-surface) p-2 text-(--info-text)">
                {captionPreview}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
