// Generated evidence only. No network archive, cookies, storage or credentials.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { checkout, evidenceDir, readState } from "./common.mjs";
import { inside, profileProvenance } from "./live-profile.mjs";
import { readEvents, traceSafe } from "./trace.mjs";

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
export function readRunRows(data, applicationId, kind) {
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
      read("searches");
      read("search_sources");
      read("jobs");
      read("job_sightings");
    }
    db.exec("COMMIT");
    return traceSafe(result);
  } finally {
    db.close();
  }
}

export async function contactSheets(out, shots) {
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
    const file = `sheets/${String(sheets.length + 1).padStart(3, "0")}.png`;
    writeFileSync(path.join(out, file), canvas.toBuffer("image/png"), {
      mode: 0o600,
      flag: "wx",
    });
    sheets.push(file);
  }
  return sheets;
}

export async function generatePack(options) {
  const state = options.state ?? readState();
  const out = path.resolve(options.out);
  const trace = path.resolve(
    options.trace ?? process.env.NESTOR_RUN_TRACE_DIR ?? options.out,
  );
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
  if (!existsSync(trace))
    throw Error(
      "Trace directory does not exist. Start the app with NESTOR_RUN_TRACE_DIR set.",
    );
  const events = readdirSync(trace)
    .filter((f) => /^events-.*\.jsonl$/.test(f))
    .flatMap((f) => readEvents(path.join(trace, f)))
    .filter(
      (e) =>
        (!options.since || e.at >= options.since) &&
        (!options.until || e.at <= options.until),
    )
    .sort(
      (a, b) =>
        (a.at ?? "").localeCompare(b.at ?? "") ||
        (a.pid ?? 0) - (b.pid ?? 0) ||
        (a.seq ?? 0) - (b.seq ?? 0),
    );
  const rows = data ? readRunRows(data, options.application, kind) : {};
  const storedApp = rows.applications?.[0];
  const app = storedApp?.posting_closed
    ? { ...storedApp, state: "closed" }
    : storedApp;
  const applicationKey = app
    ? `application_${app.id}_attempt_${app.attempt}`
    : options["application-key"];
  const startMs = Number(app?.queued_at);
  const terminal =
    app && !["queued", "running", "submitting"].includes(app.state);
  const endMs = terminal ? Number(app.updated_at) : Infinity;
  const relevant = events.filter((e) => {
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
      (e.input?.selection?.ids ?? e.input?.jobIds)?.includes(app.job_id)
    )
      return true;
    if (e.applicationKey && applicationKey)
      return e.applicationKey === applicationKey;
    if (e.applicationKeys && applicationKey)
      return e.applicationKeys.includes(applicationKey);
    // Retain settings history and header facts; unscoped activity belongs only
    // to this application's persisted time interval, never the whole session.
    if (e.event.startsWith("settings_"))
      return !Number.isFinite(endMs) || Date.parse(e.at) <= endMs;
    const at = Date.parse(e.at);
    return (
      (!Number.isFinite(startMs) || at >= startMs) &&
      (!Number.isFinite(endMs) || at <= endMs)
    );
  });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const folder of ["shots", "sheets", "model", "db", "final"])
    mkdirSync(path.join(out, folder), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(out, "trace.jsonl"),
    relevant.map((e) => JSON.stringify(traceSafe(e))).join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const headerEvent =
    relevant.findLast((e) => e.event === "run_header") ??
    relevant.find((e) => e.runConfiguration)?.runConfiguration;
  const permissions = rows.profile_settings ?? [];
  const permissionValues = Object.entries(permissions[0] ?? {}).filter(
    ([key]) =>
      /permission|captcha|sign_in|create_account|google|declaration|salary|written|pay/i.test(
        key,
      ),
  );
  const requests = relevant.filter((e) => e.event === "provider_request");
  const modelFiles = [];
  for (const [index, request] of requests.entries()) {
    const file = `model/${String(index + 1).padStart(4, "0")}-${request.id}.json`;
    const responses = relevant.filter(
      (e) => e.id === request.id && e !== request,
    );
    writeJson(out, file, {
      request,
      responses,
      omissions: [
        "Authentication material",
        "Private model reasoning/continuation",
      ],
    });
    modelFiles.push(file);
  }
  // Deterministic models still leave the exact runtime request and response.
  for (const [index, event] of relevant
    .filter((e) => e.event === "model_turn")
    .entries()) {
    const file = `model/runtime-${String(index + 1).padStart(4, "0")}.json`;
    writeJson(out, file, event);
    modelFiles.push(file);
  }
  const toolFiles = new Map();
  for (const [index, event] of relevant
    .filter((e) => e.event === "tool_call")
    .entries()) {
    const file = `model/tool-${String(index + 1).padStart(4, "0")}.json`;
    writeJson(out, file, event);
    toolFiles.set(event, file);
  }
  const shots = [];
  for (const event of relevant.filter(
    (e) => e.event === "page_snapshot" || e.event === "driver_snapshot",
  )) {
    if (!event.shot && !event.path) continue;
    const source = event.shot ? path.resolve(trace, event.shot) : event.path;
    if (event.shot && !inside(source, trace))
      throw Error("Screenshot path escapes trace directory.");
    if (!existsSync(source)) continue;
    const file = `shots/${String(shots.length + 1).padStart(4, "0")}.png`;
    copyFileSync(source, path.join(out, file));
    shots.push({ ...event, file });
  }
  const sheets = await contactSheets(out, shots);
  for (const [table, records] of Object.entries(rows))
    writeJson(out, `db/${table}.json`, records);
  const needs = rows.needs_you ?? [];
  writeJson(out, "needs-you.json", needs);
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
  writeJson(
    out,
    "final/page.json",
    finalShot
      ? {
          url: finalShot.url,
          visibleText: finalShot.visibleText,
          at: finalShot.at,
          applicationKey: finalShot.applicationKey,
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
  const requestedApplication = relevant.find(
    (e) =>
      e.event === "application_requested" &&
      (e.input?.selection?.ids ?? e.input?.jobIds)?.includes(app?.job_id),
  );
  const instructionMode =
    requestedApplication?.instruction ??
    rows.application_instructions?.[0]?.mode ??
    app?.mode;
  const attachments = {
    stored: rows.application_details?.map((d) => d.resume_artifact_json) ?? [],
    observed: relevant.filter((e) => e.event === "attachment"),
  };
  writeJson(out, "final/attachment.json", attachments);
  const profile = data
    ? profileProvenance(data)
    : (headerEvent?.profile ?? { kind: "unknown" });
  const reported = relevant.filter((e) => e.event === "provider_reported");
  const ours = relevant.filter((e) => e.event === "ours");
  const warnings = [];
  if (relevant.some((e) => e.event === "trace_read_error"))
    warnings.push(
      "INCOMPLETE TRACE: at least one recorded line could not be read",
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
  if (!finalShot) warnings.push("Final application screenshot is missing");
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
  const requestedModels = [
    ...new Set(requests.map((r) => r.request?.model ?? "unknown")),
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
      firstStopReason = JSON.parse(firstStopReason).summary ?? firstStopReason;
    } catch {
      /* Keep the recorded reason verbatim. */
    }
  }
  const manifest = {
    version: 1,
    kind,
    applicationId: app?.id ?? null,
    applicationKey,
    ats: options.ats ?? "unknown",
    company: rows.jobs?.[0]?.company ?? options.company ?? "unknown",
    outcome: app?.state ?? "unknown",
    minutes:
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? (endMs - startMs) / 60000
        : first && last
          ? (Date.parse(last) - Date.parse(first)) / 60000
          : null,
    needsYouCount: needs.filter((n) => !n.resolved_at).length,
    oursCount: ours.length,
    firstStopReason,
    header: {
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
      requested: requests.map((r) => ({
        endpoint: r.endpoint,
        model: r.request?.model ?? "unknown",
        effort:
          r.request?.reasoning_effort ??
          r.request?.reasoning?.effort ??
          "unknown",
        at: r.at,
      })),
      reported: reported.map((r) => ({
        model: r.model ?? "unknown",
        effort: r.effort ?? "unknown",
        at: r.at,
      })),
      operatorActed: relevant.some((e) => e.event === "operator_action"),
      operatorEvidence:
        "Native user-input ledger and explicit driver operator records; no input contents are captured",
    },
    warnings,
    models: modelFiles,
    tools: [...toolFiles.values()],
    shots: shots.map((s) => s.file),
    sheets,
    generatedAt: new Date().toISOString(),
  };
  if (!reported.length)
    manifest.header.reported.push({ model: "unknown", effort: "unknown" });
  if (kind === "search")
    writeJson(out, "search.json", {
      sources: rows.search_sources ?? [],
      pages: relevant.filter((e) => e.event.startsWith("search_page")),
      perSource: (rows.search_sources ?? []).map((source) => ({
        sourceId: source.source_id,
        url: source.url,
        pagesFetched: relevant
          .filter(
            (e) =>
              e.event === "search_source_result" &&
              e.sourceId === source.source_id,
          )
          .map((e) => e.pagesFetched),
        // `seen` is previously seen, not listings read. Keep both facts.
        listingsRead: source.cards,
        listingsScreened: source.related + source.unrelated,
        listingsAlreadySeen: source.seen,
        listingsSaved: source.added,
        errors: {
          failedReads: source.failed_reads,
          message: source.message,
          events: relevant.filter(
            (e) =>
              e.event === "search_source_error" &&
              e.sourceId === source.source_id,
          ),
        },
      })),
      searches: rows.searches ?? [],
    });
  if (kind === "import")
    writeJson(out, "import.json", {
      inventory: relevant.filter((e) => e.event.startsWith("browser_import")),
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
  const lines = [
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
  ];
  const cell = (text) =>
    String(text ?? "")
      .replaceAll("|", "\\|")
      .replaceAll("\n", "<br>");
  for (const event of relevant) {
    let detail;
    if (event.event === "ours")
      detail = `${event.by}: ${event.kind}: ${event.reason}`;
    else if (event.event === "tool_call")
      detail = `[${event.name}](${toolFiles.get(event)}) (${event.durationMs} ms): ${event.result?.split("\n")[0] ?? "No tool message"}`;
    else if (event.event === "tool_call_started")
      detail = `${event.name}: dispatched; complete arguments in trace.jsonl`;
    else if (event.event === "page_snapshot")
      detail = `${event.action}: ${event.url}; screenshot in shots/`;
    else if (event.event === "model_turn_started")
      detail = `Model turn ${event.id} started; exact request in model/`;
    else if (event.event === "model_turn")
      detail = `Model turn ${event.id} returned (${event.durationMs} ms); exact response in model/`;
    else if (event.event === "provider_request")
      detail = `${event.request?.model} → ${event.endpoint}; exact request in model/`;
    else if (
      ["provider_response", "provider_response_raw"].includes(event.event)
    )
      detail = `Provider response ${event.id}; exact text, tool calls and finish reason in model/`;
    else if (event.event.startsWith("settings_"))
      detail = `Settings recorded; complete values in trace.jsonl`;
    else if (event.event === "application_requested")
      detail = `Application requested: ${event.instruction}; complete settings in trace.jsonl`;
    else detail = JSON.stringify(event);
    lines.push(
      `| ${cell(event.at)} | ${cell(event.event)} | ${cell(detail)} |`,
    );
  }
  lines.push(
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
  );
  writeFileSync(path.join(out, "pack.md"), lines.join("\n") + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  const files = readdirSync(out, { recursive: true }).filter(
    (f) => statSync(path.join(out, f)).isFile() && !/^events-/.test(f),
  );
  manifest.files = files.map((file) => ({
    file,
    sha256: createHash("sha256")
      .update(readFileSync(path.join(out, file)))
      .digest("hex"),
  }));
  writeJson(out, "manifest.json", manifest);
  return manifest;
}

export function generateRound(dir) {
  dir = path.resolve(dir);
  if (inside(dir, checkout))
    throw Error("Round evidence must stay outside the repository.");
  const packs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(path.join(dir, e.name, "manifest.json")))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      name: e.name,
      ...JSON.parse(
        readFileSync(path.join(dir, e.name, "manifest.json"), "utf8"),
      ),
    }));
  const cell = (value) =>
    String(value ?? "unknown")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
  const content = [
    "# Round evidence",
    "",
    "Generated from each run's manifest. Raw packs win over this index.",
    "",
    "| Run | ATS | Outcome | Minutes | Needs you | Ours | Recorded stop-related event / application error |",
    "| --- | --- | --- | ---: | ---: | ---: | --- |",
    ...packs.map(
      (p) =>
        `| [${p.name}](${p.name}/pack.md) | ${cell(p.ats)} | ${cell(p.outcome)} | ${p.minutes?.toFixed(2) ?? "unknown"} | ${p.needsYouCount} | ${p.oursCount} | ${cell(p.firstStopReason)} |`,
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
      "Use --out <outside-repo-run-dir> --application <id> [--trace <dir>] or --round <round-dir>.",
    );
}
