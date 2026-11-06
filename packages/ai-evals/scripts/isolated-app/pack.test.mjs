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
      CREATE TABLE jobs(id INTEGER, company TEXT); INSERT INTO jobs VALUES(7,'Synthetic Acme');
      CREATE TABLE application_details(application_id INTEGER,resume_artifact_json TEXT,authority_envelope_id TEXT);
      INSERT INTO application_details VALUES(1,'{"fileName":"resume.pdf","sha256":"identity"}',NULL);
      CREATE TABLE application_needs_you(application_id INTEGER,task_id INTEGER); INSERT INTO application_needs_you VALUES(1,2);
      CREATE TABLE needs_you(id INTEGER,kind TEXT,prompt TEXT,ask_reason_json TEXT,resolved_at INTEGER); INSERT INTO needs_you VALUES(2,'question','Certification?','{"reason":"missing fact"}',NULL);
      CREATE TABLE profile_settings(id INTEGER,ai_behavior_browser_permissions_sign_in INTEGER); INSERT INTO profile_settings VALUES(1,0);
      CREATE TABLE search_sources(source_id TEXT,url TEXT,cards INTEGER,related INTEGER,unrelated INTEGER,seen INTEGER,added INTEGER,failed_reads INTEGER,message TEXT);
      INSERT INTO search_sources VALUES('acme','https://acme.test',12,3,2,7,3,0,NULL);
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
        build: { head: "commit" },
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
    assert.equal(manifest.oursCount, 1);
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
    await generatePack({
      out: searchOut,
      trace,
      data,
      kind: "search",
      state: {},
    });
    const counts = JSON.parse(
      readFileSync(path.join(searchOut, "search.json"), "utf8"),
    ).perSource[0];
    assert.equal(counts.listingsRead, 12);
    assert.equal(counts.listingsAlreadySeen, 7);
    assert.equal(counts.listingsScreened, 5);
    assert.equal(generateRound(round), 2);
    assert.match(
      readFileSync(path.join(round, "round.md"), "utf8"),
      /01-greenhouse-acme.*needs_you/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
