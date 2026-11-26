// Generated evidence only. No network archive, cookies, storage or credentials.
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { checkout, evidenceDir, readState } from "./common.mjs";
import { inside, profileProvenance } from "./live-profile.mjs";
import { forEachLine, readLineAt, traceSafe } from "./trace.mjs";

const json = (value) => JSON.stringify(traceSafe(value), null, 2);
const writeJson = (dir, name, value) =>
  writeFileSync(path.join(dir, name), json(value) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
const parseColumns = (rows) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
          try {
            return [key, JSON.parse(value)];
          } catch {
            /* prose */
          }
        }
        return [key, value];
      }),
    ),
  );

/** A single SQLite read transaction, exporting only product records. Never DB files. */
export function readRunRows(data, applicationId, kind, search = {}) {
  const file = path.join(data, "job-finder.sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  const result = {};
  try {
    db.exec("BEGIN");
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    const read = (name, where = "", values = []) => {
      if (!names.includes(name)) return [];
      const rows = parseColumns(
        db.prepare(`SELECT * FROM "${name}" ${where}`).all(...values),
      );
      result[name] = rows;
      return rows;
    };
    const app = applicationId
      ? read("applications", "WHERE id=?", [Number(applicationId)])[0]
      : null;
    if (applicationId && !app)
      throw Error(
        `Application ${applicationId} does not exist in this profile.`,
      );
    if (app) {
      read("jobs", "WHERE id=?", [app.job_id]);
      for (const table of [
        "job_details",
        "job_sightings",
        "resumes",
        "resume_changes",
        "resume_pdf_assets",
      ])
        read(table, "WHERE job_id=?", [app.job_id]);
      for (const table of [
        "application_details",
        "application_instructions",
        "application_origins",
        "application_needs_you",
      ])
        read(table, "WHERE application_id=?", [app.id]);
      read(
        "needs_you",
        "WHERE id IN (SELECT task_id FROM application_needs_you WHERE application_id=?)",
        [app.id],
      );
      read("send_outcomes", "WHERE job_id=?", [String(app.job_id)]);
      // JSON lineage is retained as stored, filtered to this application's identity.
      for (const table of [
        "send_authorities",
        "send_preflights",
        "send_grants",
        "send_keys",
        "send_markers",
      ]) {
        result[table] = read(table).filter(
          (r) =>
            JSON.stringify(r).includes(`application_${app.id}_attempt_`) ||
            JSON.stringify(r).includes(`\"jobId\":\"${app.job_id}\"`) ||
            r.id === result.application_details?.[0]?.authority_envelope_id,
        );
      }
    }
    for (const table of names.filter((name) =>
      /^(?:profile|profile_(?:settings|goals|items|records|record_items|resume_source|resume_text|work_permissions|setup|identity)|form_answers)$/.test(
        name,
      ),
    ))
      read(table);
    read("job_sites");
    if (app) read("answer_approvals");
    if (kind === "search") {
      // One search's records: the named searches, or those that ran during the
      // recorded trace window. Listings are the ones its sources sighted then.
      const searches = read("searches").filter((row) =>
        search.ids?.length
          ? search.ids.includes(row.id)
          : search.from != null &&
            Number(row.started_at) <= search.to &&
            (row.finished_at == null || Number(row.finished_at) >= search.from),
      );
      result.searches = searches;
      const ids = new Set(searches.map((row) => row.id));
      const sources = read("search_sources").filter((row) =>
        ids.has(row.search_id),
      );
      result.search_sources = sources;
      const from = Math.min(...searches.map((row) => Number(row.started_at)));
      const to = searches.some((row) => row.finished_at == null)
        ? Infinity
        : Math.max(...searches.map((row) => Number(row.finished_at)));
      const sourceIds = new Set(sources.map((row) => String(row.source_id)));
      const sightings = names.includes("job_sightings")
        ? parseColumns(
            db
              .prepare("SELECT * FROM job_sightings WHERE seen_at >= ?")
              .all(Number.isFinite(from) ? from : 0),
          ).filter(
            (row) =>
              sourceIds.has(String(row.source_id)) && Number(row.seen_at) <= to,
          )
        : [];
      result.job_sightings = sightings;
      const jobIds = new Set(sightings.map((row) => row.job_id));
      result.jobs = names.includes("jobs")
        ? parseColumns(db.prepare("SELECT * FROM jobs").all()).filter((row) =>
            jobIds.has(row.id),
          )
        : [];
    }
    db.exec("COMMIT");
    return traceSafe(result);
  } finally {
    db.close();
  }
}

export async function contactSheets(out, shots, prefix = "") {
  const sheets = [];
  const width = 520,
    height = 370,
    perSheet = 12;
  for (let start = 0; start < shots.length; start += perSheet) {
    const batch = shots.slice(start, start + perSheet);
    const canvas = createCanvas(
      width * 3,
      height * Math.ceil(batch.length / 3),
    );
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const [i, shot] of batch.entries()) {
      const image = await loadImage(path.join(out, shot.file));
      const scale = Math.min(
        (width - 12) / image.width,
        (height - 38) / image.height,
      );
      const x = (i % 3) * width,
        y = Math.floor(i / 3) * height;
      ctx.drawImage(
        image,
        x + 6,
        y + 32,
        image.width * scale,
        image.height * scale,
      );
      ctx.fillStyle = "#111";
      ctx.font = "13px sans-serif";
      ctx.fillText(
        `${start + i + 1}. ${shot.action ?? "snapshot"} ${shot.at ?? ""}`,
        x + 6,
        y + 18,
        width - 12,
      );
    }
    const file = `sheets/${prefix}${String(sheets.length + 1).padStart(3, "0")}.png`;
    writeFileSync(path.join(out, file), canvas.toBuffer("image/png"), {
      mode: 0o600,
      flag: "wx",
    });
    sheets.push(file);
  }
  return sheets;
}

