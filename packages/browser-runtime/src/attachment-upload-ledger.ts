import type { Page, Request, Response } from "playwright";
import type { RawApplyPage, RawApplyUpload } from "@nestor/contracts";

import { inspectPageMutationResponse } from "./mutation-response-body";
import {
  getPrepareOnlyRequestPermit,
  getAttachmentGuardRefusal,
  onPrepareOnlyUploadPermit,
} from "./playwright-application-flow";

/**
 * What the site's own server said about each file sent from a page.
 *
 * A file input holding a file, or a chip showing its name, says nothing about
 * whether the upload reached the site: async widgets show the name the moment
 * a file is picked. The requests around the file do:
 *
 * - a carrier sends the file itself: a multipart body that names it, or a raw
 *   body of its size (a presigned storage PUT);
 * - a mention is a JSON or form request that names the file (a presign, a
 *   register, an autosave, telemetry);
 * - a linked request carries a key, id or URL that an earlier answer about
 *   the file handed out (the storage PUT to a presigned URL, the confirm that
 *   registers the uploaded key).
 *
 * Outcomes are ordered by when they completed. Only a carrier that got
 * through proves the file arrived, and only while no refusal came after it:
 * a carrier refusal stands until a later carrier succeeds, and a mention or
 * linked request that fails after the last good carrier refuses too. A
 * mention or linked request that succeeds proves nothing (an autosave naming
 * the file, or a confirm after the storage refused it). A carrier got
 * through only when the shared mutation-response check judged it "accepted":
 * the fence's upload permit for that exact request plus a storage receipt.
 * "Unconfirmed" is not attached. A carrier Nestor's own fence held back
 * (including one whose redirect would have left its endpoint) never counts.
 *
 * Known gaps, on the eval as such: chunked or resumable uploads (tus and
 * similar), uploads that started before the page was watched, and a page
 * that reloaded after the upload.
 */
interface UploadRecord {
  /** The order its answer arrived in; null while it waits. */
  completedAt: number | null;
  sequence?: number;
  httpStatus?: number;
  carriesFile: boolean;
  /** Carrier: the file names its multipart body gives. */
  names: readonly string[];
  /** Carrier: the raw body's size. */
  size: number | null;
  /** Mention: the request body, lowercased. */
  text: string;
  url: string;
  endpoint: string;
  /** Keys, ids and URLs a successful answer handed out. */
  tokens: string[];
  status: "pending" | "accepted" | "rejected" | "unconfirmed";
  /** Held back by Nestor's own fence; the site never saw it. */
  blocked: boolean;
  /**
   * The exact file the fence's upload permit let this request carry. A
   * request with one is a carrier whatever its content type.
   */
  identity: FileIdentity | null;
  guardRefusal?: string;
}

interface FileIdentity {
  field: string | null;
  name: string;
  size: number;
  sha256?: string;
  startedAfter?: number;
}

const ledgers = new WeakMap<Page, UploadRecord[]>();
/**
 * The file Nestor gave each file control, by the control's handle. Some
 * widgets empty the input the moment they take the file (and send it
 * themselves), so a later read of the input cannot say which file it was.
 */
const given = new WeakMap<Page, Map<string, FileIdentity>>();
const controlHandle = (control: { ref?: string; index: number }) =>
  control.ref ?? `c${control.index}`;

/** Notes the file Nestor put in this control, for when its input empties. */
export function rememberAttachedFile(
  page: Page,
  ref: string,
  file: FileIdentity,
): void {
  let files = given.get(page);
  if (!files) given.set(page, (files = new Map<string, FileIdentity>()));
  files.set(ref, { ...file, startedAfter: sequence });
}
/** Answers in the order they arrived; milliseconds tie too often. */
let answered = 0;
let sequence = 0;
/** Kept per kind, so chatty autosaves cannot push the uploads out. */
const MAX_PER_KIND = 60;
const MAX_TEXT = 64_000;

