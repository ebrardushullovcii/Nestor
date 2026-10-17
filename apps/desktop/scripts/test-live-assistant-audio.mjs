/* eslint-env node, browser */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");

async function synthesizeSpeech(filePath, text) {
  const escapedPath = filePath.replaceAll("'", "''");
  const escapedText = text.replaceAll("'", "''");
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.Speech; $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer; $speaker.SetOutputToWaveFile('${escapedPath}'); $speaker.Speak('${escapedText}'); $speaker.Dispose()`,
  ]);
}

async function waitForTranscriptSource(
  window,
  source,
  minimumCount,
  timeoutMs = 45_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const workspace = await window.evaluate(() =>
      window.nestor.liveAssistant.getWorkspace(),
    );
    const count =
      workspace.activeSession?.transcriptSegments.filter(
        (segment) => segment.source === source,
      ).length ?? 0;
    if (count >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${source} transcript ${minimumCount}.`,
  );
}

function assertInvariant(condition, message) {
  if (!condition)
    throw new Error(`Live Assistant audio test failed: ${message}`);
}

async function run() {
  if (process.platform !== "win32") {
    throw new Error(
      "This end-to-end loopback test currently requires Windows.",
    );
  }

  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-interview-audio-"),
  );
  const microphoneAudioPath = path.join(userDataDirectory, "microphone.wav");
  const systemAudioPath = path.join(userDataDirectory, "system.wav");
  await synthesizeSpeech(
    microphoneAudioPath,
    "Microphone check confirms the interview assistant audio path works correctly.",
  );
  await synthesizeSpeech(
    systemAudioPath,
    "System audio check confirms the interview question can be transcribed.",
  );
  const systemAudioBase64 = (await readFile(systemAudioPath)).toString(
    "base64",
  );

  const app = await electron.launch({
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${microphoneAudioPath}`,
      ".",
    ],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_AI_API_KEY: "",
      NESTOR_AI_VISION_API_KEY: "",
      NESTOR_INTERVIEW_AI_API_KEY: "",
      NESTOR_INTERVIEW_ADVANCED_SURFACES: "",
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(() => {
      window.location.hash = "/live-assistant";
    });
    await window.evaluate(async () => {
      await window.nestor.liveAssistant.saveSetup({
        consent: {
          microphoneCapture: true,
          meetingAudioCapture: true,
          screenshotCapture: true,
          modelTransmission: true,
          localRetention: true,
          overlayProtectionNotice: true,
          acceptedAt: new Date().toISOString(),
        },
      });
      await window.nestor.liveAssistant.runRehearsal();
      await window.nestor.liveAssistant.startSession();
    });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window.getByRole("heading", { name: "Audio inputs" }).waitFor();

    const initialWorkspace = await window.evaluate(() =>
      window.nestor.liveAssistant.getWorkspace(),
    );
    const initialMicrophoneCount =
      initialWorkspace.activeSession?.transcriptSegments.filter(
        (segment) => segment.source === "microphone",
      ).length ?? 0;
    const initialSystemCount =
      initialWorkspace.activeSession?.transcriptSegments.filter(
        (segment) => segment.source === "meeting_audio",
      ).length ?? 0;

    await window.getByRole("button", { name: "Start mic audio" }).click();
    await waitForTranscriptSource(
      window,
      "microphone",
      initialMicrophoneCount + 1,
    );
    const workspaceAfterMicrophone = await window.evaluate(() =>
      window.nestor.liveAssistant.getWorkspace(),
    );
    await window.getByRole("button", { name: "Stop audio" }).click();
    await window.getByRole("button", { name: "Start mic audio" }).waitFor({
      state: "visible",
    });

    await window.getByRole("button", { name: "Start system audio" }).click();
    await window.evaluate(async (base64) => {
      const audio = new Audio(`data:audio/wav;base64,${base64}`);
      await audio.play();
      await new Promise((resolve) => {
        audio.addEventListener("ended", resolve, { once: true });
      });
    }, systemAudioBase64);
    await waitForTranscriptSource(
      window,
      "meeting_audio",
      initialSystemCount + 1,
    );
    const workspaceAfterSystem = await window.evaluate(() =>
      window.nestor.liveAssistant.getWorkspace(),
    );
    await window.getByRole("button", { name: "Pause" }).click();
    await window
      .getByText("System audio transcription stopped.", { exact: true })
      .waitFor();
    const pausedWorkspace = await window.evaluate(() =>
      window.nestor.liveAssistant.getWorkspace(),
    );
    const pauseStopsActiveAudio =
      pausedWorkspace.activeSession?.status === "paused" &&
      (await window.getByRole("button", { name: "Stop audio" }).isDisabled());
    await window.getByRole("button", { name: "Resume" }).click();

    const workspace = await window.evaluate(() =>
      window.nestor.liveAssistant.getWorkspace(),
    );
    const microphoneSegments =
      workspaceAfterMicrophone.activeSession?.transcriptSegments.filter(
        (segment) => segment.source === "microphone",
      ) ?? [];
    const systemSegments =
      workspaceAfterSystem.activeSession?.transcriptSegments.filter(
        (segment) => segment.source === "meeting_audio",
      ) ?? [];
    const report = {
      localMicrophoneEngineReady:
        workspace.setup.rehearsal?.microphoneEngine.kind === "local_model" &&
        workspace.setup.rehearsal.microphoneEngine.ready,
      localSystemEngineReady:
        workspace.setup.rehearsal?.meetingAudioEngine.kind === "local_model" &&
        workspace.setup.rehearsal.meetingAudioEngine.ready,
      microphoneTranscript: microphoneSegments.at(-1)?.text ?? null,
      systemTranscript: systemSegments.at(-1)?.text ?? null,
      microphoneSnapshotSegments:
        workspaceAfterMicrophone.activeSession?.transcriptSegments.map(
          (segment) => ({ source: segment.source, text: segment.text }),
        ) ?? [],
      systemSnapshotSegments:
        workspaceAfterSystem.activeSession?.transcriptSegments.map(
          (segment) => ({ source: segment.source, text: segment.text }),
        ) ?? [],
      finalActiveSessionStatus: workspace.activeSession?.status ?? null,
      pauseStopsActiveAudio,
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    assertInvariant(
      report.localMicrophoneEngineReady,
      "local mic STT engine should be ready",
    );
    assertInvariant(
      report.localSystemEngineReady,
      "local system STT engine should be ready",
    );
    assertInvariant(
      Boolean(report.microphoneTranscript),
      "mic audio should produce a transcript",
    );
    assertInvariant(
      Boolean(report.systemTranscript),
      "system audio should produce a transcript",
    );
    assertInvariant(
      report.pauseStopsActiveAudio,
      "pausing the session should stop active audio capture",
    );
  } finally {
    await app.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

await run();
