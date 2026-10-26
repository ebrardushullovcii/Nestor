import type { Response } from "playwright";

/** A successful status does not override an explicit refusal in its response body. */
export function mutationResponseSaysError(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 2) return false;
  if (Array.isArray(value))
    return value.some((entry) => mutationResponseSaysError(entry, depth + 1));
  const body = value as Record<string, unknown>;
  const present = (entry: unknown) =>
    entry === true ||
    (typeof entry === "string" && entry.trim().length > 0) ||
    (Array.isArray(entry) && entry.length > 0) ||
    (typeof entry === "object" &&
      entry !== null &&
      Object.keys(entry).length > 0);
  if (present(body.error) || present(body.errors) || present(body.errorCode))
    return true;
  if (body.success === false || body.ok === false || body.uploaded === false)
    return true;
  if (typeof body.statusCode === "number" && body.statusCode >= 400)
    return true;
  if (
    typeof body.statusCode === "string" &&
    /^\d{3}$/u.test(body.statusCode.trim()) &&
    Number(body.statusCode) >= 400
  )
    return true;
  if (
    typeof body.status === "string" &&
    /^(?:error|failed|failure|fail|rejected|invalid)$/iu.test(body.status)
  )
    return true;
  return (
    mutationResponseSaysError(body.data, depth + 1) ||
    mutationResponseSaysError(body.result, depth + 1)
  );
}

/** Bounded response inspection shared by step saves and attachment acceptance. */
export async function inspectMutationResponse(
  response: Pick<Response, "status" | "headers" | "text">,
): Promise<{ accepted: boolean; body: unknown }> {
  const status = response.status();
  if (status < 200 || status >= 300) return { accepted: false, body: null };
  const type = (response.headers()["content-type"] ?? "").toLowerCase();
  if (!type.includes("json") && !type.startsWith("text/"))
    return { accepted: true, body: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([
    response.text().catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (text === null || text.length > 64_000)
    return { accepted: false, body: null };
  let body: unknown = null;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    if (type.includes("json")) return { accepted: false, body: null };
  }
  return { accepted: !mutationResponseSaysError(body), body };
}
