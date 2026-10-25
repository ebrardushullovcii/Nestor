export interface ChunkTextOptions {
  maxChars?: number;
  overlapChars?: number;
  minChunkChars?: number;
  minLeadingChunkChars?: number;
}

export interface TextChunk {
  text: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
}

const DEFAULT_MAX_CHARS = 420;
const DEFAULT_OVERLAP_CHARS = 60;
const DEFAULT_MIN_CHUNK_CHARS = 120;

export function normalizeTextForChunking(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").trim();
}

export function chunkText(
  text: string,
  options: ChunkTextOptions = {},
): readonly TextChunk[] {
  const normalizedText = normalizeTextForChunking(text);

  if (normalizedText.length === 0) {
    return [];
  }

  const maxChars = Math.max(100, options.maxChars ?? DEFAULT_MAX_CHARS);
  const overlapChars = Math.max(
    0,
    Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, maxChars / 2),
  );
  const minChunkChars = Math.max(
    1,
    Math.min(options.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS, maxChars),
  );
  const minLeadingChunkChars = Math.max(
    1,
    Math.min(options.minLeadingChunkChars ?? minChunkChars, minChunkChars),
  );

  const chunks: TextChunk[] = [];
  let startOffset = 0;
  let chunkIndex = 0;

  while (startOffset < normalizedText.length) {
    let endOffset = Math.min(normalizedText.length, startOffset + maxChars);

    if (endOffset < normalizedText.length) {
      const preferredBreak = findPreferredBreak(normalizedText, startOffset, endOffset);
      // Avoid tiny leading chunks by only honoring softer breakpoints after the
      // configured leading threshold has been crossed.
      if (preferredBreak > startOffset + minLeadingChunkChars) {
        endOffset = preferredBreak;
      }
    }

    const chunkTextValue = normalizedText.slice(startOffset, endOffset).trim();
    if (chunkTextValue.length > 0) {
      chunks.push({
        text: chunkTextValue,
        chunkIndex,
        startOffset,
        endOffset,
      });
      chunkIndex += 1;
    }

    if (endOffset >= normalizedText.length) {
      break;
    }

    const nextStart = Math.max(startOffset + 1, endOffset - overlapChars);
    startOffset = normalizeLeadingWhitespace(normalizedText, nextStart);
  }

  const lastChunk = chunks.at(-1);
  const previousChunk = chunks.at(-2);
  if (
    lastChunk &&
    previousChunk &&
    lastChunk.text.length < minChunkChars
  ) {
    previousChunk.text = normalizedText
      .slice(previousChunk.startOffset, lastChunk.endOffset)
      .trim();
    previousChunk.endOffset = lastChunk.endOffset;
    chunks.pop();
  }

  return chunks;
}

function findPreferredBreak(text: string, startOffset: number, endOffset: number): number {
  const window = text.slice(startOffset, endOffset);
  const breakPatterns = ["\n\n", ". ", "! ", "? ", "; ", ", ", " "];

  for (const pattern of breakPatterns) {
    const index = window.lastIndexOf(pattern);
    if (index >= 0) {
      return startOffset + index + pattern.length;
    }
  }

  return endOffset;
}

function normalizeLeadingWhitespace(text: string, startOffset: number): number {
  let offset = startOffset;
  while (offset < text.length && /\s/.test(text[offset] ?? "")) {
    offset += 1;
  }
  return offset;
}
