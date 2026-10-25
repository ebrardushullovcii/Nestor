import { useEffect, useRef, useState } from "react";

/** A letter page at 96 px per inch, the size the renderer lays out. */
const PAGE_WIDTH = 816;
const PAGE_HEIGHT = 1056;

/**
 * The rendered resume, scaled to fit its column so the whole page width is
 * readable without sideways scrolling.
 */
export function ResumePreview(props: {
  preview: { html: string; pageCount: number | null } | null;
  error: string | null;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? PAGE_WIDTH;
      setScale(Math.min(1, width / PAGE_WIDTH));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const height = PAGE_HEIGHT * Math.max(1, props.preview?.pageCount ?? 1);

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto rounded-(--radius-field) border border-(--surface-panel-border) bg-(--resume-preview-frame) p-2"
      ref={frameRef}
    >
      {props.preview ? (
        <div style={{ height: height * scale, width: PAGE_WIDTH * scale }}>
          <iframe
            // Read-only: clicks and keys stay with the screen, so Ctrl+Enter
            // still approves after the page was clicked.
            className="pointer-events-none origin-top-left rounded-(--radius-field) border-0 bg-card"
            srcDoc={props.preview.html}
            style={{
              height,
              transform: `scale(${scale})`,
              width: PAGE_WIDTH,
            }}
            tabIndex={-1}
            title="Resume preview"
          />
        </div>
      ) : (
        <p
          className="p-6 text-center text-sm text-foreground-soft"
          role="status"
        >
          {props.error ?? "Drawing the preview…"}
        </p>
      )}
    </div>
  );
}
