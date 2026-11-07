import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

test("808 exact reads of a 9.7 MB observation and their trace records fit in a 128 MB heap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nestor-context-memory-"));
  try {
    for (const name of [
      "context-parts",
      "context-history",
      "context-archive",
    ]) {
      const source = readFileSync(
        new URL(`./${name}.ts`, import.meta.url),
        "utf8",
      ).replace(
        /from "\.\/(context-history|context-archive)"/gu,
        'from "./$1.mjs"',
      );
      writeFileSync(
        path.join(dir, `${name}.mjs`),
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      );
    }
    const script = String.raw`
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { createContextParts } from './context-parts.mjs';
      import { traceSafe } from ${JSON.stringify(new URL("../../core/src/trace-redaction.mjs", import.meta.url).href)};
      const parts = createContextParts();
      const input = 'Visible board facts 🦉 中文\n'.repeat(400000) + 'FINAL LISTING FACT';
      const messages = [{role:'system',content:'Read the original input; history is available if needed.'}, {role:'user',content:input}];
      const first = parts.prepare(messages, 48000)[1].content;
      const id = /parts: ([^;]+);/.exec(first)[1];
      const hash = createHash('sha256').update(first.slice(first.indexOf('\n')+1));
      let offset = Number(/characters 0\.\.(\d+)/.exec(first)[1]);
      let reads = 0;
      let peak = 0;
      let initialArchive;
      while(offset !== null) {
        const call = {id:'read-'+reads,type:'function',function:{name:'read_context_part',arguments:JSON.stringify({id,offset})}};
        const outcome = await parts.tool.execute(call.function.arguments,{step:reads});
        const page = JSON.parse(outcome.content);
        assert.equal(page.offset,offset);
        hash.update(page.text);
        offset = page.nextOffset;
        messages.push({role:'assistant',content:'',toolCalls:[call]}, {role:'tool',toolCallId:call.id,content:outcome.content});
        const request = parts.prepare(messages,48000);
        assert.match(request[1].content,new RegExp('parts: '+id+';'));
        const history = request.find(m=>m.content.startsWith('Earlier action history'));
        if(history && !initialArchive) initialArchive = /parts: ([^;]+);/.exec(history.content)[1];
        // Exercise the same redaction/serialization path as provider traces.
        JSON.stringify(traceSafe({event:'provider_request',request:{messages:request}}));
        reads++;
        if(reads % 50 === 0) { global.gc(); peak=Math.max(peak,process.memoryUsage().heapUsed); }
      }
      assert.equal(hash.digest('hex'),createHash('sha256').update(input).digest('hex'));
      assert.ok(reads >= 808,reads);
      // A saved historical snapshot remains exact after hundreds of later reads.
      const old = JSON.parse((await parts.tool.execute(JSON.stringify({id:initialArchive,offset:0}),{step:reads})).content);
      assert.ok(old.text.startsWith('[{"role":"assistant"'));
      assert.ok(!old.text.includes('"role":"user"'));
      assert.ok(peak < 100*1024*1024,peak);
      console.log(JSON.stringify({reads,inputChars:input.length,peakHeapBytes:peak}));
    `;
    const scriptPath = path.join(dir, "read.mjs");
    writeFileSync(scriptPath, script);
    const output = execFileSync(
      process.execPath,
      ["--expose-gc", "--max-old-space-size=128", scriptPath],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const result = JSON.parse(output.trim()) as {
      reads: number;
      inputChars: number;
      peakHeapBytes: number;
    };
    expect(result.reads).toBeGreaterThanOrEqual(808);
    expect(result.inputChars).toBeGreaterThan(9_400_000);
    console.info("Exact context memory regression", result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 65_000);
