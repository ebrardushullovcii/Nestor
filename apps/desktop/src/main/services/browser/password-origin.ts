type PasswordImportOrigin =
  | { origin: string }
  | {
      skipped: "insecureHttp" | "androidApp" | "unsupportedOrigin" | "invalid";
    };

export function passwordImportOrigin(value: string): PasswordImportOrigin {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    )
      return { origin: url.origin };
    if (url.protocol === "http:" && !loopback)
      return { skipped: "insecureHttp" };
    if (url.protocol === "android:")
      return { skipped: url.hostname ? "androidApp" : "invalid" };
    return { skipped: "unsupportedOrigin" };
  } catch {
    return { skipped: "invalid" };
  }
}

/** Exact origins only: no suffix matching, HTTP downgrade, userinfo or opaque origins. */
export function passwordOrigin(value: string): string | null {
  const result = passwordImportOrigin(value);
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
