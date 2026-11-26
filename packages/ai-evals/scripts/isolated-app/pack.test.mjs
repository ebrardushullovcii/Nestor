import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCanvas } from "@napi-rs/canvas";
import { generatePack, generateRound } from "./pack.mjs";
import { forEachLine, readLineAt } from "./trace.mjs";
import { closeSync, openSync } from "node:fs";

test("trace lines are read in chunks, whatever their length, and read back by byte range", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nestor-trace-lines-"));
  try {
    const file = path.join(root, "events-1.jsonl");
    const long = JSON.stringify({
      event: "model_turn",
      text: "é".repeat(5000),
    });
    writeFileSync(file, `{"event":"a"}\n\n${long}\n{"event":"tail"}`);
    const lines = [];
    forEachLine(
      file,
      (buffer, offset, line) =>
        lines.push({
          text: buffer.toString("utf8"),
          offset,
          length: buffer.length,
          line,
        }),
      64,
    );
    assert.deepEqual(
      lines.map((l) => [l.text, l.line]),
      [
        ['{"event":"a"}', 1],
        [long, 3],
        ['{"event":"tail"}', 4],
      ],
    );
    const fd = openSync(file);
    try {
      for (const l of lines)
        assert.equal(readLineAt(fd, l.offset, l.length), l.text);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packs preserve recorded facts, application linkage and unknowns; omit vault/storage; index two runs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nestor-pack-test-"));
  try {
    const data = path.join(root, "profile");
    mkdirSync(data);
    writeFileSync(
      path.join(data, "nestor-profile-provenance.json"),
      JSON.stringify({ kind: "synthetic" }),
    );
    const db = new DatabaseSync(path.join(data, "job-finder.sqlite"));
    db.exec(`CREATE TABLE applications(id INTEGER,job_id INTEGER,attempt INTEGER,mode TEXT,state TEXT,error TEXT,submission_outcome_json TEXT);
      INSERT INTO applications VALUES(1,7,1,'confirm_before_submit','needs_you',NULL,NULL);
      CREATE TABLE jobs(id INTEGER, company TEXT, title TEXT, found_at INTEGER); INSERT INTO jobs VALUES(7,'Synthetic Acme','Engineer',${Date.parse("2026-11-06T10:00:02.000Z")});
      CREATE TABLE application_details(application_id INTEGER,resume_artifact_json TEXT,authority_envelope_id TEXT);
      INSERT INTO application_details VALUES(1,'{"fileName":"resume.pdf","sha256":"identity"}',NULL);
      CREATE TABLE application_needs_you(application_id INTEGER,task_id INTEGER); INSERT INTO application_needs_you VALUES(1,2);
      CREATE TABLE needs_you(id INTEGER,kind TEXT,prompt TEXT,ask_reason_json TEXT,resolved_at INTEGER); INSERT INTO needs_you VALUES(2,'question','Certification?','{"reason":"missing fact"}',NULL);
      CREATE TABLE profile_settings(id INTEGER,ai_behavior_browser_permissions_sign_in INTEGER); INSERT INTO profile_settings VALUES(1,0);
      CREATE TABLE searches(id TEXT,state TEXT,settings_json TEXT,started_at INTEGER,finished_at INTEGER,sources_total INTEGER,sources_done INTEGER,found INTEGER,added INTEGER,merged INTEGER,already_saved INTEGER,scored INTEGER,error TEXT);
      INSERT INTO searches VALUES('search_old','done','{}',1000,2000,1,1,0,0,0,0,0,NULL);
      INSERT INTO searches VALUES('search_now','stopped','{"depth":"thorough"}',${Date.parse("2026-11-06T09:00:00.000Z")},${Date.parse("2026-11-06T10:00:07.000Z")},2,1,5,3,0,7,5,NULL);
      CREATE TABLE search_sources(search_id TEXT,source_id TEXT,label TEXT,state TEXT,lane TEXT,phase TEXT,url TEXT,cards INTEGER,related INTEGER,unrelated INTEGER,seen INTEGER,found INTEGER,hidden INTEGER,added INTEGER,failed_reads INTEGER,message TEXT);
      INSERT INTO search_sources VALUES('search_old','acme','acme.test','done','http',NULL,'https://acme.test',99,0,0,99,0,0,0,0,NULL);
      INSERT INTO search_sources VALUES('search_now','acme','acme.test','done','browser',NULL,'https://acme.test',12,3,2,7,5,0,3,0,'12 listings');
      INSERT INTO search_sources VALUES('search_now','beta','beta.test','stopped','http',NULL,'https://beta.test',0,0,0,0,0,0,0,0,NULL);
      CREATE TABLE job_sightings(job_id INTEGER,url TEXT,site TEXT,source_id TEXT,source_label TEXT,apply_url TEXT,seen_at INTEGER);
      INSERT INTO job_sightings VALUES(7,'https://acme.test/7','acme.test','acme','acme.test',NULL,${Date.parse("2026-11-06T10:00:02.000Z")});
      INSERT INTO job_sightings VALUES(7,'https://acme.test/old','acme.test','acme','acme.test',NULL,1500);
      CREATE TABLE password_vault(password TEXT); INSERT INTO password_vault VALUES('DO_NOT_EXPORT');`);
    db.close();
    const trace = path.join(root, "trace");
    mkdirSync(path.join(trace, "shots"), { recursive: true });
    const canvas = createCanvas(80, 40);
    canvas.getContext("2d").fillText("Acme", 0, 20);
    writeFileSync(
      path.join(trace, "shots/page.png"),
      canvas.toBuffer("image/png"),
    );
    const events = [
      {
        event: "application_requested",
        at: "2026-11-06T10:00:00.000Z",
        input: { selection: { ids: [7] } },
        settings: { initialPermission: false },
        instruction: "confirm_before_submit",
      },
      {
        event: "run_header",
        at: "2026-11-06T10:00:00.000Z",
        network: "replica",
        ai: "live",
        build: {
          head: "commit",
          dirty: false,
          builtAt: "2026-11-06T09:00:00Z",
        },
      },
      {
        event: "provider_request",
        at: "2026-11-06T10:00:01.000Z",
        id: "call",
        endpoint: "https://example.test/v1/chat/completions",
        request: {
          model: "deepseek-v4.1-flash",
          messages: [{ role: "system", content: "exact prompt" }],
          tools: [],
        },
      },
      {
        event: "provider_response",
        at: "2026-11-06T10:00:03.000Z",
        id: "call",
        response: {
          choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        },
      },
      {
        event: "tool_call",
        at: "2026-11-06T10:00:04.000Z",
        name: "click",
        arguments: "{}",
        result: "exact result",
        durationMs: 14,
      },
      {
        event: "ours",
        at: "2026-11-06T10:00:04.000Z",
        by: "test:existingCheck",
        kind: "asked_person",
        reason: "missing fact",
      },
      {
        event: "ours",
        at: "2026-11-06T10:00:04.500Z",
        toolCallId: "call_1",
        by: "packages/agent-runtime/src/agent-loop.ts:runAgentLoop/tool",
        kind: "timed_out",
        reason: "click stopped reporting progress (idle=180000)",
      },
      {
        event: "search_page_fetched",
        at: "2026-11-06T10:00:04.600Z",
        sourceId: "acme",
        url: "https://acme.test/jobs",
        status: 200,
      },
      {
        event: "provider_request",
        at: "2026-11-06T10:00:06.500Z",
        id: "late",
        sourceId: "acme",
        purpose: "extractJobsFromPage",
        endpoint: "https://example.test/v1/chat/completions",
        request: {
          model: "deepseek-v4.1-flash",
          messages: [{ role: "user", content: "late prompt" }],
        },
      },
      {
        event: "provider_request",
        at: "2026-11-06T10:00:06.600Z",
        id: "omitted",
        sourceId: "beta",
        endpoint: "https://example.test/v1/chat/completions",
        request: "[secret omitted]",
      },
      {
        event: "provider_error",
        at: "2026-11-06T10:00:08.000Z",
        id: "late",
        sourceId: "acme",
        error: { name: "AbortError", message: "search stopped" },
      },
      {
        event: "page_snapshot",
        at: "2026-11-06T10:00:05.000Z",
        applicationKey: "application_1_attempt_1",
        action: "click",
        shot: "shots/page.png",
        url: "http://localhost/apply",
        visibleText: "Certification?",
      },
      {
        event: "page_snapshot",
        at: "2026-11-06T10:00:06.000Z",
        applicationKey: "application_999_attempt_1",
        action: "other-tab",
        shot: "shots/page.png",
        url: "http://localhost/other",
        visibleText: "Wrong tab",
      },
    ];
    writeFileSync(
      path.join(trace, "events-1.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n"),
    );
    const round = path.join(root, "R1");
    mkdirSync(round);
    const run = path.join(round, "01-greenhouse-acme");
    const manifest = await generatePack({
      out: run,
      trace,
      data,
      application: "1",
      ats: "greenhouse",
      state: {},
    });
    assert.equal(manifest.oursCount, 2);
    assert.deepEqual(manifest.oursByKind, { asked_person: 1, timed_out: 1 });
    assert.equal(manifest.header.build.head, "commit");
    // Bodies live once in model/; trace.jsonl points at them.
    const packedTrace = readFileSync(path.join(run, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const packedRequest = packedTrace.find((e) => e.id === "call");
    assert.equal(packedRequest.request, undefined);
    assert.deepEqual(packedRequest.packed, {
      file: "model/0001-call.json",
      fields: ["request"],
    });
    assert.equal(
      packedTrace.find((e) => e.event === "provider_response").packed.file,
      "model/0001-call.json",
    );
    const sliced = events
      .filter((event) => event.event !== "run_header" && !event.sourceId)
      .map((event) => ({
        ...event,
        runConfiguration: { ai: "live", network: "live" },
      }));
    sliced.push({
      event: "operator_action",
      at: "2026-11-06T09:59:00.000Z",
      action: "answer_need",
      applicationKeys: ["application_1_attempt_0"],
    });
    const sliceTrace = path.join(root, "sliced-trace");
    mkdirSync(sliceTrace);
    writeFileSync(
      path.join(sliceTrace, "events-sliced.jsonl"),
      sliced.map((event) => JSON.stringify(event)).join("\n"),
    );
    const continuation = await generatePack({
      out: path.join(root, "continued-pack"),
      trace: sliceTrace,
      data,
      application: "1",
      state: {},
    });
    assert.equal(continuation.header.raw.network, "live");
    assert.equal(continuation.header.raw.ai, "live");
    assert.equal(continuation.header.operatorActed, true);
    assert.deepEqual(manifest.header.permissionsAtStart, {
      initialPermission: false,
    });
    assert.equal(manifest.needsYouCount, 1);
    assert.equal(manifest.header.reported[0].model, "unknown");
    assert.ok(manifest.warnings.some((w) => w.includes("PERMISSIONS OFF")));
    assert.equal(manifest.shots.length, 1);
    assert.equal(
      JSON.parse(readFileSync(path.join(run, "final/page.json"), "utf8")).url,
      "http://localhost/apply",
    );
    assert.ok(
      readFileSync(path.join(run, "model/0001-call.json"), "utf8").includes(
        "exact prompt",
      ),
    );
    assert.ok(readdirSync(path.join(run, "sheets")).includes("001.png"));
    assert.ok(
      !readdirSync(path.join(run, "db")).some((f) => f.includes("vault")),
    );
    await assert.rejects(
      generatePack({ out: run, trace, data, application: "1", state: {} }),
      /immutable/,
    );
    await generatePack({
      out: path.join(round, "02-greenhouse-acme"),
      trace,
      data,
      application: "1",
      ats: "greenhouse",
      state: {},
    });
    const searchOut = path.join(root, "search");
    const searchPack = await generatePack({
      out: searchOut,
      trace,
      data,
      kind: "search",
      state: {},
    });
    // Only the search that ran during the trace, and calls begun in it.
    assert.deepEqual(searchPack.searchIds, ["search_now"]);
    const search = JSON.parse(
      readFileSync(path.join(searchOut, "search.json"), "utf8"),
    );
    const acme = search.perSource.find((s) => s.sourceId === "acme");
    assert.equal(acme.listingsRead, 12);
    assert.equal(acme.listingsAlreadySeen, 7);
    assert.equal(acme.listingsScreened, 5);
    assert.equal(acme.sightedThisSearch, 1);
    assert.equal(acme.trace.pagesFetched, 1);
    assert.equal(acme.trace.modelCalls, 1);
    assert.equal(acme.errors.events[0].error.message, "search stopped");
    assert.equal(search.perSource.length, 2);
    const acmeSection = readFileSync(
      path.join(searchOut, acme.section),
      "utf8",
    );
    assert.match(acmeSection, /model\/0002-late\.json/);
    assert.match(acmeSection, /search_page_fetched/);
    assert.ok(
      readFileSync(
        path.join(searchOut, "model/0002-late.json"),
        "utf8",
      ).includes("search stopped"),
    );
    assert.match(
      readFileSync(path.join(searchOut, "pack.md"), "utf8"),
      /\| acme\.test \| done \| browser \| 12 \|/,
    );
    // A pack from stored rows alone says so.
    const dbOnly = await generatePack({
      out: path.join(root, "db-only"),
      data,
      kind: "search",
      search: "search_now",
      state: {},
    });
    assert.ok(dbOnly.warnings.some((w) => w.startsWith("DATABASE ONLY")));
    assert.ok(
      searchPack.warnings.some((w) =>
        w.startsWith("OMITTED REQUESTS: 1 model requests"),
      ),
    );
    assert.ok(!searchPack.warnings.some((w) => w.startsWith("MODEL:")));
    assert.deepEqual(
      searchPack.header.requested.map((r) => [r.model, r.count]),
      [
        ["deepseek-v4.1-flash", 2],
        ["omitted in trace", 1],
      ],
    );
    assert.equal(dbOnly.trace.databaseOnly, true);
    assert.equal(
      JSON.parse(
        readFileSync(path.join(root, "db-only", "search.json"), "utf8"),
      ).perSource.find((s) => s.sourceId === "acme").listingsSaved,
      3,
    );
    await assert.rejects(
      generatePack({
        out: path.join(root, "db-only-guess"),
        data,
        kind: "search",
        state: {},
      }),
      /--search <id> is required/,
    );
    await assert.rejects(
      generatePack({
        out: path.join(root, "typo"),
        trace: path.join(root, "no-such-trace"),
        data,
        application: "1",
        state: {},
      }),
      /Trace directory does not exist/,
    );
    // An older manifest without kinds is counted from its own trace.jsonl.
    const legacy = path.join(round, "03-legacy");
    mkdirSync(legacy);
    writeFileSync(
      path.join(legacy, "manifest.json"),
      JSON.stringify({
        kind: "application",
        oursCount: 0,
        needsYouCount: 0,
        header: { raw: { build: { head: "abcdef1234" } } },
      }),
    );
    writeFileSync(
      path.join(legacy, "trace.jsonl"),
      JSON.stringify({
        event: "ours",
        kind: "timed_out",
        by: "x",
        reason: "y",
      }) + "\n",
    );
    assert.equal(generateRound(round), 3);
    const roundText = readFileSync(path.join(round, "round.md"), "utf8");
    assert.match(
      roundText,
      /01-greenhouse-acme.*commit.*needs_you.*\| 2 \(asked_person 1, timed_out 1\) \|/,
    );
    assert.match(roundText, /03-legacy.*abcdef123.*\| 1 \(timed_out 1\) \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
