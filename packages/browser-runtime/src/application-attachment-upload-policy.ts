import { createHash } from "node:crypto";
import { readGraphQlRequest, variableStrings } from "./graphql-request";
import { FINAL_ACTION_SIGNAL as finalSignal } from "./application-intermediate-mutation-policy";
import {
  carriesPreparedValue,
  requestUrlCarriesPreparedValue,
} from "./application-read-request-policy";

export interface AttachmentUploadWindow {
  sourceOrigin: string;
  fileName: string;
  byteLength: number;
  sha256: string;
  mimeType: string;
  expiresAtMs: number;
  remainingRequests: number;
  /** The file input's own name or id, when it has one. */
  field?: string | null;
  /** Where the presign was asked: the bind goes back to the same place. */
  presignEndpoint?: string;
  /** The handles and keys the presign's answer handed out. */
  handles?: string[];
  /** Set to one once the storage took the file: the one bind that may follow. */
  bindsRemaining?: number;
  /** When the request carrying the file was answered, whatever the answer. */
  fileAnsweredAtMs?: number;
}

// A résumé parser (Lever's `/parseResume`) takes the file the same way.
const uploadSignal =
  /(?:^|[^a-z0-9])(?:uploads?|attachments?|files?|objects?|blobs?|storage|documents?|resumes?|cvs?)(?:[^a-z0-9]|$)/iu;

/**
 * A file's name as a site may rewrite it before sending: Lever turns spaces
 * and other punctuation into underscores. The bytes are still checked
 * exactly; this only stops a renamed copy from reading as another file.
 */
export function sameAttachmentName(sent: string, chosen: string): boolean {
  const plain = (name: string) =>
    name
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}.-]+/gu, "_")
      .replace(/^[._]+|[._]+$/gu, "")
      .toLowerCase();
  return sent === chosen || plain(sent) === plain(chosen);
}
const splitCase = (value: string) =>
  value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");

function containsPreparedAnswer(
  text: string,
  answers: readonly string[],
): boolean {
  if (carriesPreparedValue(text, answers)) return true;
  const compact = (value: string) =>
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en")
      .replace(/[^\p{L}\p{N}]/gu, "");
  const haystack = compact(text);
  return answers.some((answer) => {
    const needle = compact(answer);
    return needle.length >= 3
      ? haystack.includes(needle)
      : text === answer.trim();
  });
}

/** The authorized filename may be embedded in a signed key or decoded policy. */
function withoutAttachmentName(text: string, fileName: string): string {
  let value = text.split(fileName).join("");
  for (let pass = 0; pass < 2; pass++) {
    try {
      const decoded = decodeURIComponent(value);
      value = decoded.split(fileName).join("");
      if (decoded === value && !/%[\da-f]{2}/iu.test(value)) break;
    } catch {
      break;
    }
  }
  return value;
}

function uploadMetadata(
  value: unknown,
  grant: AttachmentUploadWindow,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (/^(?:input|file|metadata)$/iu.test(key))
      return item === null || uploadMetadata(item, grant);
    if (/^(?:file_?name|name)$/iu.test(key)) return item === grant.fileName;
    if (/^(?:file_?size|size|content_?length)$/iu.test(key))
      return item === grant.byteLength;
    if (/^(?:mime_?type|content_?type)$/iu.test(key))
      return item === grant.mimeType;
    // Ashby names the board and the upload's purpose: short words, never an
    // answer (checked by the caller).
    if (/^(?:organizationHostedJobsPageName|fileUploadContext)$/u.test(key))
      return typeof item === "string" && /^[\w.-]{1,100}$/u.test(item);
    return false;
  });
}

const UPLOAD_HANDLE_FIELD =
  /^(?:(?:get|create|prepare|request)?(?:file|attachment)?upload(?:handle|url|target|token|session)|presign(?:file)?upload)$/iu;

/**
 * Recognize only a file-upload handle operation, never application or user
 * writes. Read with the GraphQL parser: one operation whose single root field
 * asks for an upload handle, every argument a variable, no variable
 * defaults, and variables that describe the selected file and nothing else.
 */