function decodeFilename(raw: string, extended: boolean): string {
  const value = raw.trim().replace(/^"|"$/gu, "");
  if (!extended) return value;
  // filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf
  const encoded = value.replace(/^[\w-]+'[\w-]*'/u, "");
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function fileNamesIn(body: Buffer): string[] {
  const names = new Set<string>();
  // Part headers are UTF-8; the file bytes around them do not matter here.
  const text = body.toString("utf8");
  for (const match of text.matchAll(
    /filename(\*)?=("[^"\r\n]*"|[^;\r\n]+)/giu,
  )) {
    const name = decodeFilename(match[2]!, match[1] === "*");
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

function add(records: UploadRecord[], record: UploadRecord): UploadRecord {
  record.sequence = ++sequence;
  records.push(record);
  const sameKind = records.filter(
    (entry) => entry.carriesFile === record.carriesFile,
  );
  if (sameKind.length > MAX_PER_KIND)
    records.splice(records.indexOf(sameKind[0]!), 1);
  return record;
}

function track(records: UploadRecord[], request: Request): UploadRecord | null {
  const method = request.method();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") return null;
  const body = request.postDataBuffer();
  const base = {
    completedAt: null,
    url: request.url().toLowerCase(),
    endpoint: `${new URL(request.url()).host}${new URL(request.url()).pathname}`,
    tokens: [],
    status: "pending" as const,
    blocked: false,
    identity: null,
  };
  const type = (request.headers()["content-type"] ?? "").toLowerCase();
  if (!body || body.length === 0) {
    // A body-less confirm whose URL may carry a handed-out key.
    return add(records, {
      ...base,
      carriesFile: false,
      names: [],
      size: null,
      text: "",
    });
  }
  if (type.includes("multipart/form-data")) {
    const names = fileNamesIn(body);
    if (!names.length) return null;
    return add(records, {
      ...base,
      carriesFile: true,
      names,
      size: null,
      text: "",
    });
  }
  if (
    type.includes("json") ||
    type.includes("x-www-form-urlencoded") ||
    type.startsWith("text/")
  ) {
    // A long body is still read for the file's name, up to the limit.
    return add(records, {
      ...base,
      carriesFile: false,
      names: [],
      size: null,
      text: body.subarray(0, MAX_TEXT).toString("utf8").toLowerCase(),
    });
  }
  return add(records, {
    ...base,
    carriesFile: true,
    names: [],
    size: body.length,
    text: "",
  });
}

// Answer fields that hand out an identity for the file, whatever its shape:
// key, id, fileId, upload_id, url, location, path, token, handle.
const identityWords = new Set([
  "id",
  "key",
  "url",
  "uri",
  "path",
  "location",
  "token",
  "handle",
  "uuid",
  "ref",
]);
const namesIdentity = (field: string) =>
  identityWords.has(
    field
      .split(/[_\-\s]+|(?<=[a-z\d])(?=[A-Z])/u)
      .at(-1)
      ?.toLowerCase() ?? "",
  );

/**
 * Could this string be a key, id or URL handed out for the file? Anything
 * with a digit can be; a digit-free value counts when its field names an
 * identity (`{"key": "uploads/taylor-resume"}`), so a bucket or region name
 * elsewhere in the answer does not tie every later request to the file.
 */
function looksLikeToken(text: string, field: string | null): boolean {
  if (text.length < 6 || text.length > 2_000 || /\s/u.test(text)) return false;
  // Not a timestamp or a content type that any other request might repeat.
  if (/^\d{4}-\d{2}-\d{2}/u.test(text)) return false;
  if (
    /^(?:application|text|image|audio|video|font|model|multipart)\/[a-z0-9.+-]+$/iu.test(
      text,
    )
  )
    return false;
  return /\d/u.test(text) || (field !== null && namesIdentity(field));
}

/** Short strings an answer hands out that a later request may carry back. */
function tokensIn(
  value: unknown,
  into: string[] = [],
  depth = 0,
  field: string | null = null,
): string[] {
  if (depth > 4 || into.length > 40) return into;
  if (typeof value === "string") {
    const text = value.trim();
    if (looksLikeToken(text, field)) {
      into.push(text.toLowerCase());
      // A presigned URL comes back as the URL of the storage request.
      try {
        const url = new URL(text);
        if (url.pathname.length >= 6) into.push(url.pathname.toLowerCase());
      } catch {
        // Not a URL.
      }
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) tokensIn(entry, into, depth + 1, field);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value))
      tokensIn(entry, into, depth + 1, key);
  }
  return into;
}

async function settle(page: Page, record: UploadRecord, response: Response) {
  // Ordered by when the answer arrived, not by when its body was read.
  record.completedAt = ++answered;
  record.httpStatus = response.status();
  // The fence's upload permit names the exact file this request carried:
  // it is a carrier whatever its content type (a raw text/plain PUT too).
  const permit = getPrepareOnlyRequestPermit(response.request());
  if (permit && permit.uploadLeg !== "presign") {
    record.carriesFile = true;
    record.identity = { ...permit.file };
  }
  // The shared check reads the body in the page too when the embedded browser
  // never hands it over, and fails closed. Only "accepted" (the fence's
  // upload permit for this exact request, and a storage receipt) attaches a
  // file; a refusal refuses whatever was sent.
  const { judgment, body } = await inspectPageMutationResponse(page, response);
  if (judgment === "refused") {
    record.status = "rejected";
    return;
  }
  if (record.carriesFile && judgment !== "accepted") {
    record.status = "unconfirmed";
    return;
  }
  // A mention that was not refused proves nothing, but may hand out the key
  // a later carrier goes to.
  record.status = "accepted";
  record.tokens = tokensIn(body);
}

/** Starts listening once per page; later calls are no-ops. */
export function watchAttachmentUploads(page: Page): void {
  // A page stand-in without events (a test double) has no requests to hear.
  if (ledgers.has(page) || typeof page.on !== "function") return;
  const records: UploadRecord[] = [];
  ledgers.set(page, records);
  const tracked = new WeakMap<Request, UploadRecord>();
  page.on("request", (request) => {
    try {
      // A redirect continues the same request; its final answer decides.
      // Already named by its upload permit.
      if (tracked.has(request)) return;
      const from = request.redirectedFrom();
      const followed = from ? tracked.get(from) : undefined;
      const record = followed ?? track(records, request);
      if (record) tracked.set(request, record);
    } catch {
      // An unreadable body is not an upload this ledger can judge.
    }
  });
  // The fence names a carrier when it lets the file out, before any answer:
  // a carrier whose answer never comes, or whose connection drops, is then
  // pending or refused, never silently attached.
  onPrepareOnlyUploadPermit(page, (request, permit) => {
    if (permit.uploadLeg === "presign") return;
    let record = tracked.get(request);
    if (!record) {
      record = add(records, {
        completedAt: null,
        url: request.url().toLowerCase(),
        endpoint: `${new URL(request.url()).host}${new URL(request.url()).pathname}`,
        tokens: [],
        status: "pending",
        blocked: false,
        identity: null,
        carriesFile: true,
        names: [],
        size: null,
        text: "",
      });
      tracked.set(request, record);
    }
    record.carriesFile = true;
    record.names = [permit.file.name.toLowerCase()];
    record.size = permit.file.size;
    record.identity = { ...permit.file };
  });
  page.on("response", (response) => {
    const record = tracked.get(response.request());
    const status = response.status();
    if (!record || (status >= 300 && status < 400)) return;
    void settle(page, record, response).catch(() => {
      record.status = "rejected";
    });
  });
  page.on("requestfailed", (request) => {
    const record = tracked.get(request);
    // Chromium reports a 204 to a cross-origin upload (S3's default answer
    // to a presigned POST) as failed right after its response arrives: the
    // server has already answered, and its answer stands.
    if (!record || record.completedAt !== null) return;
    // Held back by Nestor's own fence, not refused by the site: a file it
    // held back is not attached. A held-back autosave says nothing.
    record.blocked = /BLOCKED_BY_CLIENT/iu.test(
      request.failure()?.errorText ?? "",
    );
    const guardRefusal = getAttachmentGuardRefusal(request);
    if (guardRefusal) record.guardRefusal = guardRefusal;
    record.status = "rejected";
    record.completedAt = ++answered;
  });
}

/** The server's word on one chosen file; the module comment has the rules. */
function attachmentUploadEvidence(
  page: Page,
  file: Partial<FileIdentity>,
): Pick<RawApplyUpload, "network" | "requests"> | undefined {
  const records = ledgers
    .get(page)
    ?.filter(
      (record) =>
        file.startedAfter === undefined ||
        (record.sequence ?? 0) > file.startedAfter,
    );
  const name = file.name?.trim().toLowerCase();
  if (!records || !name) return undefined;
  // A carrier is this file only by the permit's exact identity (field,
  // name, size, digest) when both sides have it, and by name otherwise;
  // never by size alone, which a cover letter can share.
  const isThisFile = (record: UploadRecord): boolean =>
    record.identity
      ? record.identity.name.toLowerCase() === name &&
        (file.sha256 === undefined ||
          (record.identity.sha256 === file.sha256 &&
            record.identity.size === file.size &&
            (file.field === undefined || record.identity.field === file.field)))
      : record.names.includes(name);
  const carriers = records.filter(
    (record) => record.carriesFile && isThisFile(record),
  );
  const mentions = records.filter(
    (record) =>
      !record.carriesFile &&
      name !== undefined &&
      name.length > 3 &&
      record.text.includes(name),
  );
  const tokens = [
    ...new Set([...carriers, ...mentions].flatMap((record) => record.tokens)),
  ];
  const linked = records.filter(
    (record) =>
      !carriers.includes(record) &&
      !mentions.includes(record) &&
      tokens.some(
        (token) => record.url.includes(token) || record.text.includes(token),
      ),
  );
  // A carrier the presign pointed at carries this file too.
  for (const record of linked)
    if (record.carriesFile && (!record.identity || isThisFile(record)))
      carriers.push(record);
  // A held-back mention never reached the site and says nothing.
  const group = [...new Set([...carriers, ...mentions, ...linked])].filter(
    (record) =>
      !record.blocked || carriers.includes(record) || linked.includes(record),
  );
  if (!group.length) return undefined;
  const requests = group.slice(-6).map((record) => {
    return {
      endpoint: record.endpoint,
      status: record.httpStatus ?? null,
      blocked: record.blocked,
      ...(record.guardRefusal ? { guardRefusal: record.guardRefusal } : {}),
    };
  });
  const evidence = (network: NonNullable<RawApplyUpload["network"]>) => ({
    network,
    requests,
  });
  if (group.some((record) => record.status === "pending"))
    return evidence("pending");
  const order = (record: UploadRecord) => record.completedAt ?? 0;
  const lastCarrier = [...carriers]
    .sort((left, right) => order(left) - order(right))
    .at(-1);
  if (lastCarrier?.status === "rejected") return evidence("rejected");
  const after = lastCarrier ? order(lastCarrier) : 0;
  if (
    group.some(
      (record) => record.status === "rejected" && order(record) > after,
    )
  )
    return evidence("rejected");
  if (lastCarrier?.status === "unconfirmed") return evidence("unconfirmed");
  return lastCarrier ? evidence("accepted") : undefined;
}

export function attachmentUploadOutcome(
  page: Page,
  file: Partial<FileIdentity>,
): RawApplyUpload["network"] {
  return attachmentUploadEvidence(page, file)?.network;
}

/** Adds the server's word to every file control a page read found. */
export function withAttachmentUploadOutcomes(
  page: Page,
  raw: RawApplyPage,
): RawApplyPage {
  if (!ledgers.has(page)) return raw;
  const uploads = [...(given.get(page)?.values() ?? [])].flatMap((file) => {
    const network = attachmentUploadOutcome(page, file);
    return network ? [{ fileName: file.name, network }] : [];
  });
  return {
    ...raw,
    ...(uploads.length ? { uploads } : {}),
    controls: raw.controls.map((control) => {
      if (!control.upload) return control;
      // The file Nestor gave this control, with its exact identity; an
      // emptied input is judged by it too.
      const mine = given.get(page)?.get(controlHandle(control));
      const shown = control.upload.fileName;
      const file =
        mine && (!shown || shown.toLowerCase() === mine.name.toLowerCase())
          ? mine
          : shown
            ? {
                name: shown,
                ...(control.upload.fileSize
                  ? { size: control.upload.fileSize }
                  : {}),
              }
            : undefined;
      const evidence = file ? attachmentUploadEvidence(page, file) : undefined;
      return {
        ...control,
        upload: {
          ...control.upload,
          ...(mine ? { selectedFileName: mine.name } : {}),
          ...evidence,
        },
      };
    }),
  };
}
