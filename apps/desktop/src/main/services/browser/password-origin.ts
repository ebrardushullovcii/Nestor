/** Exact origins only: no suffix matching, HTTP downgrade, userinfo or opaque origins. */
export function passwordOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
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
