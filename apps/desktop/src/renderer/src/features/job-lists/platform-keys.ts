/**
 * Shortcut hints in the platform's own words: ⌘A on macOS, Ctrl+A elsewhere.
 * Read from the renderer's navigator, as the shell's first frame does, so a
 * list toolbar never has to wait for the bridge to name a key.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform.toLowerCase();
  return (
    platform.includes("mac") ||
    navigator.userAgent.toLowerCase().includes("macintosh")
  );
}

/** A modifier shortcut as it reads in a hint: "⌘ + A" or "Ctrl + A". */
export function modShortcut(key: string): string {
  return isMacPlatform() ? `⌘ + ${key}` : `Ctrl + ${key}`;
}