// Fields whose complete values live in a model/ file; trace.jsonl points there.
const BODY_FIELDS = ["request", "response", "result", "arguments"];
const INDEX_FIELDS = [
  "id",
  "modelTurnId",
  "toolCallId",
  "applicationKey",
  "sourceId",
  "sourceUrl",
  "purpose",
  "name",
  "status",
  "kind",
  "by",
  "shot",
  "path",
  "action",
  "target",
  "url",
  "durationMs",
];
const digest = (text) => createHash("sha256").update(text).digest("hex");

/** A small record of one trace line: what it is, where it is, how it links. */
function indexEntry(e, f, off, len) {
  const x = { f, off, len, event: String(e.event ?? ""), at: e.at };
  if (e.pid != null) x.pid = e.pid;
  if (e.seq != null) x.seq = e.seq;
  for (const key of INDEX_FIELDS)
    if (e[key] != null && typeof e[key] !== "object") x[key] = e[key];
  if (Array.isArray(e.applicationKeys)) x.applicationKeys = e.applicationKeys;
  if (Array.isArray(e.sourceIds)) x.sourceIds = e.sourceIds.map(String);
  if (x.sourceId != null) x.sourceId = String(x.sourceId);
  if (x.event === "application_requested")
    x.sel = e.input?.selection?.ids ?? e.input?.jobIds;
  if (x.event === "run_header") x.header = e;
  if (x.event === "ours") x.reason = e.reason;
  if (x.event === "provider_request") {
    x.endpoint = e.endpoint;
    // The recorder can omit a whole request; that is not an unknown model.
    if (typeof e.request === "string") x.omitted = e.request;
    x.model = x.omitted ? "omitted in trace" : (e.request?.model ?? "unknown");
    x.effort =
      e.request?.reasoning_effort ?? e.request?.reasoning?.effort ?? "unknown";
  }
  if (x.event === "provider_reported") {
    x.model = e.model ?? "unknown";
    x.effort = e.effort ?? "unknown";
  }
  if (x.event === "model_turn_started" || x.event === "model_turn")
    x.requestHash = digest(JSON.stringify(e.request ?? null));
  if (x.event.endsWith("_error")) x.error = e.error ?? null;
  if (x.event === "search_source_result")
    x.result = {
      pagesFetched: e.pagesFetched,
      listingsRead: e.listingsRead,
      complete: e.complete,
      notes: e.notes,
    };
  return x;
}

/** Reads every events-*.jsonl line by line; memory follows event count, not bytes. */
function indexTrace(trace) {
  const files = trace
    ? readdirSync(trace)
        .filter((f) => /^events-.*\.jsonl$/.test(f))
        .sort()
    : [];
  const entries = [];
  const fileFacts = [];
  let runConfiguration = null;
  for (const [f, name] of files.entries()) {
    const file = path.join(trace, name);
    let lines = 0;
    forEachLine(file, (buffer, offset, line) => {
      lines++;
      let event;
      try {
        event = JSON.parse(buffer.toString("utf8"));
      } catch {
        entries.push({
          f,
          event: "trace_read_error",
          bad: { event: "trace_read_error", file: name, line },
        });
        return;
      }
      runConfiguration ??= event.runConfiguration ?? null;
      entries.push(indexEntry(event, f, offset, buffer.length));
    });
    fileFacts.push({ file: name, bytes: statSync(file).size, lines });
  }
  entries.sort(
    (a, b) =>
      (a.at ?? "").localeCompare(b.at ?? "") ||
      (a.pid ?? 0) - (b.pid ?? 0) ||
      (a.seq ?? 0) - (b.seq ?? 0),
  );
  return { files, fileFacts, entries, runConfiguration };
}

