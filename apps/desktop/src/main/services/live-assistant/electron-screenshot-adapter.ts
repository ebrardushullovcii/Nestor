import { desktopCapturer, screen } from "electron";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopScreenshotCaptureAdapter } from "@nestor/os-integration";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createElectronDesktopScreenshotCaptureAdapter(input: {
  directory: string;
  now?: () => string;
}): DesktopScreenshotCaptureAdapter {
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async captureInterviewRegion(request) {
      const capturedAt = now();
      const id = `interview_screenshot_${Date.now()}`;

      try {
        const display = screen.getPrimaryDisplay();
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: display.size,
        });
        const source = sources[0];

        if (!source) {
          return {
            id,
            status: "unavailable",
            screenshotCount: 0,
            overlayContaminated: false,
            detail: "Electron desktopCapturer did not return a screen source.",
            capturedAt,
          };
        }

        const png = source.thumbnail.toPNG();
        await mkdir(input.directory, { recursive: true });
        const temporaryPath = path.join(input.directory, `${id}.png`);
        await writeFile(temporaryPath, png);
        await rm(temporaryPath, { force: true });

        return {
          id,
          status: "available",
          screenshotCount: 1,
          overlayContaminated: true,
          images: [
            {
              mimeType: "image/png",
              base64: png.toString("base64"),
            },
          ],
          detail:
            request.reason === "rehearsal"
              ? `Electron desktopCapturer produced a ${png.byteLength} byte temporary primary-display capture and discarded it.`
              : request.reason === "automatic_cue"
                ? `Electron desktopCapturer captured the primary display for an automatic cue and discarded the temporary ${png.byteLength} byte PNG. Overlay contamination remains possible and is disclosed to the cue provider.`
                : `Electron desktopCapturer captured the primary display for cue context and discarded the temporary ${png.byteLength} byte PNG. Overlay contamination remains possible and is disclosed to the cue provider.`,
          capturedAt,
        };
      } catch (error) {
        return {
          id,
          status: "unavailable",
          screenshotCount: 0,
          overlayContaminated: false,
          detail: `Electron desktopCapturer failed: ${toErrorMessage(error)}`,
          capturedAt,
        };
      }
    },
  };
}
