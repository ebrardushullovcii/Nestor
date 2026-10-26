/** Preserve meaningful punctuation before a question/claim normalizer removes prose punctuation. */
export function preserveTechnologyTokens(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\b([\p{L}][\p{L}\p{N}]*)\+\+(?!\+)/giu, "$1plusplus")
    .replace(/\b([\p{L}][\p{L}\p{N}]*)#(?![\p{L}\p{N}])/giu, "$1sharp")
    .replace(/(?<![\p{L}\p{N}])\.([\p{L}][\p{L}\p{N}]+)/giu, "dot$1")
    .replace(
      /\b([\p{L}][\p{L}\p{N}]*)\.([\p{L}][\p{L}\p{N}]*)\b/giu,
      "$1dot$2",
    );
}