const countBy = (items, key) => {
  const counts = {};
  for (const item of items) {
    const value = String(key(item) ?? "unknown");
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};
/** Distinct values with how often and when they were recorded. */
function grouped(entries, key) {
  const groups = new Map();
  for (const e of entries) {
    const values = key(e);
    const id = JSON.stringify(values);
    if (!groups.has(id))
      groups.set(id, {
        ...(values.length === 3
          ? { endpoint: values[0], model: values[1], effort: values[2] }
          : { model: values[0], effort: values[1] }),
        count: 0,
        first: e.at,
        last: e.at,
      });
    const group = groups.get(id);
    group.count++;
    group.last = e.at;
  }
  return [...groups.values()];
}
const cell = (text) =>
  String(text ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
const sourceKeyOf = (e) =>
  e.sourceId ?? (e.sourceIds?.length === 1 ? e.sourceIds[0] : null);
const slug = (value) => String(value).replace(/[^\w.-]+/g, "_");

/** One events-table row; `files` maps an entry to its model/ file. */
function eventDetail(event, file, link) {
  if (event.event === "ours")
    return `${event.by}: ${event.kind}: ${event.reason}`;
  if (event.event === "tool_call")
    return `[${event.name}](${link(file)}) (${event.durationMs} ms): ${String(event.result ?? "No tool message").split("\n")[0]}`;
  if (event.event === "tool_call_started")
    return `${event.name}: dispatched; complete arguments in trace.jsonl`;
  if (event.event === "page_snapshot")
    return `${event.action}: ${event.url}; screenshot in shots/`;
  if (event.event === "model_turn_started")
    return `Model turn ${event.id} started; exact request in ${file ? `[${file}](${link(file)})` : "model/"}`;
  if (event.event === "model_turn")
    return `Model turn ${event.id} returned (${event.durationMs} ms); exact response in ${file ? `[${file}](${link(file)})` : "model/"}`;
  if (event.event === "provider_request")
    return `${event.request?.model} → ${event.endpoint}; exact request in ${file ? `[${file}](${link(file)})` : "model/"}`;
  if (["provider_response", "provider_response_raw"].includes(event.event))
    return `Provider response ${event.id}; exact text, tool calls and finish reason in ${file ? `[${file}](${link(file)})` : "model/"}`;
  if (event.event.startsWith("settings_"))
    return `Settings recorded; complete values in trace.jsonl`;
  if (event.event === "application_requested")
    return `Application requested: ${event.instruction}; complete settings in trace.jsonl`;
  return JSON.stringify(event);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function generatePack(options) {
  const state = options.state ?? readState();
  const out = path.resolve(options.out);
  const traceOption = options.trace ?? process.env.NESTOR_RUN_TRACE_DIR;
  const trace = traceOption ? path.resolve(traceOption) : null;
  const data = options.data ?? state?.userDataDir;
  if (inside(out, checkout))
    throw Error("Evidence packs must stay outside the repository.");
  if (data && (inside(out, data) || inside(data, out)))
    throw Error(
      "Evidence must not contain or live inside browser profile storage.",
    );
  if (
    existsSync(path.join(out, "manifest.json")) ||
    existsSync(path.join(out, "pack.md"))
  )
    throw Error(
      "Generated packs are immutable; choose a new output directory.",
    );
  const kind = options.kind ?? "application";
  if (kind === "application" && !options.application)
    throw Error(
      "--application <id> is required; no latest-application guesses.",
    );
  if (trace && !existsSync(trace))
    throw Error(
      `Trace directory does not exist: ${trace}. Omit --trace (and NESTOR_RUN_TRACE_DIR) for a database-only pack.`,
    );
  if (!trace && !data)
    throw Error("A pack needs a trace (--trace) or a profile (--data).");
  const searchIds = String(options.search ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (kind === "search" && !trace && !searchIds.length)
    throw Error(
      "--search <id> is required for a database-only search pack; no latest-search guesses.",
    );

  // Pass 1: index every line. Bodies stay on disk until pass 2 copies them.
  const traced = indexTrace(trace);
  const windowed = traced.entries.filter(
    (e) =>
      (!options.since || e.at >= options.since) &&
      (!options.until || e.at <= options.until),
  );
  const tracedTimes = windowed.filter((e) => e.at).map((e) => Date.parse(e.at));
  const rows = data
    ? readRunRows(data, options.application, kind, {
        ids: searchIds,
        from: tracedTimes.length ? tracedTimes[0] : null,
        to: tracedTimes.length ? tracedTimes.at(-1) : null,
      })
    : {};
  const storedApp = rows.applications?.[0];
  const app = storedApp?.posting_closed
    ? { ...storedApp, state: "closed" }
    : storedApp;
  const applicationKey = app
    ? `application_${app.id}_attempt_${app.attempt}`
    : options["application-key"];
  const searches = rows.searches ?? [];
  let startMs = Number(app?.queued_at);
  const terminal =
    app && !["queued", "running", "submitting"].includes(app.state);
  let endMs = terminal ? Number(app.updated_at) : Infinity;
  if (kind === "search" && searches.length) {
    startMs = Math.min(...searches.map((s) => Number(s.started_at)));
    endMs = searches.some((s) => s.finished_at == null)
      ? Infinity
      : Math.max(...searches.map((s) => Number(s.finished_at)));
  }
  const isRelevant = (e) => {
    if (e.event === "run_header") return true;
    if (
      e.event === "operator_action" &&
      app &&
      e.applicationKeys?.some((key) =>
        key.startsWith(`application_${app.id}_attempt_`),
      )
    )
      return !Number.isFinite(endMs) || Date.parse(e.at) <= endMs;
    if (
      e.event === "application_requested" &&
      app &&
      e.sel?.includes(app.job_id)
    )
      return true;
    if (e.applicationKey && applicationKey)
      return e.applicationKey === applicationKey;
    if (e.applicationKeys && applicationKey)
      return e.applicationKeys.includes(applicationKey);
    // Retain settings history and header facts; unscoped activity belongs only
    // to this run's persisted time interval, never the whole session.
    if (e.event.startsWith("settings_"))
      return !Number.isFinite(endMs) || Date.parse(e.at) <= endMs;
    const at = Date.parse(e.at);
    return (
      (!Number.isFinite(startMs) || at >= startMs) &&
      (!Number.isFinite(endMs) || at <= endMs)
    );
  };
  let relevant = windowed.filter(isRelevant);
  if (kind === "search" && Number.isFinite(endMs)) {
    // A model call, turn or tool call that began during the search belongs to
    // it, including the records of how it ended after the search stopped.
    const begun = new Set(
      relevant
        .filter((e) =>
          [
            "provider_request",
            "model_turn_started",
            "tool_call_started",
          ].includes(e.event),
        )
        .map((e) => e.id),
    );
    const kept = new Set(relevant);
    relevant = windowed.filter(
      (e) => kept.has(e) || (e.id != null && begun.has(e.id)),
    );
  }
  const databaseOnly = !trace || !traced.files.length;

  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const folder of ["shots", "sheets", "model", "db", "final"])
    mkdirSync(path.join(out, folder), { recursive: true, mode: 0o700 });
  if (kind === "search")
    mkdirSync(path.join(out, "sources"), { recursive: true, mode: 0o700 });

  // File names are fixed before any body is read, so links never dangle.
  const fileOf = new Map();
  const byId = new Map();
  for (const e of relevant)
    if (e.id != null) {
      if (!byId.has(e.id)) byId.set(e.id, []);
      byId.get(e.id).push(e);
    }
  const requests = relevant.filter((e) => e.event === "provider_request");
  for (const [index, e] of requests.entries())
    fileOf.set(
      e,
      `model/${String(index + 1).padStart(4, "0")}-${slug(e.id)}.json`,
    );
  const turns = relevant.filter((e) => e.event === "model_turn");
  for (const [index, e] of turns.entries())
    fileOf.set(e, `model/runtime-${String(index + 1).padStart(4, "0")}.json`);
  let startedOnly = 0;
  for (const e of relevant.filter((x) => x.event === "model_turn_started")) {
    const turn = byId.get(e.id)?.find((x) => x.event === "model_turn");
    if (turn && turn.requestHash === e.requestHash)
      fileOf.set(e, fileOf.get(turn));
    else
      fileOf.set(
        e,
        `model/runtime-started-${String(++startedOnly).padStart(4, "0")}.json`,
      );
  }
  const tools = relevant.filter((e) => e.event === "tool_call");
  for (const [index, e] of tools.entries())
    fileOf.set(e, `model/tool-${String(index + 1).padStart(4, "0")}.json`);
  const requestFileById = new Map(requests.map((e) => [e.id, fileOf.get(e)]));
  for (const e of relevant)
    if (
      !fileOf.has(e) &&
      e.event.startsWith("provider_") &&
      requestFileById.has(e.id)
    )
      fileOf.set(e, requestFileById.get(e.id));
  const modelFiles = [
    ...requests.map((e) => fileOf.get(e)),
    ...turns.map((e) => fileOf.get(e)),
    ...[
      ...new Set(
        relevant
          .filter((e) => e.event === "model_turn_started")
          .map((e) => fileOf.get(e))
          .filter((f) => f.includes("runtime-started-")),
      ),
    ],
  ];

  const shots = [];
  for (const e of relevant.filter(
    (x) => x.event === "page_snapshot" || x.event === "driver_snapshot",
  )) {
    if (!e.shot && !e.path) continue;
    const source = e.shot ? path.resolve(trace, e.shot) : e.path;
    if (e.shot && !inside(source, trace))
      throw Error("Screenshot path escapes trace directory.");
    if (!existsSync(source)) continue;
    const file = `shots/${String(shots.length + 1).padStart(4, "0")}.png`;
    copyFileSync(source, path.join(out, file));
    shots.push({ entry: e, ...e, file });
  }

  const sourceRows = rows.search_sources ?? [];
  const sourceKeys = [
    ...new Set([
      ...sourceRows.map((s) => String(s.source_id)),
      ...(kind === "search"
        ? relevant.map(sourceKeyOf).filter((k) => k != null)
        : []),
    ]),
  ];
  const sheetGroups = new Map();
  if (kind === "search") {
    for (const key of [...sourceKeys, null])
      sheetGroups.set(
        key,
        await contactSheets(
          out,
          shots.filter((s) => sourceKeyOf(s) === key),
          key == null ? "shared-" : `source-${slug(key)}-`,
        ),
      );
  }
  const sheets =
    kind === "search"
      ? [...sheetGroups.values()].flat()
      : await contactSheets(out, shots);

  for (const [table, records] of Object.entries(rows))
    writeJson(out, `db/${table}.json`, records);
  const needs = rows.needs_you ?? [];
  writeJson(out, "needs-you.json", needs);

  const fds = traced.files.map((name) => openSync(path.join(trace, name)));
  const readEvent = (e) =>
    e.bad ?? JSON.parse(readLineAt(fds[e.f], e.off, e.len));
  try {
    const finalShot =
      shots.findLast((s) => s.action === "final_outcome") ??
      shots
        .filter((s) => s.event === "page_snapshot" || s.target === "browser")
        .at(-1) ??
      null;
    if (finalShot)
      copyFileSync(
        path.join(out, finalShot.file),
        path.join(out, "final/page.png"),
      );
    const finalEvent = finalShot ? readEvent(finalShot.entry) : null;
    writeJson(
      out,
      "final/page.json",
      finalShot
        ? {
            url: finalEvent.url,
            visibleText: finalEvent.visibleText,
            at: finalEvent.at,
            applicationKey: finalEvent.applicationKey,
            source: finalShot.file,
          }
        : { missing: "No application-tab snapshot recorded" },
    );
    const confirmation = {
      savedState: app?.state ?? null,
      submissionOutcome: app?.submission_outcome_json ?? null,
      sendOutcomes: rows.send_outcomes ?? [],
      source:
        "Application and send ledger rows; final/page.json is independent site evidence",
    };
    writeJson(out, "final/confirmation.json", confirmation);
    const requestedEntry = relevant.find(
      (e) =>
        e.event === "application_requested" && e.sel?.includes(app?.job_id),
    );
    const requestedApplication = requestedEntry
      ? readEvent(requestedEntry)
      : null;
    const instructionMode =
      requestedApplication?.instruction ??
      rows.application_instructions?.[0]?.mode ??
      app?.mode;

    const headerEvent =
      relevant.findLast((e) => e.event === "run_header")?.header ??
      (relevant.length ? traced.runConfiguration : null);
    const permissions = rows.profile_settings ?? [];
    const permissionValues = Object.entries(permissions[0] ?? {}).filter(
      ([key]) =>
        /permission|captcha|sign_in|create_account|google|declaration|salary|written|pay/i.test(
          key,
        ),
    );
    const profile = data
      ? profileProvenance(data)
      : (headerEvent?.profile ?? { kind: "unknown" });
    const reported = relevant.filter((e) => e.event === "provider_reported");
    const ours = relevant.filter((e) => e.event === "ours");
    const build = headerEvent?.build ?? null;
    const warnings = [];
    if (databaseOnly)
      warnings.push(
        "DATABASE ONLY: no trace was read; model calls, tool calls, pages and screenshots are not in this pack",
      );
    if (relevant.some((e) => e.event === "trace_read_error"))
      warnings.push(
        "INCOMPLETE TRACE: at least one recorded line could not be read",
      );
    if (!build?.head) warnings.push("BUILD: not recorded");
    if (kind === "search" && !searches.length)
      warnings.push(
        searchIds.length
          ? `SEARCH: ${searchIds.join(", ")} not found in this profile`
          : "SEARCH: no stored search ran during the recorded trace window",
      );
    if (
      profile.kind === "app_setup" &&
      rows.profile_setup?.[0]?.status !== "completed"
    )
      warnings.push(
        "PROFILE SETUP: completion was not established by the stored setup row",
      );
    if (profile.kind !== "app_setup")
      warnings.push(
        `PROFILE: ${profile.kind}; real setup provenance is not established`,
      );
    if (headerEvent?.network !== "live")
      warnings.push(`NETWORK: ${headerEvent?.network ?? "unknown"}`);
    if (headerEvent?.ai !== "live")
      warnings.push(
        `AI: ${headerEvent?.ai ?? "unknown"}; does not prove live-model quality`,
      );
    if (!requests.length) warnings.push("No provider requests recorded");
    if (!finalShot && kind === "application")
      warnings.push("Final application screenshot is missing");
    const shotErrors = relevant.filter((e) =>
      ["page_snapshot_error", "driver_snapshot_error"].includes(e.event),
    );
    if (shotErrors.length)
      warnings.push(
        `INCOMPLETE SCREENSHOTS: ${shotErrors.length} captures failed; see trace.jsonl`,
      );
    if (!permissions.length) warnings.push("Permission settings are missing");
    const off = permissionValues.filter(([, value]) =>
      [
        0,
        false,
        "0",
        "false",
        "pause",
        "ask",
        "pause_for_me",
        "pause_for_user",
      ].includes(value),
    );
    if (off.length)
      warnings.push(`PERMISSIONS OFF: ${off.map(([key]) => key).join(", ")}`);
    const omitted = requests.filter((r) => r.omitted);
    if (omitted.length)
      warnings.push(
        `OMITTED REQUESTS: ${omitted.length} model requests were recorded as "${omitted[0].omitted}" by the trace writer; their prompt, model and effort are not in this pack (first ${omitted[0].at}, last ${omitted.at(-1).at})`,
      );
    const requestedModels = [
      ...new Set(requests.filter((r) => !r.omitted).map((r) => r.model)),
    ];
    const expected = options["expected-model"] ?? "deepseek-v4.1-flash";
    if (!requestedModels.length || requestedModels.some((m) => m !== expected))
      warnings.push(
        `MODEL: expected ${expected}; requested ${requestedModels.join(", ") || "unknown"}`,
      );
    const first = relevant.find((e) => e.at)?.at;
    const last = relevant.findLast((e) => e.at)?.at;
    const stopEvent = ours.find((e) =>
      ["blocked", "timed_out", "asked_person"].includes(e.kind),
    );
    let firstStopReason = stopEvent?.reason ?? app?.error ?? null;
    if (firstStopReason?.startsWith("{")) {
      try {
        firstStopReason =
          JSON.parse(firstStopReason).summary ?? firstStopReason;
      } catch {
        /* Keep the recorded reason verbatim. */
      }
    }
    const manifest = {
      version: 2,
      kind,
      applicationId: app?.id ?? null,
      applicationKey,
      searchIds: searches.map((s) => s.id),
      ats: options.ats ?? "unknown",
      company:
        (kind === "search" ? null : rows.jobs?.[0]?.company) ??
        options.company ??
        "unknown",
      outcome:
        app?.state ??
        (kind === "search" && searches.length
          ? searches.map((s) => s.state).join(", ")
          : "unknown"),
      // A search can be stopped and resumed days later; its minutes are the
      // recorded span, and its stored start and finish are kept beside them.
      minutes:
        kind === "search" && first && last
          ? (Date.parse(last) - Date.parse(first)) / 60000
          : Number.isFinite(startMs) && Number.isFinite(endMs)
            ? (endMs - startMs) / 60000
            : first && last
              ? (Date.parse(last) - Date.parse(first)) / 60000
              : null,
      searchWindow:
        kind === "search" && Number.isFinite(startMs)
          ? {
              startedAt: new Date(startMs).toISOString(),
              finishedAt: Number.isFinite(endMs)
                ? new Date(endMs).toISOString()
                : null,
              tracedFrom: first ?? null,
              tracedTo: last ?? null,
            }
          : null,
      needsYouCount: needs.filter((n) => !n.resolved_at).length,
      oursCount: ours.length,
      oursByKind: countBy(ours, (e) => e.kind),
      firstStopReason,
      header: {
        build: build
          ? {
              head: build.head ?? null,
              dirty: build.dirty ?? null,
              builtAt: build.builtAt ?? null,
            }
          : { head: null, note: "No run_header with a build was recorded" },
        raw: headerEvent ?? null,
        profile,
        permissions,
        permissionsAtStart: requestedApplication?.settings ?? null,
        profileSetup: rows.profile_setup ?? [],
        instruction:
          instructionMode === "autonomous_submit"
            ? "Send for me"
            : app
              ? "Fill in for me"
              : "unknown",
        // One row per distinct model and effort; every call is in model/.
        requested: grouped(requests, (r) => [r.endpoint, r.model, r.effort]),
        reported: grouped(reported, (r) => [r.model, r.effort]),
        operatorActed: relevant.some((e) => e.event === "operator_action"),
        operatorEvidence:
          "Native user-input ledger and explicit driver operator records; no input contents are captured",
      },
      trace: {
        dir: trace,
        databaseOnly,
        files: traced.fileFacts,
        events: relevant.length,
        readErrors: relevant.filter((e) => e.event === "trace_read_error")
          .length,
        bodies:
          "trace.jsonl keeps every event; a `packed` field names the model/ file holding its request, response, result or arguments",
      },
      warnings,
      models: modelFiles,
      tools: tools.map((e) => fileOf.get(e)),
      shots: shots.map((s) => s.file),
      sheets,
      generatedAt: new Date().toISOString(),
    };
    if (!reported.length)
      manifest.header.reported.push({ model: "unknown", effort: "unknown" });

    // Per-source facts for a search, from stored rows and the trace index.
    const perSource = [];
    const sourceSection = new Map();
    if (kind === "search") {
      const sightings = rows.job_sightings ?? [];
      const jobs = new Map((rows.jobs ?? []).map((j) => [j.id, j]));
      for (const key of [...sourceKeys, null]) {
        const row = sourceRows.find((s) => String(s.source_id) === key);
        const events = relevant.filter((e) => sourceKeyOf(e) === key);
        const fetched = events.filter((e) => e.event === "search_page_fetched");
        const calls = events.filter((e) => e.event === "provider_request");
        const toolCalls = events.filter((e) => e.event === "tool_call");
        const oursHere = events.filter((e) => e.event === "ours");
        const saved =
          key == null
            ? []
            : sightings
                .filter((s) => String(s.source_id) === key)
                .map((s) => {
                  const job = jobs.get(s.job_id);
                  return {
                    jobId: s.job_id,
                    title: job?.title ?? null,
                    company: job?.company ?? null,
                    location: job?.location ?? null,
                    stage: job?.stage ?? null,
                    fitScore: job?.fit_score ?? null,
                    newThisSearch:
                      job && Number(job.found_at) >= startMs
                        ? true
                        : job
                          ? false
                          : null,
                    url: s.url,
                    seenAt: new Date(Number(s.seen_at)).toISOString(),
                  };
                });
        const file =
          key == null ? "sources/shared.md" : `sources/${slug(key)}.md`;
        const facts = {
          sourceId: key,
          label:
            row?.label ??
            (key == null ? "Activity not tied to one source" : null),
          url: row?.url ?? events.find((e) => e.sourceUrl)?.sourceUrl ?? null,
          section: file,
          stored: row
            ? {
                state: row.state,
                lane: row.lane,
                phase: row.phase,
                found: row.found,
                hidden: row.hidden,
              }
            : null,
          pagesFetched: events
            .filter((e) => e.event === "search_source_result")
            .map((e) => e.result?.pagesFetched),
          // `seen` is previously seen, not listings read. Keep both facts.
          listingsRead: row?.cards ?? null,
          listingsScreened: row ? row.related + row.unrelated : null,
          listingsAlreadySeen: row?.seen ?? null,
          listingsSaved: row?.added ?? null,
          sightedThisSearch: saved.length,
          newThisSearch: saved.filter((s) => s.newThisSearch).length,
          errors: {
            failedReads: row?.failed_reads ?? null,
            message: row?.message ?? null,
            events: events
              .filter((e) => e.event.endsWith("_error"))
              .map((e) => ({ event: e.event, at: e.at, error: e.error })),
            pagesByStatus: countBy(fetched, (e) => e.status),
          },
          trace: {
            events: events.length,
            first: events.find((e) => e.at)?.at ?? null,
            last: events.findLast((e) => e.at)?.at ?? null,
            pagesStarted: events.filter(
              (e) => e.event === "search_page_started",
            ).length,
            pagesFetched: fetched.length,
            sourceResults: events
              .filter((e) => e.event === "search_source_result")
              .map((e) => ({ at: e.at, ...e.result })),
            modelCalls: calls.length,
            modelCallsByPurpose: countBy(calls, (e) => e.purpose),
            modelTurns: events.filter((e) => e.event === "model_turn").length,
            toolCalls: toolCalls.length,
            toolCallsByName: countBy(toolCalls, (e) => e.name),
            ours: oursHere.length,
            oursByKind: countBy(oursHere, (e) => e.kind),
            oursBy: countBy(oursHere, (e) => `${e.kind}: ${e.by}`),
            screenshots: shots.filter((s) => sourceKeyOf(s) === key).length,
          },
          modelFiles: calls.map((e) => fileOf.get(e)),
          toolFiles: toolCalls.map((e) => fileOf.get(e)),
          sheets: sheetGroups.get(key) ?? [],
        };
        perSource.push(facts);
        sourceSection.set(key, { facts, saved, events });
      }
      writeJson(out, "search.json", {
        searches,
        sources: sourceRows,
        perSource: perSource.filter((s) => s.sourceId != null),
        shared: perSource.find((s) => s.sourceId == null),
      });
    }

    // Pass 2: copy each body once into model/, and every event into trace.jsonl.
    const traceOut = openSync(path.join(out, "trace.jsonl"), "wx", 0o600);
    const rowsTmp = path.join(out, ".events.tmp");
    const rowOut = new Map();
    const rowFile = (key) => {
      if (kind !== "search") key = "pack";
      if (!rowOut.has(key)) {
        if (kind !== "search") rowOut.set(key, openSync(rowsTmp, "wx", 0o600));
        else {
          const { facts, saved } = sourceSection.get(key);
          const fd = openSync(path.join(out, facts.section), "wx", 0o600);
          const up = (f) => `../${f}`;
          writeSync(
            fd,
            [
              `# ${facts.label ?? `Source ${key}`}${facts.url ? ` (${facts.url})` : ""}`,
              "",
              "> Generated from recorded events and stored product rows. Do not edit.",
              "",
              "```json",
              json({
                ...facts,
                modelFiles: undefined,
                toolFiles: undefined,
                sheets: undefined,
              }),
              "```",
              "",
              `## Listings sighted during this search (${saved.length})`,
              "",
              "| Job | Title | Company | Location | Stage | Fit | New | Seen | URL |",
              "| ---: | --- | --- | --- | --- | ---: | --- | --- | --- |",
              ...saved.map(
                (s) =>
                  `| ${s.jobId} | ${cell(s.title)} | ${cell(s.company)} | ${cell(s.location)} | ${cell(s.stage)} | ${s.fitScore ?? ""} | ${s.newThisSearch ?? "unknown"} | ${s.seenAt} | ${cell(s.url)} |`,
              ),
              "",
              `## Model calls (${facts.modelFiles.length})`,
              "",
              ...facts.modelFiles.map((f) => `- [${f}](${up(f)})`),
              "",
              `## Tool calls (${facts.toolFiles.length})`,
              "",
              ...facts.toolFiles.map((f) => `- [${f}](${up(f)})`),
              "",
              "## Screenshots",
              "",
              ...facts.sheets.map((f) => `![${f}](${up(f)})`),
              "",
              "## Events",
              "",
              "| Time | Event | Detail |",
              "| --- | --- | --- |",
              "",
            ].join("\n"),
          );
          rowOut.set(key, fd);
        }
      }
      return rowOut.get(key);
    };
    if (kind === "search") for (const key of sourceSection.keys()) rowFile(key);
    else rowFile("pack");
    const link = kind === "search" ? (f) => `../${f}` : (f) => f;
    const toolEvents = [];
    const attachments = [];
    const imports = [];
    for (const entry of relevant) {
      const event = readEvent(entry);
      const file = fileOf.get(entry);
      if (entry.event === "provider_request")
        writeJson(out, file, {
          request: event,
          responses: (byId.get(entry.id) ?? [])
            .filter((e) => e !== entry)
            .map(readEvent),
          omissions: [
            "Authentication material",
            "Private model reasoning/continuation",
          ],
        });
      else if (
        entry.event === "model_turn" ||
        entry.event === "tool_call" ||
        (entry.event === "model_turn_started" &&
          file.includes("runtime-started-"))
      )
        writeJson(out, file, event);
      if (entry.event === "attachment") attachments.push(event);
      if (entry.event.startsWith("browser_import")) imports.push(event);
      if (entry.event === "tool_call") toolEvents.push(file);
      const fields = file ? BODY_FIELDS.filter((k) => k in event) : [];
      const recorded = fields.length
        ? {
            ...Object.fromEntries(
              Object.entries(event).filter(([k]) => !fields.includes(k)),
            ),
            packed: { file, fields },
          }
        : file
          ? { ...event, packed: { file, fields: [] } }
          : event;
      writeSync(traceOut, JSON.stringify(traceSafe(recorded)) + "\n");
      const fd = rowFile(sourceKeyOf(entry));
      writeSync(
        fd,
        `| ${cell(event.at)} | ${cell(event.event)} | ${cell(eventDetail(event, file, link))} |\n`,
      );
    }
    closeSync(traceOut);
    for (const fd of rowOut.values()) closeSync(fd);
    writeJson(out, "final/attachment.json", {
      stored:
        rows.application_details?.map((d) => d.resume_artifact_json) ?? [],
      observed: attachments,
    });
    if (kind === "import")
      writeJson(out, "import.json", {
        inventory: imports,
        signInStates: rows.job_sites ?? [],
        note: "Cookie import counts do not prove a working sign-in; consult the observed site state",
      });

    const stepFile = path.join(
      options.evidence ?? state?.evidenceDir ?? evidenceDir,
      "steps.log",
    );
    if (existsSync(stepFile)) {
      const stepText = readFileSync(stepFile, "utf8")
        .split("\n")
        .filter((line) => {
          if (!Number.isFinite(startMs)) return true;
          const at = Date.parse(line.slice(0, 24));
          return (
            Number.isFinite(at) &&
            at >= startMs &&
            (!Number.isFinite(endMs) || at <= endMs)
          );
        })
        .join("\n");
      writeFileSync(path.join(out, "steps.log"), traceSafe(stepText), {
        mode: 0o600,
        flag: "wx",
      });
    }

    const head = [
      "# Run evidence",
      "",
      "> Generated from recorded events and stored product rows. Do not edit.",
      "",
      ...warnings.map((w) => `- **${w}**`),
      "",
      "## Header",
      "",
      "```json",
      json(manifest.header),
      "```",
      "",
    ];
    const tail = [
      "",
      "## Needs you",
      "",
      "[Stored items and reasons](needs-you.json)",
      "",
      "## Application records and attachment",
      "",
      ...Object.keys(rows).map((t) => `- [${t}](db/${t}.json)`),
      "- [Attached file identity](final/attachment.json)",
      "",
      "## Final site evidence",
      "",
      "[URL and visible text](final/page.json) · [Saved outcome and confirmation](final/confirmation.json)",
      "",
      ...(finalShot
        ? ["![Final application page](final/page.png)"]
        : ["No final application screenshot was recorded."]),
      "",
    ];
    const packFile = path.join(out, "pack.md");
    if (kind === "search") {
      const total = (key) => perSource.reduce((n, s) => n + s.trace[key], 0);
      writeFileSync(
        packFile,
        [
          ...head,
          "## Search",
          "",
          ...searches.map(
            (s) =>
              `- ${s.id}: ${s.state}; ${s.sources_done}/${s.sources_total} sources; found ${s.found}, added ${s.added}, merged ${s.merged}, already saved ${s.already_saved}, scored ${s.scored}; started ${new Date(Number(s.started_at)).toISOString()}${s.finished_at ? `, finished ${new Date(Number(s.finished_at)).toISOString()}` : ""}; settings ${JSON.stringify(s.settings_json)}${s.error ? `; error ${s.error}` : ""}`,
          ),
          "",
          `Trace: ${relevant.length} events (${total("pagesFetched")} pages fetched, ${requests.length} model calls, ${tools.length} tool calls, ${ours.length} ours). Every event is in [trace.jsonl](trace.jsonl); exact model requests and responses are in model/, listed per source.`,
          "",
          "## Sources",
          "",
          "| Source | State | Lane | Cards | Related | Unrelated | Seen | Failed reads | Found | Added | Pages fetched | Model calls | Tool calls | Ours | Errors | Section |",
          "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
          ...perSource.map((s) => {
            const row = sourceRows.find(
              (r) => String(r.source_id) === s.sourceId,
            );
            return `| ${cell(s.label ?? s.sourceId)} | ${cell(row?.state)} | ${cell(row?.lane)} | ${row?.cards ?? ""} | ${row?.related ?? ""} | ${row?.unrelated ?? ""} | ${row?.seen ?? ""} | ${row?.failed_reads ?? ""} | ${row?.found ?? ""} | ${row?.added ?? ""} | ${s.trace.pagesFetched} | ${s.trace.modelCalls} | ${s.trace.toolCalls} | ${s.trace.ours} | ${s.errors.events.length} | [${s.section}](${s.section}) |`;
          }),
          "",
          ...perSource.flatMap((s) => [
            `### ${s.label ?? `Source ${s.sourceId}`}`,
            "",
            ...(s.url ? [`- URL: ${s.url}`] : []),
            ...(s.errors.message
              ? [`- Stored message: ${cell(s.errors.message)}`]
              : []),
            s.trace.events
              ? `- Trace: ${s.trace.events} events, ${s.trace.first} to ${s.trace.last}; pages started ${s.trace.pagesStarted}, fetched ${s.trace.pagesFetched} (by status ${JSON.stringify(s.errors.pagesByStatus)})`
              : "- Trace: no events for this source in the recorded trace; its stored row is the only evidence here",
            ...s.trace.sourceResults.map(
              (r) =>
                `- Source result ${r.at}: pages ${r.pagesFetched}, listings read ${r.listingsRead}, complete ${r.complete}; ${cell((r.notes ?? []).join(" "))}`,
            ),
            `- Listings sighted during this search: ${s.sightedThisSearch} (${s.newThisSearch} first found in it)`,
            `- Model calls: ${s.trace.modelCalls} ${JSON.stringify(s.trace.modelCallsByPurpose)}; model turns ${s.trace.modelTurns}`,
            `- Tool calls: ${s.trace.toolCalls} ${JSON.stringify(s.trace.toolCallsByName)}`,
            `- Ours: ${s.trace.ours} ${JSON.stringify(s.trace.oursBy)}`,
            `- Errors: ${s.errors.events.length}${s.errors.events.length ? ` ${cell(JSON.stringify(countBy(s.errors.events, (e) => `${e.event}: ${e.error?.message ?? e.error ?? ""}`.slice(0, 200))))}` : ""}`,
            `- Screenshots: ${s.trace.screenshots}; full section with every event, model file and listing: [${s.section}](${s.section})`,
            "",
          ]),
          ...tail,
        ].join("\n"),
        { mode: 0o600, flag: "wx" },
      );
    } else {
      writeFileSync(
        packFile,
        [
          ...head,
          "## Model calls",
          "",
          ...modelFiles.map((f) => `- [${f}](${f})`),
          "",
          "## Screenshots",
          "",
          ...sheets.map((f) => `![${f}](${f})`),
          "",
          "## Events",
          "",
          "| Time | Event | Detail |",
          "| --- | --- | --- |",
          "",
        ].join("\n"),
        { mode: 0o600, flag: "wx" },
      );
      const fd = openSync(packFile, "a");
      try {
        forEachLine(rowsTmp, (line) =>
          writeSync(fd, Buffer.concat([line, Buffer.from("\n")])),
        );
        writeSync(fd, tail.join("\n"));
      } finally {
        closeSync(fd);
      }
      rmSync(rowsTmp);
    }
    const files = readdirSync(out, { recursive: true }).filter(
      (f) => statSync(path.join(out, f)).isFile() && !/^events-/.test(f),
    );
    manifest.files = [];
    for (const file of files)
      manifest.files.push({
        file,
        sha256: await sha256File(path.join(out, file)),
      });
    writeJson(out, "manifest.json", manifest);
    return manifest;
  } finally {
    for (const fd of fds) closeSync(fd);
  }
}

/** Ours events by kind; older manifests are counted from their trace.jsonl. */
function oursKinds(dir, manifest) {
  if (manifest.oursByKind) return manifest.oursByKind;
  const file = path.join(dir, "trace.jsonl");
  const counts = {};
  if (!existsSync(file)) return counts;
  forEachLine(file, (line) => {
    if (!line.includes('"event":"ours"')) return;
    try {
      const event = JSON.parse(line.toString("utf8"));
      if (event.event === "ours")
        counts[event.kind ?? "unknown"] =
          (counts[event.kind ?? "unknown"] ?? 0) + 1;
    } catch {
      /* An unreadable line is reported by the pack itself. */
    }
  });
  return counts;
}

export function generateRound(dir) {
  dir = path.resolve(dir);
  if (inside(dir, checkout))
    throw Error("Round evidence must stay outside the repository.");
  const packs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(path.join(dir, e.name, "manifest.json")))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const manifest = JSON.parse(
        readFileSync(path.join(dir, e.name, "manifest.json"), "utf8"),
      );
      const kinds = oursKinds(path.join(dir, e.name), manifest);
      return {
        name: e.name,
        ...manifest,
        oursKinds: kinds,
        oursTotal: Object.values(kinds).reduce((n, v) => n + v, 0),
      };
    });
  const cell = (value) =>
    String(value ?? "unknown")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
  const ours = (p) => {
    const kinds = Object.entries(p.oursKinds)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    return `${p.oursTotal}${kinds ? ` (${kinds})` : ""}`;
  };
  const content = [
    "# Round evidence",
    "",
    "Generated from each run's manifest. Raw packs win over this index. Ours counts every recorded intervention by our code, by kind (blocked, rewritten, capped, timed_out, asked_person).",
    "",
    "| Run | Kind | ATS | Build | Outcome | Minutes | Needs you | Ours | Recorded stop-related event / application error |",
    "| --- | --- | --- | --- | --- | ---: | ---: | --- | --- |",
    ...packs.map(
      (p) =>
        `| [${p.name}](${p.name}/pack.md) | ${cell(p.kind)} | ${cell(p.ats)} | ${cell((p.header?.build?.head ?? p.header?.raw?.build?.head)?.slice(0, 9))} | ${cell(p.outcome)} | ${p.minutes?.toFixed(2) ?? "unknown"} | ${p.needsYouCount} | ${ours(p)} | ${cell(p.firstStopReason)} |`,
    ),
    "",
  ].join("\n");
  // Rebuilding the index is explicit; packs are never edited.
  writeFileSync(path.join(dir, "round.md"), content, { mode: 0o600 });
  return packs.length;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        "out",
        "trace",
        "data",
        "application",
        "application-key",
        "ats",
        "company",
        "kind",
        "since",
        "until",
        "expected-model",
        "evidence",
        "round",
        "search",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  if (values.out) {
    const manifest = await generatePack(values);
    console.log(
      `${path.join(path.resolve(values.out), "pack.md")} (${manifest.warnings.length} evidence warnings)`,
    );
  }
  if (values.round)
    console.log(`round.md: ${generateRound(values.round)} runs`);
  if (!values.out && !values.round)
    throw Error(
      "Use --out <outside-repo-run-dir> --application <id> | --kind search [--search <id>] [--trace <dir>] [--data <profile>], or --round <round-dir>.",
    );
}