function presignRequest(
  body: string,
  grant: AttachmentUploadWindow,
  preparedAnswers: readonly string[],
): boolean {
  if (body.length > 16_384 || finalSignal.test(splitCase(body))) return false;
  const operations = readGraphQlRequest(body);
  if (operations?.length !== 1) return false;
  const operation = operations[0]!;
  if (
    operation.type === "subscription" ||
    operation.rootFields.length !== 1 ||
    !UPLOAD_HANDLE_FIELD.test(operation.rootFields[0]!.name.value) ||
    operation.inlineArguments > 0 ||
    operation.variableDefaults > 0 ||
    !uploadMetadata(operation.variables ?? {}, grant)
  )
    return false;
  const carried = variableStrings(operation.variables).filter(
    (value) => value !== grant.fileName,
  );
  return !carried.some((value) =>
    containsPreparedAnswer(value, preparedAnswers),
  );
}

function storageMetadata(
  key: string,
  value: string,
  grant: AttachmentUploadWindow,
  sameOrigin: boolean,
): boolean {
  switch (key.toLowerCase()) {
    case "key":
      return /^(?:[\w./!()'*-]|%[\da-f]{2}|\$\{filename\}){1,1024}$/iu.test(
        value,
      );
    case "acl":
      return [
        "private",
        "public-read",
        "authenticated-read",
        "bucket-owner-read",
        "bucket-owner-full-control",
      ].includes(value);
    case "bucket":
      return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value);
    case "content-type":
      return value === grant.mimeType || value === "application/octet-stream";
    case "utf8":
      return value === "✓";
    case "filename":
    case "file_name":
      return value === grant.fileName;
    case "size":
    case "file_size":
      return value === String(grant.byteLength);
    case "success_action_status":
      return ["200", "201", "204"].includes(value);
    // Greenhouse's storage asks for encryption at rest.
    case "x-amz-server-side-encryption":
      return ["AES256", "aws:kms", "aws:kms:dsse"].includes(value);
    case "x-amz-algorithm":
      return value === "AWS4-HMAC-SHA256";
    case "x-goog-algorithm":
      return /^(?:GOOG4-RSA-SHA256|GOOG4-HMAC-SHA256)$/u.test(value);
    case "x-amz-date":
    case "x-goog-date":
      return /^\d{8}T\d{6}Z$/u.test(value);
    case "x-amz-signature":
      return /^[\da-f]{64}$/iu.test(value);
    case "x-goog-signature":
      return /^[\da-f]{64,1024}$/iu.test(value);
    case "x-amz-credential":
      return /^[A-Z\d]{8,64}\/\d{8}\/[a-z\d-]+\/s3\/aws4_request$/u.test(value);
    case "x-goog-credential":
      return /^[\w.+-]+@[\w.-]+\/\d{8}\/[\w-]+\/storage\/goog4_request$/u.test(
        value,
      );
    case "x-amz-security-token":
      return /^[\w+/=-]{16,8192}$/u.test(value);
    case "policy": {
      if (!/^[A-Za-z\d+/]+={0,2}$/u.test(value) || value.length < 16)
        return false;
      let policy: unknown;
      try {
        policy = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
      } catch {
        return false;
      }
      if (!policy || typeof policy !== "object" || Array.isArray(policy))
        return false;
      const record = policy as Record<string, unknown>;
      if (
        typeof record.expiration !== "string" ||
        !Number.isFinite(Date.parse(record.expiration)) ||
        !Array.isArray(record.conditions)
      )
        return false;
      return (
        Object.keys(record).every((key) =>
          ["expiration", "conditions"].includes(key),
        ) &&
        record.conditions.every((condition: unknown) => {
          if (Array.isArray(condition)) {
            if (condition[0] === "content-length-range")
              return (
                condition.length === 3 &&
                typeof condition[1] === "number" &&
                typeof condition[2] === "number"
              );
            return (
              condition.length === 3 &&
              ["eq", "starts-with"].includes(String(condition[0])) &&
              typeof condition[1] === "string" &&
              // Greenhouse's policy also names the form's own `utf8` and
              // `authenticity_token` fields, and only says how they start.
              /^\$(?:key|bucket|acl|Content-Type|success_action_status|utf8|authenticity_token|x-amz-[\w-]+|x-goog-[\w-]+)$/iu.test(
                condition[1],
              ) &&
              typeof condition[2] === "string" &&
              !/\s/u.test(condition[2])
            );
          }
          return (
            !!condition &&
            typeof condition === "object" &&
            Object.entries(condition).every(
              ([name, item]) =>
                name.toLowerCase() !== "policy" &&
                typeof item === "string" &&
                storageMetadata(name, item, grant, false),
            )
          );
        })
      );
    }
    case "csrf_token":
    case "csrftoken":
    case "csrfmiddlewaretoken":
    case "_csrftoken":
      return sameOrigin && /^[\w+/=-]{16,4096}$/u.test(value);
    case "authenticity_token":
      return /^[\w+/=-]{1,4096}$/u.test(value);
    default:
      // The form's own opaque identifier, such as Lever's `accountId`: a
      // public id from the page, never an answer (those are checked apart).
      return (
        /(?:^|[a-z_-])id$/iu.test(key) &&
        /^(?=[\w-]*\d)[\w-]{6,64}$/u.test(value)
      );
  }
}

