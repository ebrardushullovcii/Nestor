// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobFinderResumePreview } from "@nestor/contracts";
import { LockedScreenLayout } from "../../components/locked-screen-layout";
import { ResumeStudioPreviewPane } from "./resume-studio-preview-pane";

const preview: JobFinderResumePreview = {
  draftId: "draft_1",
  revisionKey: "resume_preview_draft_1_abc123",
  html: '<!doctype html><html><body><article data-resume-section-id="section_summary">Preview body</article></body></html>',
  warnings: [
    {
      id: "preview_warning_1",
      source: "validation",
      severity: "warning",
      category: "poor_keyword_coverage",
      sectionId: "section_summary",
      entryId: null,
      bulletId: null,
      message: "Add one more role-specific keyword to the summary.",
    },
  ],
  metadata: {
    templateId: "classic_ats",
    renderedAt: "2026-04-27T00:00:00.000Z",
    pageCount: null,
    sectionCount: 2,
    entryCount: 1,
  },
};

describe("ResumeStudioPreviewPane", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each([
    { pageCount: 1, label: "1 page", isDirty: false },
    { pageCount: 2, label: "2 pages", isDirty: true },
    { pageCount: null, label: null, isDirty: false },
  ])(
    "shows only the measured page count: $pageCount",
    ({ pageCount, label, isDirty }) => {
      const { container } = render(
        <ResumeStudioPreviewPane
          isDirty={isDirty}
          isPending={false}
          onRetry={vi.fn()}
          onSelectTarget={vi.fn()}
          preview={{ ...preview, metadata: { ...preview.metadata, pageCount } }}
          previewError={null}
          previewStatus="ready"
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
        />,
      );
      const count = screen.queryByTitle("Page count of the exported PDF");
      if (!label) {
        expect(count).toBeNull();
        expect(
          container.querySelector("[data-resume-preview-page-count]"),
        ).toBeNull();
        return;
      }
      expect(count?.textContent).toBe(label);
      expect(count?.hasAttribute("data-resume-preview-page-count")).toBe(
        pageCount >= 2,
      );
      const status = screen.getByText(
        isDirty ? "Unsaved edits rendered" : "Saved draft rendered",
      );
      expect(count?.className).toBe(status.className);
      expect(status.nextElementSibling).toBe(count);
      expect(count?.nextElementSibling).toBe(
        screen.getByRole("button", { name: /1 suggestion/i }),
      );
    },
  );

  it("opens, scrolls to, and focuses the suggestions disclosure from the count chip", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <>
        <details data-resume-validation-notes>
          <summary>Other suggestions (1)</summary>
          <ul />
        </details>
        <ResumeStudioPreviewPane
          isDirty={false}
          isPending={false}
          onRetry={vi.fn()}
          onSelectTarget={vi.fn()}
          preview={preview}
          previewError={null}
          previewStatus="ready"
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
        />
      </>,
    );

    const notes = document.querySelector<HTMLDetailsElement>(
      "[data-resume-validation-notes]",
    );
    expect(notes?.open).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /1 suggestion/i }));

    expect(notes?.open).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(notes?.querySelector("summary"));
  });

  it("renders the preview frame without a script-blocking sandbox attribute", () => {
    // The rendered document carries its own `script-src 'none'` policy and
    // the renderer CSP has no unsafe-inline, so scripts cannot run in the
    // frame. A `sandbox` attribute (which would still need
    // allow-same-origin for the click-to-edit binding) only made Chromium log
    // "Blocked script execution in 'about:srcdoc'" on every preview reload.
    render(
      <ResumeStudioPreviewPane
        isDirty={false}
        isPending={false}
        onRetry={vi.fn()}
        onSelectTarget={vi.fn()}
        preview={preview}
        previewError={null}
        previewStatus="ready"
        selectedEntryId={null}
        selectedSectionId={null}
        selectedTargetId={null}
      />,
    );

    const frame = screen.getByTitle("Live resume preview");
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(frame.getAttribute("srcdoc")).not.toMatch(/<script/i);
  });

  it("surfaces compact preview warnings and unsaved live-preview status", () => {
    const rendered = render(
      <ResumeStudioPreviewPane
        isDirty
        isPending={false}
        onRetry={vi.fn()}
        onSelectTarget={vi.fn()}
        preview={preview}
        previewError={null}
        previewStatus="ready"
        selectedEntryId={null}
        selectedSectionId="section_summary"
        selectedTargetId={null}
        templateLabel="Chronology Classic"
      />,
    );

    expect(screen.getByText("Unsaved edits rendered")).toBeTruthy();
    expect(screen.getByText(/1 suggestion/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /1 suggestion/i })).toBeTruthy();
    expect(
      screen.queryByText(/Add one more role-specific keyword to the summary/i),
    ).toBeNull();
    expect(screen.getByText("Chronology Classic")).toBeTruthy();
    expect(screen.getByTitle("Live resume preview")).toBeTruthy();
    const previewContent = rendered.container.querySelector(
      "[data-resume-preview-scroll-region] > div",
    );
    expect(previewContent?.classList.contains("min-h-full")).toBe(true);
    expect(previewContent?.classList.contains("pb-4")).toBe(true);
    const iframe = screen.getByTitle("Live resume preview");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Expected the live preview element to be an iframe.");
    }
    expect(iframe.contentDocument?.documentElement.style.overflow).toBe(
      "hidden",
    );
    expect(iframe.contentDocument?.body.style.overflow).toBe("hidden");
    expect(
      iframe.contentDocument?.body.style.getPropertyValue("--preview-scale"),
    ).not.toBe("");
  });

  it("shows the preview failure fallback with the renderer error message", () => {
    const onRetry = vi.fn();
    render(
      <ResumeStudioPreviewPane
        isDirty={false}
        isPending={false}
        onRetry={onRetry}
        onSelectTarget={vi.fn()}
        preview={null}
        previewError="Preview rendering failed in desktop test mode."
        previewStatus="error"
        selectedEntryId={null}
        selectedSectionId={null}
        selectedTargetId={null}
        templateLabel={null}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
    expect(alert.textContent).toContain("Preview unavailable");
    expect(
      screen.getByText("Preview rendering failed in desktop test mode."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your edits are still in the studio and nothing was discarded. You can retry the preview at any time.",
      ),
    ).toBeTruthy();

    const retryButton = screen.getByRole("button", { name: /retry preview/i });
    expect(alert.contains(retryButton)).toBe(true);
    expect(retryButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("announces an explicit preview refresh while pending and after completion", () => {
    const onRetry = vi.fn();
    const baseProps = {
      isDirty: false,
      isPending: false,
      onRetry,
      onSelectTarget: vi.fn(),
      preview,
      previewError: null,
      selectedEntryId: null,
      selectedSectionId: null,
      selectedTargetId: null,
      templateLabel: "Chronology Classic",
    };
    const rendered = render(
      <ResumeStudioPreviewPane {...baseProps} previewStatus="ready" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /refresh preview/i }));
    expect(
      rendered.container.querySelector("[data-resume-preview-refresh-status]")
        ?.textContent,
    ).toContain("Refreshing preview");

    rendered.rerender(
      <ResumeStudioPreviewPane {...baseProps} previewStatus="loading" />,
    );
    expect(
      rendered.container.querySelector("[data-resume-preview-refresh-status]")
        ?.textContent,
    ).toContain("Refreshing preview");

    rendered.rerender(
      <ResumeStudioPreviewPane {...baseProps} previewStatus="ready" />,
    );
    expect(
      rendered.container.querySelector("[data-resume-preview-refresh-status]")
        ?.textContent,
    ).toBe("Preview refreshed.");
  });

  it("keeps preview retry controls consistent with in-flight preview state", () => {
    const onRetry = vi.fn();
    const loadingRender = render(
      <ResumeStudioPreviewPane
        isDirty={false}
        isPending={false}
        onRetry={onRetry}
        onSelectTarget={vi.fn()}
        preview={preview}
        previewError={null}
        previewStatus="loading"
        selectedEntryId={null}
        selectedSectionId={null}
        selectedTargetId={null}
        templateLabel="Chronology Classic"
      />,
    );

    const refreshWhileLoading = screen.getByRole("button", {
      name: /refresh preview/i,
    });
    expect(refreshWhileLoading.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    loadingRender.unmount();

    render(
      <ResumeStudioPreviewPane
        isDirty={false}
        isPending
        onRetry={onRetry}
        onSelectTarget={vi.fn()}
        preview={preview}
        previewError="Preview rendering failed in desktop test mode."
        previewStatus="error"
        selectedEntryId={null}
        selectedSectionId={null}
        selectedTargetId={null}
        templateLabel="Chronology Classic"
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Updating your resume",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a ready preview visible while the workspace is busy", () => {
    render(
      <ResumeStudioPreviewPane
        isDirty={false}
        isPending
        onRetry={vi.fn()}
        onSelectTarget={vi.fn()}
        preview={preview}
        previewError={null}
        previewStatus="ready"
        selectedEntryId={null}
        selectedSectionId={null}
        selectedTargetId={null}
        templateLabel="Chronology Classic"
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTitle("Live resume preview")).toBeTruthy();
  });

  it("keeps a readable page inside its own horizontal scroll region", () => {
    const rendered = render(
      <ResumeStudioPreviewPane
        isDirty={false}
        isPending={false}
        onRetry={vi.fn()}
        onSelectTarget={vi.fn()}
        preview={preview}
        previewError={null}
        previewStatus="ready"
        selectedEntryId={null}
        selectedSectionId={null}
        selectedTargetId={null}
        templateLabel="Chronology Classic"
      />,
    );

    const region = rendered.container.querySelector(
      "[data-resume-preview-scroll-region]",
    );
    // The page holds a readable minimum scale even when the Assistant rail
    // narrows this column, so the pane owns a horizontal scroll region instead
    // of shrinking the document out of legibility.
    expect(region?.classList.contains("overflow-x-auto")).toBe(true);
    expect(region?.classList.contains("overflow-y-auto")).toBe(true);

    const frame = rendered.container.querySelector<HTMLDivElement>(
      "[data-resume-preview-scroll-region] > div > div",
    );
    expect(frame?.classList.contains("w-max")).toBe(true);
    expect(frame?.classList.contains("overflow-hidden")).toBe(true);

    const iframe = screen.getByTitle("Live resume preview");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Expected the live preview element to be an iframe.");
    }
    expect(iframe.className).not.toContain("max-w-full");
  });

  it("applies one scale for an alternating 1px column width instead of zooming in and out", () => {
    // The pane used to observe its own scroll region: the scaled page changed
    // the scroller's content size, that toggled a scrollbar, the scrollbar
    // changed the measured width, and the next measurement picked a different
    // scale — the user saw the preview zooming in and out continuously.
    let columnWidth = 350;
    const ownDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "clientWidth",
    );
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        return this.hasAttribute("data-resume-preview-width-probe")
          ? columnWidth
          : 0;
      },
    });

    const columnObserverCallbacks: ResizeObserverCallback[] = [];
    class ResizeObserverStub {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      disconnect() {}
      observe(target: Element) {
        if (target.hasAttribute?.("data-resume-preview-width-probe")) {
          columnObserverCallbacks.push(this.callback);
        }
      }
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    const appliedScales: string[] = [];
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(
      function trackPreviewScale(
        this: CSSStyleDeclaration,
        property: string,
        value: string | null,
      ) {
        if (property === "--preview-scale") {
          appliedScales.push(String(value));
        }
      },
    );

    try {
      render(
        <ResumeStudioPreviewPane
          isDirty={false}
          isPending={false}
          onRetry={vi.fn()}
          onSelectTarget={vi.fn()}
          preview={preview}
          previewError={null}
          previewStatus="ready"
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          templateLabel="Chronology Classic"
        />,
      );

      expect(columnObserverCallbacks).toHaveLength(1);
      const initialScaleCount = appliedScales.length;

      const alternateColumnWidth = () => {
        // A scrollbar flickering in and out moves the measured width by exactly
        // one pixel. That is layout noise, not a new column to scale to.
        for (const width of [349, 350, 349, 350, 349, 350]) {
          columnWidth = width;
          act(() => {
            for (const callback of columnObserverCallbacks) {
              callback(
                [
                  { contentRect: { width } },
                ] as unknown as ResizeObserverEntry[],
                null as unknown as ResizeObserver,
              );
            }
          });
        }
      };

      alternateColumnWidth();

      // The resolved scale is re-applied whenever a measurement runs, because a
      // re-rendered draft replaces the preview document and its fresh body
      // starts at the stylesheet default. A whole burst of noise therefore
      // costs at most the one measurement the epsilon guard lets through, and
      // never a second scale value.
      expect(appliedScales.length).toBeLessThanOrEqual(initialScaleCount + 1);
      expect(new Set(appliedScales).size).toBe(1);

      // Settled: further noise adds no writes at all, so nothing is being
      // re-resolved per event.
      const settledScaleCount = appliedScales.length;
      alternateColumnWidth();
      expect(appliedScales.length).toBe(settledScaleCount);
      expect(new Set(appliedScales).size).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      if (ownDescriptor) {
        Object.defineProperty(Element.prototype, "clientWidth", ownDescriptor);
      } else {
        Reflect.deleteProperty(Element.prototype, "clientWidth");
      }
    }
  });

  it("keeps the page inside the visible region instead of cropping it under the scrollbar", () => {
    // Measured in the built app at 1440x920 and at 1280x720: the pane column,
    // and the scrollbar gutter the preview scroller reserves out of it. The
    // pane used to scale the page to the whole column, so its right edge sat
    // under that gutter and every line lost its tail — the contact line read
    // "+1 650-353-" under a banner that says to approve the resume shown in the
    // preview. This asserts in PARENT space: a check taken inside the iframe
    // compares the document with its own viewport and cannot see this crop.
    const columns = [
      { gutter: 15, label: "1440x920", width: 629 },
      { gutter: 15, label: "1280x720", width: 505 },
    ];
    // The chrome between the region's box and the frame, spelled out here so a
    // change to either padding has to be made in both places: the scroll
    // region's own `p-0.5` (2px a side) and the page shell's 1px border plus
    // `p-1.5` (7px a side).
    const REGION_PADDING = 4;
    const PAGE_SHELL_CHROME = 14;

    for (const column of columns) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "clientWidth",
      );
      Object.defineProperty(Element.prototype, "clientWidth", {
        configurable: true,
        get(this: Element) {
          if (this.hasAttribute("data-resume-preview-width-probe")) {
            return column.width;
          }
          // The scroller is the same box minus the gutter it reserves. That
          // difference is the width the page actually gets.
          return this.hasAttribute("data-resume-preview-scroll-region")
            ? column.width - column.gutter
            : 0;
        },
      });

      const columnObserverCallbacks: ResizeObserverCallback[] = [];
      class ResizeObserverStub {
        private readonly callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        disconnect() {}
        observe(target: Element) {
          if (target.hasAttribute?.("data-resume-preview-width-probe")) {
            columnObserverCallbacks.push(this.callback);
          }
        }
        unobserve() {}
      }
      vi.stubGlobal("ResizeObserver", ResizeObserverStub);

      try {
        const rendered = render(
          <ResumeStudioPreviewPane
            isDirty={false}
            isPending={false}
            onRetry={vi.fn()}
            onSelectTarget={vi.fn()}
            preview={preview}
            previewError={null}
            previewStatus="ready"
            selectedEntryId={null}
            selectedSectionId={null}
            selectedTargetId={null}
            templateLabel="Chronology Classic"
          />,
        );

        expect(columnObserverCallbacks).toHaveLength(1);
        act(() => {
          for (const callback of columnObserverCallbacks) {
            callback(
              [
                { contentRect: { width: column.width } },
              ] as unknown as ResizeObserverEntry[],
              null as unknown as ResizeObserver,
            );
          }
        });

        const iframe = rendered.container.querySelector("iframe");
        const frameWidth = Number.parseFloat(iframe?.style.width ?? "");
        expect(Number.isFinite(frameWidth)).toBe(true);

        // The page, its shell, and the region's padding all have to land inside
        // the region's visible width.
        const visibleRegionWidth = column.width - column.gutter;
        expect({
          column: column.label,
          fits:
            frameWidth + PAGE_SHELL_CHROME + REGION_PADDING <=
            visibleRegionWidth,
        }).toEqual({ column: column.label, fits: true });
      } finally {
        cleanup();
        vi.unstubAllGlobals();
        if (ownDescriptor) {
          Object.defineProperty(
            Element.prototype,
            "clientWidth",
            ownDescriptor,
          );
        } else {
          Reflect.deleteProperty(Element.prototype, "clientWidth");
        }
      }
    }
  });

  it("re-applies the resolved scale to a re-rendered preview document", () => {
    // Every draft re-render replaces the `srcdoc` document, and the fresh body
    // starts at the stylesheet's `--preview-scale: 1` while the frame keeps the
    // width computed for the scaled page. Resolving the scale only on a width
    // change therefore left the reloaded page rendering ~37% too large inside a
    // frame sized for 73%, cutting the right quarter off every line with no
    // horizontal scrollbar to say so.
    const columnWidth = 629;
    const gutter = 15;
    const ownDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "clientWidth",
    );
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        if (this.hasAttribute("data-resume-preview-width-probe")) {
          return columnWidth;
        }
        return this.hasAttribute("data-resume-preview-scroll-region")
          ? columnWidth - gutter
          : 0;
      },
    });

    const documentObserverCallbacks: ResizeObserverCallback[] = [];
    const columnObserverCallbacks: ResizeObserverCallback[] = [];
    class ResizeObserverStub {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      disconnect() {}
      observe(target: Element) {
        if (target.hasAttribute?.("data-resume-preview-width-probe")) {
          columnObserverCallbacks.push(this.callback);
          return;
        }
        documentObserverCallbacks.push(this.callback);
      }
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    const appliedScales: string[] = [];
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(
      function trackPreviewScale(
        this: CSSStyleDeclaration,
        property: string,
        value: string | null,
      ) {
        if (property === "--preview-scale") {
          appliedScales.push(String(value));
        }
      },
    );

    try {
      const rendered = render(
        <ResumeStudioPreviewPane
          isDirty={false}
          isPending={false}
          onRetry={vi.fn()}
          onSelectTarget={vi.fn()}
          preview={preview}
          previewError={null}
          previewStatus="ready"
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          templateLabel="Chronology Classic"
        />,
      );

      act(() => {
        for (const callback of columnObserverCallbacks) {
          callback(
            [
              { contentRect: { width: columnWidth } },
            ] as unknown as ResizeObserverEntry[],
            null as unknown as ResizeObserver,
          );
        }
      });

      const resolvedScale = appliedScales.at(-1);
      expect(resolvedScale).toBeDefined();
      expect(Number.parseFloat(String(resolvedScale))).toBeLessThan(1);

      // The document reloads at an unchanged column width, which is exactly the
      // case the width guard used to skip.
      const iframe = rendered.container.querySelector("iframe");
      const scalesBeforeReload = appliedScales.length;
      act(() => {
        iframe?.dispatchEvent(new Event("load"));
      });

      expect(appliedScales.length).toBeGreaterThan(scalesBeforeReload);
      expect(appliedScales.at(-1)).toBe(resolvedScale);
      // Still one scale: re-applying it is idempotent, never a second value.
      expect(new Set(appliedScales).size).toBe(1);

      // A later measurement on the same document keeps the same value too.
      act(() => {
        for (const callback of documentObserverCallbacks) {
          callback([], null as unknown as ResizeObserver);
        }
      });
      expect(new Set(appliedScales).size).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      if (ownDescriptor) {
        Object.defineProperty(Element.prototype, "clientWidth", ownDescriptor);
      } else {
        Reflect.deleteProperty(Element.prototype, "clientWidth");
      }
    }
  });

  it("re-fits the page when the column width changes without a window resize", () => {
    // jsdom has no layout, so the pane's column width is stubbed on the one
    // element the measurement reads: the zero-height width probe beside the
    // scroll region. Every other element keeps jsdom's own 0.
    let columnWidth = 900;
    const ownDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "clientWidth",
    );
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        return this.hasAttribute("data-resume-preview-width-probe")
          ? columnWidth
          : 0;
      },
    });

    // Only the observer that actually watches the width probe counts. The pane
    // also observes the iframe document, and firing that one instead would let
    // this test pass without the column ever being watched. The probe is
    // deliberately NOT the scroll region: observing the scroller fed the
    // measurement its own output back and zoomed the page in and out.
    const columnObserverCallbacks: ResizeObserverCallback[] = [];
    class ResizeObserverStub {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      disconnect() {}
      observe(target: Element) {
        if (target.hasAttribute?.("data-resume-preview-width-probe")) {
          columnObserverCallbacks.push(this.callback);
        }
      }
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    try {
      render(
        <ResumeStudioPreviewPane
          isDirty={false}
          isPending={false}
          onRetry={vi.fn()}
          onSelectTarget={vi.fn()}
          preview={preview}
          previewError={null}
          previewStatus="ready"
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          templateLabel="Chronology Classic"
        />,
      );

      // A column wide enough for the whole page needs no width control at all.
      expect(screen.queryByText("Fit width")).toBeNull();
      expect(screen.queryByText("Readable size")).toBeNull();

      // The Assistant no longer takes a studio column, so it can never narrow
      // this pane. A sidebar collapse or a split-pane change still can, and
      // only the column's own observer reports that without a window resize.
      columnWidth = 355;
      expect(columnObserverCallbacks).toHaveLength(1);
      const fireColumnObserver = (width: number) => {
        act(() => {
          for (const callback of columnObserverCallbacks) {
            callback(
              [{ contentRect: { width } }] as unknown as ResizeObserverEntry[],
              null as unknown as ResizeObserver,
            );
          }
        });
      };
      fireColumnObserver(columnWidth);

      // The page fits the narrowed column on its own: no click was needed, and
      // the control now offers the larger sideways-scrolling reading size.
      const toggle = screen.getByText("Readable size");
      expect(screen.queryByText("Fit width")).toBeNull();

      // The manual control is still there and still wins: choosing the
      // readable size pins it, and the toggle offers fit width again.
      act(() => {
        fireEvent.click(toggle);
      });
      expect(screen.getByText("Fit width")).toBeInstanceOf(HTMLElement);
      expect(screen.queryByText("Readable size")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      if (ownDescriptor) {
        Object.defineProperty(Element.prototype, "clientWidth", ownDescriptor);
      } else {
        delete (Element.prototype as unknown as Record<string, unknown>)
          .clientWidth;
      }
    }
  });

  it("forwards preview iframe clicks to the editor targeting callback", async () => {
    const onSelectTarget = vi.fn();
    const rendered = render(
      <ResumeStudioPreviewPane
        isDirty={false}
        isPending={false}
        onRetry={vi.fn()}
        onSelectTarget={onSelectTarget}
        preview={preview}
        previewError={null}
        previewStatus="ready"
        selectedEntryId={null}
        selectedSectionId="section_experience"
        selectedTargetId={null}
        templateLabel="Chronology Classic"
      />,
    );

    const iframe = rendered.getByTitle("Live resume preview");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Expected the live preview element to be an iframe.");
    }

    const frameDocument =
      iframe.contentDocument ??
      document.implementation.createHTMLDocument("preview");
    const frameDocumentAddEventListener = vi.spyOn(
      frameDocument,
      "addEventListener",
    );

    if (!iframe.contentDocument) {
      Object.defineProperty(iframe, "contentDocument", {
        configurable: true,
        value: frameDocument,
      });
    }

    await act(async () => {
      iframe.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    frameDocument.body.innerHTML =
      '<article data-resume-section-id="section_experience" data-resume-entry-id="entry_signal_systems" data-resume-target-id="entry:section_experience:entry_signal_systems:summary">Signal Systems</article>';

    const previewTarget = frameDocument.querySelector(
      '[data-resume-entry-id="entry_signal_systems"]',
    );
    if (!previewTarget) {
      throw new Error(
        "Expected preview target to exist in iframe test document.",
      );
    }

    const clickListener = frameDocumentAddEventListener.mock.calls.find(
      (call) => call[0] === "click",
    )?.[1];

    if (typeof clickListener !== "function") {
      throw new Error(
        "Expected preview pane to register a click listener on the iframe document.",
      );
    }

    clickListener({
      target: previewTarget,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent);

    expect(onSelectTarget).toHaveBeenCalledWith({
      sectionId: "section_experience",
      entryId: "entry_signal_systems",
      targetId: "entry:section_experience:entry_signal_systems:summary",
    });
  });

  it("leaves the preview unpainted until the user makes an explicit selection", async () => {
    const rendered = render(
      <ResumeStudioPreviewPane
        isDirty={false}
        isPending={false}
        onRetry={vi.fn()}
        onSelectTarget={vi.fn()}
        preview={preview}
        previewError={null}
        previewStatus="ready"
        selectedEntryId={null}
        selectedSectionId="section_summary"
        selectedTargetId={null}
        templateLabel="Chronology Classic"
      />,
    );

    const iframe = rendered.getByTitle("Live resume preview");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Expected the live preview element to be an iframe.");
    }

    const frameDocument = iframe.contentDocument;
    if (!frameDocument) {
      throw new Error("Expected the live preview document to exist.");
    }

    frameDocument.body.innerHTML =
      '<article data-resume-section-id="section_summary">Summary</article>';
    const summaryTarget = frameDocument.querySelector<HTMLElement>(
      '[data-resume-section-id="section_summary"]',
    );
    if (!summaryTarget) {
      throw new Error("Expected the summary preview target to exist.");
    }
    Object.defineProperty(summaryTarget, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    await act(async () => {
      iframe.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    // The derived default selection must not tint the exported-looking page.
    expect(
      frameDocument.querySelector('[data-resume-selected="true"]'),
    ).toBeNull();

    rendered.rerender(
      <ResumeStudioPreviewPane
        isDirty={false}
        isPending={false}
        onRetry={vi.fn()}
        onSelectTarget={vi.fn()}
        preview={preview}
        previewError={null}
        previewStatus="ready"
        selectionScrollKey={1}
        selectedEntryId={null}
        selectedSectionId="section_summary"
        selectedTargetId={null}
        templateLabel="Chronology Classic"
      />,
    );

    await act(async () => {
      iframe.dispatchEvent(new Event("load"));
      await Promise.resolve();
    });

    expect(
      frameDocument.querySelector('[data-resume-selected="true"]'),
    ).not.toBeNull();
  });

  it("does not throw when the preview document is still parsing on entry, across a compact/desktop resize, or after unmount", () => {
    const widthProbeCallbacks: ResizeObserverCallback[] = [];
    class ResizeObserverStub {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      disconnect() {}
      observe(target: Element) {
        if (target.hasAttribute?.("data-resume-preview-width-probe")) {
          widthProbeCallbacks.push(this.callback);
        }
      }
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    const notifyWidthProbe = (width: number) => {
      act(() => {
        for (const callback of widthProbeCallbacks) {
          callback(
            [{ contentRect: { width } }] as unknown as ResizeObserverEntry[],
            null as unknown as ResizeObserver,
          );
        }
      });
    };

    try {
      const view = render(
        <ResumeStudioPreviewPane
          isDirty={false}
          isPending={false}
          onRetry={vi.fn()}
          onSelectTarget={vi.fn()}
          preview={preview}
          previewError={null}
          previewStatus="ready"
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          templateLabel="Chronology Classic"
        />,
      );

      const iframe = document.querySelector("iframe");
      const frameDocument = iframe?.contentDocument ?? null;
      expect(frameDocument).not.toBeNull();
      expect(widthProbeCallbacks).toHaveLength(1);

      // Chromium commits a `srcdoc` navigation before the parser inserts
      // `<body>`: `contentDocument` is a real document whose `body` is null.
      Object.defineProperty(frameDocument!, "body", {
        configurable: true,
        get: () => null,
      });

      // The width probe's own observer delivers its first entry a frame after
      // mount, which on first entry into the studio lands inside exactly that
      // window.
      expect(() => notifyWidthProbe(900)).not.toThrow();

      // The same measurement runs from the window `resize` listener, so the
      // compact <-> desktop switch must survive it too.
      for (const innerWidth of [1024, 1440]) {
        vi.stubGlobal("innerWidth", innerWidth);
        expect(() =>
          act(() => {
            window.dispatchEvent(new Event("resize"));
          }),
        ).not.toThrow();
      }

      expect(() => view.unmount()).not.toThrow();

      // A late observer entry must not reach the torn-down frame either.
      expect(() => notifyWidthProbe(1200)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ResumeStudioPreviewPane locked-pane ownership", () => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
  }

  function renderReadyPreviewInLayout() {
    return render(
      <LockedScreenLayout topContent={<div>Workspace context</div>}>
        <ResumeStudioPreviewPane
          isDirty
          isPending={false}
          onRetry={vi.fn()}
          onSelectTarget={vi.fn()}
          preview={preview}
          previewError={null}
          previewStatus="ready"
          selectedEntryId={null}
          selectedSectionId="section_summary"
          selectedTargetId={null}
          templateLabel="Chronology Classic"
        />
      </LockedScreenLayout>,
    );
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("innerWidth", 1440);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not scroll the locked Resume route for its initial selection", async () => {
    let outerScroller: HTMLElement | null = null;
    const scrollIntoView = vi.fn(() => {
      // Chromium can move the locked route owner when an iframe target calls
      // scrollIntoView. Model the observed hidden-title state without relying
      // on jsdom layout calculations.
      if (outerScroller) {
        outerScroller.scrollTop = 84;
      }
    });
    const originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    let previewTarget: HTMLElement | null = null;
    let originalPreviewTargetScrollIntoViewDescriptor:
      | PropertyDescriptor
      | undefined;

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const rendered = render(
        <LockedScreenLayout
          topContent={
            <h1 data-testid="resume-route-title">Resume workspace</h1>
          }
        >
          <ResumeStudioPreviewPane
            isDirty={false}
            isPending={false}
            onRetry={vi.fn()}
            onSelectTarget={vi.fn()}
            preview={preview}
            previewError={null}
            previewStatus="ready"
            selectionScrollKey={0}
            selectedEntryId={null}
            selectedSectionId="section_summary"
            selectedTargetId={null}
            templateLabel="Chronology Classic"
          />
        </LockedScreenLayout>,
      );
      outerScroller = rendered.container.querySelector<HTMLElement>(
        "[data-locked-screen-scroll-area]",
      );
      const iframe = rendered.getByTitle("Live resume preview");
      if (!(iframe instanceof HTMLIFrameElement)) {
        throw new Error("Expected the live preview element to be an iframe.");
      }
      await act(async () => {
        await Promise.resolve();
      });

      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(outerScroller?.scrollTop).toBe(0);
      expect(rendered.getByTestId("resume-route-title")).toBeTruthy();

      const frameDocument = iframe.contentDocument;
      if (!frameDocument) {
        throw new Error("Expected the live preview document to exist.");
      }
      frameDocument.body.innerHTML =
        '<article data-resume-section-id="section_summary">Summary</article>';
      previewTarget = frameDocument.querySelector<HTMLElement>(
        '[data-resume-section-id="section_summary"]',
      );
      if (!previewTarget) {
        throw new Error("Expected the selected preview target to exist.");
      }
      originalPreviewTargetScrollIntoViewDescriptor =
        Object.getOwnPropertyDescriptor(previewTarget, "scrollIntoView");
      Object.defineProperty(previewTarget, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      });
      await act(async () => {
        iframe.dispatchEvent(new Event("load"));
        await Promise.resolve();
      });

      rendered.rerender(
        <LockedScreenLayout
          topContent={
            <h1 data-testid="resume-route-title">Resume workspace</h1>
          }
        >
          <ResumeStudioPreviewPane
            isDirty={false}
            isPending={false}
            onRetry={vi.fn()}
            onSelectTarget={vi.fn()}
            preview={preview}
            previewError={null}
            previewStatus="ready"
            selectionScrollKey={1}
            selectedEntryId={null}
            selectedSectionId="section_summary"
            selectedTargetId={null}
            templateLabel="Chronology Classic"
          />
        </LockedScreenLayout>,
      );

      await act(async () => {
        iframe.dispatchEvent(new Event("load"));
        await Promise.resolve();
      });

      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "auto",
        block: "nearest",
      });
      expect(outerScroller?.scrollTop).toBe(84);
    } finally {
      if (originalScrollIntoViewDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoViewDescriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }

      if (previewTarget) {
        if (originalPreviewTargetScrollIntoViewDescriptor) {
          Object.defineProperty(
            previewTarget,
            "scrollIntoView",
            originalPreviewTargetScrollIntoViewDescriptor,
          );
        } else {
          Reflect.deleteProperty(previewTarget, "scrollIntoView");
        }
      }
    }
  });

  it("marks the preview scroller as an owned locked-pane region", () => {
    const rendered = render(
      <ResumeStudioPreviewPane
        isDirty
        isPending={false}
        onRetry={vi.fn()}
        onSelectTarget={vi.fn()}
        preview={preview}
        previewError={null}
        previewStatus="ready"
        selectedEntryId={null}
        selectedSectionId="section_summary"
        selectedTargetId={null}
        templateLabel="Chronology Classic"
      />,
    );

    const region = rendered.container.querySelector<HTMLElement>(
      "[data-resume-preview-scroll-region]",
    );

    expect(region?.hasAttribute("data-locked-pane-scroll-region")).toBe(true);
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("aria-label")).toBe("Live resume preview");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(
      region?.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(0);
  });

  it("leaves the wheel to the preview scroller natively while it has range", () => {
    const rendered = renderReadyPreviewInLayout();

    const region = rendered.container.querySelector<HTMLElement>(
      "[data-resume-preview-scroll-region]",
    );
    if (!(region instanceof HTMLElement)) {
      throw new Error("Expected the preview scroll region to render.");
    }
    Object.defineProperties(region, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_600 },
    });
    region.scrollTop = 100;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 120,
    });
    if (!(region.firstElementChild instanceof HTMLElement)) {
      throw new Error("Expected preview content under the scroll region.");
    }
    region.firstElementChild.dispatchEvent(wheelEvent);

    // The preview region still has range in this direction, so the browser
    // keeps ownership and the layout does not forward the delta by hand.
    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(region.scrollTop).toBe(100);
  });

  it("keeps preview keyboard scrolling on the focused region and Space with controls", () => {
    const rendered = renderReadyPreviewInLayout();

    const region = rendered.container.querySelector<HTMLElement>(
      "[data-resume-preview-scroll-region]",
    );
    if (!(region instanceof HTMLElement)) {
      throw new Error("Expected the preview scroll region to render.");
    }
    Object.defineProperties(region, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_600 },
    });
    region.focus();

    const arrowDown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    region.dispatchEvent(arrowDown);
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(region.scrollTop).toBe(40);

    const refreshButton = screen.getByRole("button", {
      name: /refresh preview/i,
    });
    expect(fireEvent.keyDown(refreshButton, { key: " " })).toBe(true);
  });
});
