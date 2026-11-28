type PasswordOrigin =
  | { origin: string }
  | { httpUrl: URL }
  | {
      skipped: "androidApp" | "unsupportedOrigin" | "invalid";
    };

function classifyPasswordOrigin(value: string): PasswordOrigin {
  try {
    const url = new URL(value);
    if (url.protocol === "android:")
      return { skipped: url.hostname ? "androidApp" : "invalid" };
    if (url.username || url.password) return { skipped: "unsupportedOrigin" };
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      return { origin: url.origin };
    if (url.protocol === "http:") return { httpUrl: url };
    return { skipped: "unsupportedOrigin" };
  } catch {
    return { skipped: "invalid" };
  }
}

export function passwordImportOrigin(value: string) {
  const result = classifyPasswordOrigin(value);
  if ("skipped" in result) return result;
  if ("origin" in result) return { ...result, upgradedToHttps: false };
  // Match Chromium's scheme replacement on the parsed URL: the old
  // default port is already gone and nondefault ports keep their meaning.
  result.httpUrl.protocol = "https:";
  return { origin: result.httpUrl.origin, upgradedToHttps: true };
}

/** Exact origins only: no suffix matching, HTTP downgrade, userinfo or opaque origins. */
export function passwordOrigin(value: string): string | null {
  const result = classifyPasswordOrigin(value);
  return "origin" in result ? result.origin : null;
}

export function passwordOriginsMatch(
  topUrl: string,
  frameUrl: string,
  actionUrl: string,
  savedOrigin: string,
): boolean {
  const origin = passwordOrigin(topUrl);
  return (
    origin !== null &&
    origin === savedOrigin &&
    passwordOrigin(frameUrl) === origin &&
    passwordOrigin(actionUrl) === origin
  );
}