/** Every string in a decoded storage policy; unreadable is one opaque string. */
function policyStrings(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [json];
  }
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        strings.push(key);
        visit(item);
      }
  };
  visit(parsed);
  return strings;
}

/** No form answers: one exact selected file and bounded upload metadata only. */
export async function classifyAttachmentUpload(input: {
  window: AttachmentUploadWindow | null;
  nowMs: number;
  method: string;
  url: string;
  contentType: string;
  body: Uint8Array | null;
  preparedValues?: readonly string[];
}): Promise<{ allowed: boolean; containsFile: boolean }> {
  const multipart = /\bmultipart\/form-data\b/iu.test(input.contentType);
  const binary =
    /^(?:application\/(?!json|x-www-form-urlencoded)|image\/|audio\/|video\/)/iu.test(
      input.contentType,
    );
  const denied = { allowed: false, containsFile: multipart || binary };
  const grant = input.window;
  if (
    !grant ||
    input.nowMs > grant.expiresAtMs ||
    grant.remainingRequests < 1 ||
    !["POST", "PUT"].includes(input.method.toUpperCase()) ||
    !input.body ||
    input.body.byteLength > grant.byteLength + 65_536
  )
    return denied;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return denied;
  }
  if (!["https:", "http:"].includes(url.protocol)) return denied;
  const preparedAnswers = (input.preparedValues ?? []).filter(
    (value) => value !== grant.fileName,
  );
  if (
    requestUrlCarriesPreparedValue(
      withoutAttachmentName(url.href, grant.fileName),
      preparedAnswers,
    )
  )
    return denied;
  let signal: string;
  try {
    signal = splitCase(decodeURIComponent(url.pathname + url.search));
  } catch {
    return denied;
  }
  if (finalSignal.test(signal)) return denied;
  if (
    /\/(?:applications?|users?|accounts?|candidates?)(?:\/|$)/iu.test(
      url.pathname,
    ) &&
    !uploadSignal.test(signal)
  )
    return denied;
  if (
    url.origin === grant.sourceOrigin &&
    /\bapplication\/json\b/iu.test(input.contentType) &&
    presignRequest(new TextDecoder().decode(input.body), grant, preparedAnswers)
  )
    return { allowed: true, containsFile: false };
  let storageSignature = [...url.searchParams.keys()].some((key) =>
    /^(?:x-amz-signature|x-goog-signature|signature|sig)$/iu.test(key),
  );
  let fileBytes: Uint8Array;
  if (multipart) {
    let form: FormData;
    try {
      form = await new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": input.contentType },
        body: new Uint8Array(input.body),
      }).formData();
    } catch {
      return denied;
    }
    const files = [...form.values()].filter(
      (value) => typeof value !== "string",
    );
    if (
      files.length !== 1 ||
      !sameAttachmentName(files[0]!.name, grant.fileName) ||
      files[0]!.size !== grant.byteLength
    )
      return { allowed: false, containsFile: files.length > 0 };
    for (const [key, value] of form) {
      if (typeof value !== "string") continue;
      // Storage signing fields have constrained values. They are never an
      // escape hatch for a form answer, including inside a decoded policy.
      // A policy is read value by value: run together, its words make up
      // answers that are not there ("credential" + "EXAMPLE" holds "Alex").
      const decoded =
        key.toLowerCase() === "policy"
          ? policyStrings(Buffer.from(value, "base64").toString("utf8"))
          : [value];
      if (
        !storageMetadata(
          key,
          value,
          grant,
          url.origin === grant.sourceOrigin,
        ) ||
        value.length > 8192 ||
        decoded.some((text) =>
          containsPreparedAnswer(
            withoutAttachmentName(text, grant.fileName),
            preparedAnswers,
          ),
        ) ||
        finalSignal.test(splitCase(`${key} ${value}`))
      )
        return { allowed: false, containsFile: true };
      if (/^(?:x-amz-signature|x-goog-signature)$/iu.test(key))
        storageSignature = true;
    }
    fileBytes = new Uint8Array(await files[0]!.arrayBuffer());
  } else {
    if (input.body.byteLength !== grant.byteLength) return denied;
    fileBytes = input.body;
  }
  const namedObject =
    url.pathname.endsWith(`/${encodeURIComponent(grant.fileName)}`) ||
    url.pathname.endsWith(`/${grant.fileName}`);
  const isUpload =
    uploadSignal.test(signal) ||
    storageSignature ||
    (input.method.toUpperCase() === "PUT" && namedObject);
  return {
    allowed:
      isUpload &&
      createHash("sha256").update(fileBytes).digest("hex") === grant.sha256,
    containsFile: true,
  };
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The handles and keys a presign's answer hands out (Ashby's
 * `fileUploadHandle.handle`, a storage key): long strings with no spaces.
 */
