import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@renderer/lib/cn";

/**
 * A line that is shown whole or in shorter words, never cut mid-word ("Last
 * sea…"): the first of `candidates` (longest first) that fits the room on
 * one line. When even the shortest does not fit, the line is empty and the
 * box carries `data-fit-none` (a button around it can hide itself); the
 * full text stays its tooltip and its accessible text, so nothing is lost
 * to a screen reader. Spans only, so it fits inside a row's button.
 */
export function FitText(props: {
  candidates: readonly string[];
  /** The words' type: size, colour. */
  className?: string;
  /** The box's own sizing in its row; `min-w-0 flex-1` by default. */
  boxClassName?: string;
  /**
   * The room the line may take, when that is not the box's own width (a
   * box sized to its words, capped at half the line). It must not depend on
   * the line's own width, or each choice would change the room it is
   * measured against.
   */
  room?: (box: HTMLElement) => number;
  /**
   * The elements whose size changes the room, watched as well as the box;
   * with `room`, the box's parent and grandparent by default.
   */
  watch?: (box: HTMLElement) => readonly (Element | null | undefined)[];
  /** The tooltip; the full text by default. Null for none. */
  title?: string | null;
  /** Extra props for the visible line (role, aria-live, data attributes). */
  lineProps?: React.HTMLAttributes<HTMLSpanElement> &
    Record<`data-${string}`, string | boolean | undefined>;
}) {
  const { candidates } = props;
  const boxRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const roomRef = useRef(props.room);
  roomRef.current = props.room;
  const watchRef = useRef(props.watch);
  watchRef.current = props.watch;
  const [shown, setShown] = useState(0);
  const key = candidates.join("\u0000");
  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return undefined;
    const pick = () => {
      const room = roomRef.current ? roomRef.current(box) : box.clientWidth;
      // jsdom and a hidden box measure nothing: keep the line as it is (the
      // full text until a real measure). Resetting here would let a room
      // that collapses with its line bring the full text back in a loop.
      if (room <= 0) return;
      const widths = [...measure.children].map(
        (child) => (child as HTMLElement).scrollWidth,
      );
      // Nothing measured (a hidden line): no choice to make yet.
      if (widths.every((width) => width === 0)) return;
      // Whole pixels, with one to spare: a line a fraction wider than its
      // box would still end in an ellipsis.
      const fits = widths.findIndex((width) => width <= Math.floor(room) - 1);
      setShown(fits === -1 ? widths.length : fits);
    };
    setShown(0);
    pick();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(pick);
    observer.observe(box);
    // A box sized by its words measures its room elsewhere: watch the boxes
    // the row resizes.
    if (roomRef.current) {
      const watched = watchRef.current
        ? watchRef.current(box)
        : [box.parentElement, box.parentElement?.parentElement];
      for (const element of watched) if (element) observer.observe(element);
    }
    return () => observer.disconnect();
    // `key` stands for the candidates' words.
  }, [key]);
  const full = candidates[0] ?? "";
  const text = candidates[shown];
  return (
    <span
      className={cn(
        "relative block overflow-hidden",
        props.boxClassName ?? "min-w-0 flex-1",
      )}
      data-fit-none={text === undefined ? "" : undefined}
      ref={boxRef}
    >
      <span
        aria-hidden="true"
        // Each candidate at its own width (a grid column would stretch them
        // all to the longest).
        className="invisible absolute top-0 left-0 flex w-max flex-col items-start"
        ref={measureRef}
      >
        {/* Measured through generated content, so the words are on the
            page once (find in page, tests and copy see only the line). */}
        {candidates.map((candidate) => (
          <span
            className={cn(
              "whitespace-nowrap after:content-[attr(data-text)]",
              props.className,
            )}
            data-text={candidate}
            key={candidate}
          />
        ))}
      </span>
      <span
        {...props.lineProps}
        className={cn("block whitespace-nowrap", props.className)}
        {...(props.title === null ? {} : { title: props.title ?? full })}
      >
        {text ?? <span className="sr-only">{full}</span>}
      </span>
    </span>
  );
}

/** Words that open a qualifying phrase: a reason may end before one, whole. */
const PHRASE_OPENERS =
  /^(than|but|because|since|while|with|without|for|across|on|in|at|from|compared|via)$/iu;
/** Words a cut line must not end on ("than…", "your…" say nothing). */
const WEAK_ENDINGS =
  /^(a|an|the|and|or|of|to|your|their|its|than|but|with|for|on|in|at|from|by|as|is|are|you|we|they|it)$/iu;

/**
 * Shorter forms of a sentence for {@link FitText}, in order of preference:
 * the whole text, its first clause (to the first ";" or sentence end), then
 * that clause ended whole before a qualifying phrase ("Fewer frontend
 * duties than you want" is "Fewer frontend duties", never "Fewer frontend
 * duties than…"), then, shorter than any whole phrase, the clause cut a
 * word at a time down to two words, marked "…", never ending on a word that
 * says nothing by itself.
 */
export function shorterWords(text: string): string[] {
  const lines = [text];
  const clause = text.split(/;\s|\.\s/u)[0]!.replace(/[.;,\s]+$/u, "");
  if (clause && clause !== text) lines.push(clause);
  const words = clause.split(/\s+/u);
  let shortestWhole = words.length;
  for (let count = words.length - 1; count >= 2; count -= 1)
    if (PHRASE_OPENERS.test(words[count]!)) {
      lines.push(
        words
          .slice(0, count)
          .join(" ")
          .replace(/[,;:·-]+$/u, ""),
      );
      shortestWhole = count;
    }
  for (let count = shortestWhole - 1; count >= 2; count -= 1) {
    const last = words[count - 1]!.replace(/[,;:·-]+$/u, "");
    if (WEAK_ENDINGS.test(last)) continue;
    lines.push(
      `${words
        .slice(0, count)
        .join(" ")
        .replace(/[,;:·-]+$/u, "")}…`,
    );
  }
  return [...new Set(lines)];
}

/** A sentence cut a word at a time down to two words, each marked "…". */
function cutWithEllipsis(text: string): string[] {
  const words = text.replace(/[.;,\s]+$/u, "").split(/\s+/u);
  const lines: string[] = [];
  for (let count = words.length - 1; count >= 2; count -= 1) {
    const last = words[count - 1]!.replace(/[,;:·-]+$/u, "");
    if (WEAK_ENDINGS.test(last)) continue;
    lines.push(
      `${words
        .slice(0, count)
        .join(" ")
        .replace(/[,;:·-]+$/u, "")}…`,
    );
  }
  return lines;
}

/**
 * A fit reason's lines for {@link FitText}: the whole reason, then its
 * short form the fit step wrote ("Less frontend than you want"), then that
 * short form cut with "…". With no short form (older rows) the whole reason
 * is cut with "…". A clause is never dropped and shown as if it were the
 * whole reason: "Fewer frontend duties" lost what it was compared with.
 */
export function reasonLines(text: string, short?: string | null): string[] {
  const shortText = short?.trim();
  const base = shortText && shortText !== text ? shortText : null;
  return [
    ...new Set([
      text,
      ...(base ? [base] : []),
      ...cutWithEllipsis(base ?? text),
    ]),
  ];
}
