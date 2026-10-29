import type { ApplyRequestPermit } from "@nestor/contracts";
const refusal =
  /(?<![\p{L}\p{N}])(?:fail(?:ed|ure|s)?|reject(?:ed|s)?|den(?:y|ied)|forbidden|invalid|unsupported|unsuccessful|not (?:allowed|accepted|supported|permitted|successful|saved|uploaded|complete(?:d)?|valid)|too (?:large|big)|exceed(?:s|ed)?|errors?|could ?n[o']t|cannot|unable|fehlgeschlagen|abgelehnt|ungültig|nicht (?:erfolgreich|gespeichert|erlaubt))(?![\p{L}\p{N}])/iu;
const noError =
  /^(?:none|null|nil|false|no|0|(?:no|zero|0)\s+errors?|without\s+errors?)$/iu;

function refuses(text: string): boolean {
  const wording = text
    .normalize("NFKC")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(?:nbsp|#160);/giu, " ")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(
      /\b(?:no|without|zero|0)\s+(?:(?:any|further)\s+)?(?:errors?|failures?|rejections?|invalid(?:\s+fields?)?)\b/giu,
      " ",
    )
    .replace(/\b(?:errors?|failures?)\s*[:=]?\s*(?:none|zero|0)\b/giu, " ");
  return refusal.test(wording);
}
function presentError(value: unknown): boolean {
  if (typeof value === "string")
    return !!value.trim() && !noError.test(value.trim());
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return (
    value === true ||
    (!!value && typeof value === "object" && Object.keys(value).length > 0)
  );
}
const errorStatus = (value: unknown) =>
  typeof value === "number"
    ? value >= 400
    : typeof value === "string" &&
      /^\d{3}$/u.test(value.trim()) &&
      Number(value) >= 400;

/** Inspect every nesting key; a success status cannot override a refusal. */
export function mutationResponseSaysError(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (depth === 0 && (value === false || value === 0)) return true;
  if (typeof value === "string") return refuses(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((entry) => mutationResponseSaysError(entry, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([name, item]) => {
      const key = name.replace(/[-_\s]/gu, "").toLowerCase();
      if (
        /(?:errors?|errorcode|errormessage)$/u.test(key) &&
        presentError(item)
      )
        return true;
      if (
        /^(?:success|ok|uploaded|valid|saved|accepted)$/u.test(key) &&
        item === false
      )
        return true;
      if (
        (key === "status" || key === "statuscode") &&
        (errorStatus(item) || (typeof item === "string" && refuses(item)))
      )
        return true;
      return mutationResponseSaysError(item, depth + 1);
    },
  );
}

function withinInspectionDepth(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object") return true;
  if (depth > 8) return false;
  return Object.values(value).every((entry) =>
    withinInspectionDepth(entry, depth + 1),
  );
}

export type MutationResponseJudgment = "accepted" | "refused" | "unconfirmed";
export interface MutationResponseInspection {
  judgment: MutationResponseJudgment;
  /** Compatibility for callers: unconfirmed never counts as accepted. */
  accepted: boolean;
  body: unknown;
}
const result = (
  judgment: MutationResponseJudgment,
  body: unknown = null,
): MutationResponseInspection => ({
  judgment,
  accepted: judgment === "accepted",
  body,
});

/** Compatibility alias; the fence and response reader share the contracts type. */
export type MutationResponsePermit = ApplyRequestPermit;
export interface MutationResponseConfirmation {
  permit: ApplyRequestPermit;
}
interface InspectableMutationResponse {
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
  url?: () => string;
  request?: () => MutationResponsePermit["authorizedCarrier"];
}
function permittedResponse(
  response: InspectableMutationResponse,
  permit: MutationResponsePermit,
): boolean {
  try {
    return (
      response.request?.() === permit.authorizedCarrier &&
      response.url?.() === permit.endpoint &&
      permit.authorizedCarrier.url() === permit.endpoint &&
      permit.authorizedCarrier.method().toUpperCase() === permit.method &&
      new URL(permit.authorizedCarrier.frame().url()).origin ===
        permit.frameOrigin &&
      ["POST", "PUT", "PATCH"].includes(permit.method)
    );
  } catch {
    return false;
  }
}
function isUpload(permit: ApplyRequestPermit): boolean {
  if (permit.actionKind !== "upload" || permit.uploadLeg !== "file")
    return false;
  const file = permit.file;
  return (
    ["POST", "PUT"].includes(permit.method) &&
    !!file.name.trim() &&
    Number.isSafeInteger(file.size) &&
    file.size > 0 &&
    /^[a-f0-9]{64}$/u.test(file.sha256)
  );
}
function uploadReceipt(
  value: unknown,
  depth = 0,
  fileContext = false,
): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  const token = (item: unknown) =>
    typeof item === "number"
      ? Number.isSafeInteger(item) && item > 0
      : typeof item === "string" &&
        /^[\w./:%?&#=+~-]+$/u.test(item) &&
        !/^(?:none|null|false|unknown|pending|0)$/iu.test(item);
  return Object.entries(value).some(([name, item]) => {
    const key = name.replace(/[-_\s]/gu, "").toLowerCase();
    if (
      (["uploadid", "fileid", "attachmentid", "key"].includes(key) ||
        /^(?:upload|file|attachment|document|resume)storageid$/u.test(key) ||
        (key === "id" && fileContext) ||
        (key === "location" &&
          typeof item === "string" &&
          /^https?:\/\//u.test(item))) &&
      token(item)
    )
      return true;
    return uploadReceipt(
      item,
      depth + 1,
      ["upload", "file", "attachment"].includes(key),
    );
  });
}

const PENDING_STATE =
  /^(?:pending|queued|allocated|initiated|reserved|processing|in[-_\s]?progress|uploading|waiting|started|scheduled)$/iu;

/** Whether an answer says its upload has not finished yet. */
function uploadStillPending(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  return Object.entries(value).some(([name, item]) => {
    const key = name.replace(/[-_\s]/gu, "").toLowerCase();
    if (
      ["status", "state", "uploadstatus", "uploadstate", "phase"].includes(
        key,
      ) &&
      typeof item === "string" &&
      PENDING_STATE.test(item.trim())
    )
      return true;
    if (key === "complete" || key === "completed" || key === "done")
      if (item === false) return true;
    return uploadStillPending(item, depth + 1);
  });
}

/** Acceptance is permit plus structural proof. Wording can only block it. */
export async function inspectMutationResponse(
  response: InspectableMutationResponse,
  confirmation?: MutationResponseConfirmation,
): Promise<MutationResponseInspection> {
  const status = response.status(),
    headers = response.headers();
  if (status < 200 || status >= 300)
    return result(status >= 400 ? "refused" : "unconfirmed");
  if (
    !confirmation ||
    !permittedResponse(response, confirmation.permit) ||
    !isUpload(confirmation.permit)
  )
    return result("unconfirmed");
  const upload = isUpload(confirmation.permit);
  // 202 and its kin: the storage took the request, not yet the file.
  if (status !== 200 && status !== 201 && status !== 204)
    return result("unconfirmed");
  // S3 answers a finished POST with an empty 204, and a finished PutObject
  // with an empty 200 and the object's ETag.
  const empty = Number(headers["content-length"] ?? 0) === 0;
  if (status === 204)
    return result(upload && empty ? "accepted" : "unconfirmed");
  if (Number(headers["content-length"] ?? 0) > 64_000)
    return result("unconfirmed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([
    response.text().catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 2000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (text !== null && !text.trim() && status === 200 && headers.etag?.trim())
    return result(upload ? "accepted" : "unconfirmed");
  if (text === null || text.length > 64_000 || !text.trim())
    return result("unconfirmed");
  let body: unknown;
  try {
    body = JSON.parse(text);
    if (mutationResponseSaysError(body)) return result("refused", body);
    if (!withinInspectionDepth(body)) return result("unconfirmed", body);
    // A handle for an upload that is still pending, queued or allocated is
    // not a finished one.
    if (uploadStillPending(body)) return result("unconfirmed", body);
    return result(
      upload && uploadReceipt(body) ? "accepted" : "unconfirmed",
      body,
    );
  } catch {
    /* Only a recognized storage response can confirm an upload. */
  }
  if (/<(?:[\w.-]+:)?Error(?:\s|>|\/)/iu.test(text) || refuses(text))
    return result("refused", text);
  const xml = text.trim().replace(/^<\?xml[^>]*>\s*/iu, "");
  const postResponse =
    /^<(?:[\w.-]+:)?PostResponse(?:\s[^>]*)?>[\s\S]*<\/(?:[\w.-]+:)?PostResponse>\s*$/iu.test(
      xml,
    );
  return result(upload && postResponse ? "accepted" : "unconfirmed", text);
}
