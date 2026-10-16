import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Fresh processes matter: React DOM caches supportsUserTiming at module load.
// Evaluate the actual renderer entry and timing modules as an ES-module graph;
// replace only app/theme/style dependencies, then render with installed React DOM
// in jsdom. This neither builds nor launches the desktop app.
const probe = String.raw`
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const entryPath = process.argv[1];
const keepTracks = process.argv[2] === '1';
const require = createRequire(entryPath);
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
console.timeStamp = () => {};
const originalMeasure = performance.measure.bind(performance);
const details = [];
Object.defineProperty(performance, 'measure', { configurable: true, value: (...args) => {
  const result = originalMeasure(...args);
  if (result.detail?.devtools) details.push(result.detail);
  return result;
}});
const loaded = new Map();
let root;
let hadTimeStampAtReactDomLoad;
function Probe({ rows }) { return require('react').createElement('div', null, rows.length); }
function synthetic(id, exports, evaluate) {
  const module = new vm.SyntheticModule(exports, function () {
    const values = evaluate();
    for (const name of exports) this.setExport(name, values[name]);
  }, { identifier: id });
  loaded.set(id, module);
  return module;
}
function source(filename) {
  const cached = loaded.get(filename);
  if (cached) return cached;
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSXDev
  }, fileName: filename }).outputText;
  const module = new vm.SourceTextModule(output, {
    identifier: filename,
    initializeImportMeta(meta) { meta.env = { VITE_NORDRI_REACT_PERFORMANCE_TRACKS: keepTracks ? '1' : undefined }; }
  });
  loaded.set(filename, module);
  return module;
}
const entry = source(entryPath);
await entry.link((specifier, parent) => {
  const cached = loaded.get(specifier);
  if (cached) return cached;
  if (specifier.includes('react-dev-timing')) {
    return source(path.resolve(path.dirname(parent.identifier), specifier + '.ts'));
  }
  if (specifier === 'react') return synthetic(specifier, ['default'], () => ({ default: require('react') }));
  if (specifier === 'react/jsx-dev-runtime') return synthetic(specifier, ['jsxDEV'], () => require(specifier));
  if (specifier === 'react-dom/client') return synthetic(specifier, ['default'], () => {
    hadTimeStampAtReactDomLoad = typeof console.timeStamp === 'function';
    const client = require(specifier);
    return { default: { ...client, createRoot(element) { root = client.createRoot(element); return root; } } };
  });
  if (specifier.includes('app/app')) return synthetic(specifier, ['App'], () => ({ App: () => require('react').createElement(Probe, { rows: [] }) }));
  if (specifier.includes('legacy-storage')) return synthetic(specifier, ['migrateLegacyStorageKeys'], () => ({ migrateLegacyStorageKeys() {} }));
  if (specifier.includes('lib/theme')) return synthetic(specifier, ['applyAppearancePreference', 'getSystemPrefersDark', 'readStoredAppearanceTheme'], () => ({
    applyAppearancePreference() {}, getSystemPrefersDark() { return false; }, readStoredAppearanceTheme() { return null; }
  }));
  if (specifier.endsWith('.css')) return synthetic(specifier, [], () => ({}));
  throw new Error('Unrecognized renderer dependency: ' + specifier);
});
await entry.evaluate();
const React = require('react');
const { flushSync } = require('react-dom');
for (let pass = 0; pass < 8; pass++) {
  const rows = Array.from({ length: 3000 }, (_, index) => ({ id: 'job_' + index, title: 'Synthetic role ' + pass }));
  flushSync(() => root.render(React.createElement(Probe, { rows })));
}
flushSync(() => root.unmount());
process.stdout.write(JSON.stringify({ hadTimeStampAtReactDomLoad, measures: details.length, detailBytes: JSON.stringify(details).length, reactVersion: React.version }));
dom.window.close();
`;

type ProbeResult = {
  hadTimeStampAtReactDomLoad: boolean;
  measures: number;
  detailBytes: number;
  reactVersion: string;
};

function loadRenderer(keepTracks: boolean): ProbeResult {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-vm-modules",
      "--input-type=module",
      "-e",
      probe,
      fileURLToPath(new URL("../main.tsx", import.meta.url)),
      keepTracks ? "1" : "0",
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, NODE_ENV: "development" },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ProbeResult;
}

describe("React timing bootstrap with actual module loading", () => {
  it("disables the installed development React DOM's prop timing on the real entry's import path", () => {
    const result = loadRenderer(false);
    expect(result.hadTimeStampAtReactDomLoad).toBe(false);
    expect(result.measures).toBe(0);
    console.info("react-timing-bootstrap-disabled", result);
  });

  it("records prop details with profiling opted in, so the probe can detect retention", () => {
    const result = loadRenderer(true);
    expect(result.hadTimeStampAtReactDomLoad).toBe(true);
    expect(result.measures).toBeGreaterThan(0);
    expect(result.detailBytes).toBeGreaterThan(10_000);
    console.info("react-timing-bootstrap-profiling", result);
  });
});
