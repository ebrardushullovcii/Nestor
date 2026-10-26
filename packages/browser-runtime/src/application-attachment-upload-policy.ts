import { createHash } from "node:crypto";

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
const finalSignal =
  /(?:^|[^a-z0-9])(?:submit|submission|finali[sz]e|register|create\s*(?:application|account|user)|apply\s*(?:to\s*job|now)|send\s*application)(?:[^a-z0-9]|$)/iu;
const splitCase = (value: string) =>
  value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");

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
    roots = 0;
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
      if (depth === 0) break;
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
  return roots === 1;
}

/** No form answers: one exact selected file and bounded upload metadata only. */
export async function classifyAttachmentUpload(input: {
  window: AttachmentUploadWindow | null;
  nowMs: number;
  method: string;
  url: string;
  contentType: string;
  body: Uint8Array | null;
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
      // Tokens/keys are upload transport metadata, never candidate answers.
      if (
        !/^(?:_?csrf(?:middleware)?token|authenticity_token|token|policy|key|acl|bucket|content-type|filename|file_name|file_size|size|success_action_status|x-amz-[\w-]+|x-goog-[\w-]+)$/iu.test(
          key,
        ) ||
        value.length > 8192 ||
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