export function uploadHandlesIn(
  text: string,
  grant: Pick<AttachmentUploadWindow, "fileName">,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const handles = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 8) return;
    if (typeof value === "string") {
      if (
        value.length >= 16 &&
        value.length <= 2_048 &&
        !/\s/u.test(value) &&
        value !== grant.fileName
      )
        handles.add(value);
    } else if (value && typeof value === "object")
      for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(parsed, 0);
  return [...handles].slice(0, 32);
}

/**
 * The one request that binds the uploaded file to the form (Ashby's
 * `ApiSetFormValueToFile`): sent after the storage took the file, to the
 * endpoint the presign went to, naming a handle the presign handed out, and
 * carrying no answer and no final action. One per uploaded file.
 */
export function classifyUploadBind(input: {
  window: AttachmentUploadWindow | null;
  nowMs: number;
  method: string;
  url: string;
  contentType: string;
  body: string | null;
  preparedValues?: readonly string[];
}): boolean {
  const grant = input.window;
  const body = input.body;
  if (
    !grant?.presignEndpoint ||
    !grant.handles?.length ||
    (grant.bindsRemaining ?? 0) < 1 ||
    input.nowMs > grant.expiresAtMs ||
    input.method.toUpperCase() !== "POST" ||
    !/\bapplication\/json\b/iu.test(input.contentType) ||
    !body ||
    body.length > 16_384
  )
    return false;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return false;
  }
  const preparedAnswers = (input.preparedValues ?? []).filter(
    (value) => value !== grant.fileName,
  );
  // Ashby names the operation in the address (`?op=ApiSetFormValueToFile`).
  if (
    `${url.origin}${url.pathname}` !== grant.presignEndpoint ||
    requestUrlCarriesPreparedValue(url.href, preparedAnswers) ||
    finalSignal.test(splitCase(safeDecodeURIComponent(url.search)))
  )
    return false;
  if (!grant.handles.some((handle) => body.includes(handle))) return false;
  const operations = readGraphQlRequest(body);
  if (
    operations &&
    (operations.length !== 1 ||
      operations[0]!.type !== "mutation" ||
      operations[0]!.rootFields.length !== 1)
  )
    return false;
  let rest = withoutAttachmentName(body, grant.fileName);
  for (const handle of grant.handles) rest = rest.split(handle).join("");
  if (finalSignal.test(splitCase(rest))) return false;
  return !(
    containsPreparedAnswer(rest, preparedAnswers) ||
    (operations?.[0] &&
      variableStrings(operations[0].variables).some(
        (value) =>
          !grant.handles!.includes(value) &&
          containsPreparedAnswer(value, preparedAnswers),
      ))
  );
}
