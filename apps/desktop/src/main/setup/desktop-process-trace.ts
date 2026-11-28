import { runTraceEnabled, traceEvent } from "@nestor/core/run-trace";
import type {
  Details as ChildProcessGoneDetails,
  Event,
  RenderProcessGoneDetails,
  WebContents,
} from "electron";

interface DesktopProcessEvents {
  on(
    event: "render-process-gone",
    listener: (
      event: Event,
      contents: WebContents,
      details: RenderProcessGoneDetails,
    ) => void,
  ): void;
  on(
    event: "child-process-gone",
    listener: (event: Event, details: ChildProcessGoneDetails) => void,
  ): void;
}

interface MainProcessEvents {
  pid: number;
  on(
    event: "uncaughtExceptionMonitor",
    listener: NodeJS.UncaughtExceptionListener,
  ): void;
  on(event: "exit", listener: NodeJS.ExitListener): void;
}

export function registerDesktopProcessTrace(
  app: DesktopProcessEvents,
  desktopProcess: MainProcessEvents = process,
): void {
  if (!runTraceEnabled()) return;
  const { pid } = desktopProcess;
  traceEvent("desktop_process_started", { pid });
  desktopProcess.on("uncaughtExceptionMonitor", (error, origin) => {
    traceEvent("desktop_process_exception", { pid, error, origin });
  });
  desktopProcess.on("exit", (code) => {
    traceEvent("desktop_process_exit", { pid, code });
  });
  app.on("render-process-gone", (_event, contents, details) => {
    traceEvent("desktop_renderer_gone", {
      pid,
      webContentsId: contents.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  app.on("child-process-gone", (_event, details) => {
    traceEvent("desktop_child_process_gone", {
      pid,
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
}
