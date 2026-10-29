import path from "node:path";
import type { PrintToPDFOptions } from "electron";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JobFinderDocumentManager } from "@nestor/job-finder";
import { createLocalJobFinderDocumentManager } from "./job-finder-document-manager";
import { createDocumentTestSeed } from "./document-test-seed.test-support";
import { renderResumeTemplateHtml } from "../../shared/job-finder-resume-renderer";

const mocks = vi.hoisted(() => ({
  files: new Map<string, string | Buffer>(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  print: vi.fn<(options: PrintToPDFOptions) => Promise<Buffer>>(),
  load: vi.fn<(file: string) => Promise<void>>(),
  count: vi.fn(),
  windows: [] as { destroyed: boolean }[],
  mkdir: vi.fn(),
  write: vi.fn<(file: string, contents: string | Buffer) => Promise<void>>(),
  failWindow: false,
  maximumWindows: 0,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  mkdtemp: mocks.mkdtemp,
  rm: mocks.rm,
  writeFile: mocks.write,
  readFile: vi.fn((file: string) => Promise.resolve(mocks.files.get(file))),
}));
vi.mock("./resume-document", () => ({ getPdfPageCount: mocks.count }));
vi.mock("./resume-document/pdf", () => ({
  inspectPdfLayout: async (file: string) => ({
    pageCount: await mocks.count(file),
    lastPageFillRatio: 0.75,
  }),
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    destroyed = false;
    webContents = {
      executeJavaScript: vi.fn().mockResolvedValue(undefined),
      printToPDF: mocks.print,
    };
    constructor() {
      if (mocks.failWindow) {
        mocks.failWindow = false;
        throw new Error("Window failed");
      }
      mocks.windows.push(this);
      mocks.maximumWindows = Math.max(
        mocks.maximumWindows,
        mocks.windows.filter((window) => !window.destroyed).length,
      );
    }
    loadFile = mocks.load;
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));

let input: Parameters<JobFinderDocumentManager["renderResumePreview"]>[0];
let manager: JobFinderDocumentManager;

test("uses the host renderer's HTML for both preview and page counting", async () => {
  const renderResumeHtml = vi.fn().mockResolvedValue({
    previewHtml: "<html>Worker preview</html>",
    exportHtml: "<html>Worker printable document</html>",
  });
  const offThreadManager = createLocalJobFinderDocumentManager({
    outputDirectory: "/synthetic-output",
    renderResumeHtml,
  });
  const preview = await offThreadManager.renderResumePreview(input);
  expect(preview.html).toBe("<html>Worker preview</html>");
  expect(renderResumeHtml).toHaveBeenCalledWith({
    renderDocument: input.renderDocument,
    settings: input.settings,
    templateId: input.templateId,
  });
  expect(mocks.write).toHaveBeenCalledWith(
    expect.any(String),
    "<html>Worker printable document</html>",
    "utf8",
  );
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.files.clear();
  mocks.windows.length = 0;
  mocks.maximumWindows = 0;
  mocks.failWindow = false;
  mocks.write.mockImplementation((file, contents) => {
    mocks.files.set(file, contents);
    return Promise.resolve();
  });
  let directoryId = 0;
  mocks.mkdtemp.mockImplementation((prefix: string) =>
    Promise.resolve(`${prefix}${++directoryId}`),
  );
  mocks.load.mockResolvedValue(undefined);
  mocks.print.mockResolvedValue(Buffer.from("synthetic PDF"));
  mocks.count.mockResolvedValue(2);
  const seed = createDocumentTestSeed();
  input = {
    job: seed.savedJobs[0]!,
    profile: seed.profile,
    templateId: "classic_ats",
    settings: seed.settings,
    renderDocument: {
      fullName: "Alex Example",
      headline: "Platform engineer",
      location: "Remote",
      contactItems: [],
      sections: [],
    },
  };
  manager = createLocalJobFinderDocumentManager({
    outputDirectory: "/synthetic-output",
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

test("prints export-mode HTML with the export options, counts the PDF, and cleans up", async () => {
  const preview = await manager.renderResumePreview(input);
  expect(preview.pageCount).toBe(2);
  expect(preview.html).toBe(
    renderResumeTemplateHtml(input, { mode: "preview" }),
  );
  const htmlPath = mocks.load.mock.calls[0]![0];
  expect(mocks.files.get(htmlPath)).toBe(renderResumeTemplateHtml(input));
  expect(mocks.count).toHaveBeenCalledWith(
    path.join(path.dirname(htmlPath), "resume.pdf"),
  );
  expect(mocks.rm).toHaveBeenCalledWith(path.dirname(htmlPath), {
    recursive: true,
    force: true,
  });
  expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
  const previewPrintOptions = mocks.print.mock.calls[0]![0];
  await manager.renderResumeArtifact({
    ...input,
    settings: { ...input.settings, resumeFormat: "pdf" },
  });
  expect(mocks.print.mock.calls[1]![0]).toEqual(previewPrintOptions);
  expect(previewPrintOptions).toEqual({
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    printBackground: true,
    pageSize: "Letter",
    preferCSSPageSize: true,
  });
});

test("caches unchanged export HTML, including simultaneous requests, and reprints edits", async () => {
  const previews = await Promise.all([
    manager.renderResumePreview(input),
    manager.renderResumePreview(input),
  ]);
  expect(previews.map((preview) => preview.pageCount)).toEqual([2, 2]);
  await manager.renderResumePreview(input);
  expect(mocks.print).toHaveBeenCalledTimes(1);
  mocks.count.mockResolvedValue(1);
  const edited = await manager.renderResumePreview({
    ...input,
    renderDocument: { ...input.renderDocument, headline: "Research engineer" },
  });
  expect(edited.pageCount).toBe(1);
  expect(mocks.print).toHaveBeenCalledTimes(2);
});

test("serializes different previews so only one print window is active", async () => {
  let release!: (buffer: Buffer) => void;
  mocks.print.mockImplementationOnce(
    () =>
      new Promise<Buffer>((resolve) => {
        release = resolve;
      }),
  );
  const first = manager.renderResumePreview(input);
  const second = manager.renderResumePreview({
    ...input,
    templateId: "modern_split",
  });
  await flush();
  expect(mocks.windows).toHaveLength(1);
  release(Buffer.from("synthetic PDF"));
  await Promise.all([first, second]);
  expect(mocks.windows).toHaveLength(2);
  expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
});

test.each(["load", "print", "count"] as const)(
  "keeps the HTML preview when %s fails and retries measurement",
  async (step) => {
    mocks[step].mockRejectedValueOnce(new Error("Measurement failed"));
    const preview = await manager.renderResumePreview(input);
    expect(preview.html).toContain("Alex Example");
    expect(preview.pageCount).toBeNull();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
    expect((await manager.renderResumePreview(input)).pageCount).toBe(2);
  },
);

test("aborts active and queued previews without printing a superseded draft", async () => {
  mocks.print.mockImplementationOnce(() => new Promise<Buffer>(() => {}));
  const activeController = new AbortController();
  const queuedController = new AbortController();
  const first = manager.renderResumePreview(input, activeController.signal);
  const second = manager.renderResumePreview(input, queuedController.signal);
  const firstCheck = expect(first).rejects.toMatchObject({
    name: "AbortError",
  });
  const secondCheck = expect(second).rejects.toMatchObject({
    name: "AbortError",
  });
  await flush();
  queuedController.abort();
  activeController.abort();
  await Promise.all([firstCheck, secondCheck]);
  await flush();
  expect(mocks.print).toHaveBeenCalledTimes(1);
  expect(mocks.rm).toHaveBeenCalledTimes(1);
  expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
  expect((await manager.renderResumePreview(input)).pageCount).toBe(2);
});

test("a pre-aborted preview never opens a window", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    manager.renderResumePreview(input, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.windows).toHaveLength(0);
});

test("slow measurements return an unknown count within the preview budget and release the queue", async () => {
  vi.useFakeTimers();
  mocks.print.mockImplementationOnce(() => new Promise<Buffer>(() => {}));
  const preview = manager.renderResumePreview(input);
  await flush();
  await vi.advanceTimersByTimeAsync(750);
  expect((await preview).pageCount).toBeNull();
  await flush();
  expect(mocks.rm).toHaveBeenCalledTimes(1);
  expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
  expect((await manager.renderResumePreview(input)).pageCount).toBe(2);
});

function finalResume(onQueueWait?: (milliseconds: number) => void) {
  return manager.renderResumeArtifact({
    ...input,
    settings: { ...input.settings, resumeFormat: "pdf" },
    ...(onQueueWait ? { onQueueWait } : {}),
  });
}

test("shares two PDF windows across final resumes, letters and another manager's preview", async () => {
  const releases: Array<(buffer: Buffer) => void> = [];
  mocks.print.mockImplementation(
    () => new Promise<Buffer>((resolve) => releases.push(resolve)),
  );
  const first = finalResume();
  const second = finalResume();
  await flush();
  const anotherManager = createLocalJobFinderDocumentManager({
    outputDirectory: "/another-synthetic-output",
  });
  const preview = anotherManager.renderResumePreview(input);
  const letter = manager.renderLetterArtifact!({
    text: "Synthetic application letter",
    job: input.job,
    profile: input.profile,
    settings: input.settings,
    fileType: "pdf",
  });
  await flush();
  expect(mocks.windows).toHaveLength(2);
  expect(mocks.mkdir).toHaveBeenCalledTimes(2);
  expect(mocks.write).toHaveBeenCalledTimes(2);
  releases[0]!(Buffer.from("first PDF"));
  releases[1]!(Buffer.from("second PDF"));
  await flush();
  expect(mocks.windows).toHaveLength(4);
  expect(mocks.maximumWindows).toBe(2);
  releases[2]!(Buffer.from("third PDF"));
  releases[3]!(Buffer.from("fourth PDF"));
  await Promise.all([first, second, preview, letter]);
  expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
});

test.each(["mkdir", "write", "load", "print", "window"] as const)(
  "releases PDF capacity when %s fails so queued final renders finish",
  async (step) => {
    if (step === "window") mocks.failWindow = true;
    else mocks[step].mockRejectedValueOnce(new Error("Render failed"));
    const renders = [finalResume(), finalResume(), finalResume()];
    const results = await Promise.allSettled(renders);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(mocks.maximumWindows).toBeLessThanOrEqual(2);
    expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
  },
);

test("a preview cancelled behind final renders never creates a window or HTML file", async () => {
  const releases: Array<(buffer: Buffer) => void> = [];
  mocks.print.mockImplementation(
    () => new Promise<Buffer>((resolve) => releases.push(resolve)),
  );
  const first = finalResume();
  const second = finalResume();
  await flush();
  const controller = new AbortController();
  const preview = manager.renderResumePreview(input, controller.signal);
  const cancelled = expect(preview).rejects.toMatchObject({
    name: "AbortError",
  });
  await flush();
  controller.abort();
  await cancelled;
  expect(mocks.windows).toHaveLength(2);
  expect(mocks.mkdir).toHaveBeenCalledTimes(2);
  expect(mocks.write).toHaveBeenCalledTimes(2);
  for (const release of releases) release(Buffer.from("synthetic PDF"));
  await Promise.all([first, second]);
  await flush();
  expect(mocks.windows).toHaveLength(2);
  expect(mocks.print).toHaveBeenCalledTimes(2);
  expect(mocks.mkdir).toHaveBeenCalledTimes(2);
  expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
});

test("reports only PDF admission wait and starts the two-minute deadline after admission", async () => {
  vi.useFakeTimers();
  const releases: Array<(buffer: Buffer) => void> = [];
  mocks.print.mockImplementation(
    () => new Promise<Buffer>((resolve) => releases.push(resolve)),
  );
  const first = finalResume();
  const second = finalResume();
  const secondDeadline = expect(second).rejects.toThrow(
    "did not finish rendering within 2 minutes",
  );
  const onQueueWait = vi.fn();
  const third = finalResume(onQueueWait);
  await flush();
  expect(onQueueWait).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(119_000);
  releases[0]!(Buffer.from("first PDF"));
  await flush();
  expect(onQueueWait).toHaveBeenCalledTimes(1);
  expect(onQueueWait.mock.calls[0]![0]).toBeGreaterThanOrEqual(119_000);
  await vi.advanceTimersByTimeAsync(2_000);
  await secondDeadline;
  releases[2]!(Buffer.from("third PDF"));
  await Promise.all([first, third]);
  expect(mocks.maximumWindows).toBe(2);
  expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
});
