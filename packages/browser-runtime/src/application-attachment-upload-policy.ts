import { createHash } from "node:crypto";
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
}

const uploadSignal =
  /(?:^|[^a-z0-9])(?:uploads?|attachments?|files?|objects?|blobs?|storage|documents?)(?:[^a-z0-9]|$)/iu;
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
    if (/^(?:file_?size|size)$/iu.test(key)) return item === grant.byteLength;
    if (/^(?:mime_?type|content_?type)$/iu.test(key))
      return item === grant.mimeType;
    return false;
  });
}

/** Recognize only a file-upload handle operation, never application/user writes. */
function presignRequest(body: string, grant: AttachmentUploadWindow): boolean {
  if (body.length > 16_384 || finalSignal.test(splitCase(body))) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["operationName", "query", "variables"].includes(key),
    ) ||
    typeof value.query !== "string" ||
    !uploadMetadata(value.variables ?? {}, grant)
  )
    return false;
  const tokens =
    value.query.match(
      /"(?:\\.|[^"\\])*"|#[^\r\n]*|[_A-Za-z][_0-9A-Za-z]*|[{}():$]/gu,
    ) ?? [];
  let depth = 0,
    args = 0,
    roots = 0,
    complete = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("#")) continue;
    if (token === "(") {
      args++;
      continue;
    }
    if (token === ")") {
      args--;
      continue;
    }
    if (token === "{") {
      depth++;
      continue;
    }
    if (token === "}") {
      depth--;
      if (depth === 0) {
        if (tokens.slice(i + 1).some((token) => !token.startsWith("#")))
          return false;
        complete = true;
        break;
      }
      continue;
    }
    if (depth === 0) continue;
    if (args > 0) {
      if (tokens[i + 1] === ":" && tokens[i + 2] !== "$") return false;
      continue;
    }
    if (depth !== 1 || token === ":") continue;
    if (tokens[i + 1] === ":") {
      i++;
      continue;
    } // Alias; inspect the actual field next.
    if (token === "__typename") continue;
    if (
      !/^(?:(?:get|create|prepare|request)?(?:file|attachment)?upload(?:handle|url|target|token|session)|presign(?:file)?upload)$/iu.test(
        token,
      )
    )
      return false;
    roots++;
  }
  return complete && roots === 1;
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
              /^\$(?:key|bucket|acl|Content-Type|x-amz-[\w-]+|x-goog-[\w-]+)$/iu.test(
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
      return false;
  }
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
    presignRequest(new TextDecoder().decode(input.body), grant)
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
      files[0]!.name !== grant.fileName ||
      files[0]!.size !== grant.byteLength
    )
      return { allowed: false, containsFile: files.length > 0 };
    for (const [key, value] of form) {
      if (typeof value !== "string") continue;
      // Storage signing fields have constrained values. They are never an
      // escape hatch for a form answer, including inside a decoded policy.
      const decoded =
        key.toLowerCase() === "policy"
          ? Buffer.from(value, "base64").toString("utf8")
          : value;
      if (
        !storageMetadata(
          key,
          value,
          grant,
          url.origin === grant.sourceOrigin,
        ) ||
        value.length > 8192 ||
        containsPreparedAnswer(
          withoutAttachmentName(decoded, grant.fileName),
          preparedAnswers,
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
