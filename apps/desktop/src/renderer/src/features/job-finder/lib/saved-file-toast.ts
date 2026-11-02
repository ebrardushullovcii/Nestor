import type { ToastInput } from "@renderer/components/ui/toast";
import { isMacPlatform } from "@renderer/features/job-lists/platform-keys";

/** "Resume – Senior Engineer.pdf" from a full path. */
export function savedFileName(path: string): string {
  return path.split(/[\\/]/u).pop() || path;
}

/**
 * The toast for a file the app just saved: its name, never the raw path,
 * and one action that shows it in Finder (or the file manager) through the
 * preload bridge. Nothing is opened or run.
 */
export function savedFileToast(
  title: string,
  path: string,
  showToast: (toast: ToastInput) => void,
): ToastInput {
  return {
    title,
    description: savedFileName(path),
    tone: "success",
    action: {
      label: isMacPlatform() ? "Show in Finder" : "Show in folder",
      onClick: () =>
        void window.nestor.jobFinder
          .revealSavedFile(path)
          .then((result) => {
            if (result.outcome !== "revealed")
              showToast({
                title:
                  result.outcome === "not_found"
                    ? "That file is no longer where it was saved."
                    : "Showing files is not supported on this device.",
                tone: "warning",
              });
          })
          .catch(() =>
            showToast({
              title: "The file could not be shown. Try again.",
              tone: "warning",
            }),
          ),
    },
  };
}
