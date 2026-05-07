// audit.ts — structural + coverage assertions for the patcher.
//
// Runs against a live dev server (so registry types come from the actual
// runtime Map, not regex-scraped). Also reads source files directly to
// confirm structural promises (Monaco import, MIDI wiring, etc.).
//
// Usage:
//   1. Make sure the dev server is up: `npm --prefix apps/patcher run dev`
//   2. node --experimental-strip-types apps/patcher/scripts/audit.ts [base-url]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const SRC = path.join(ROOT, "src");
const REGISTRY = path.join(SRC, "registry");
const COMPONENTS = path.join(SRC, "components", "nodes");
const EXAMPLES = path.join(SRC, "examples");
const BASE = process.argv[2] ?? "http://127.0.0.1:5174";

type Issue = { sev: "FATAL" | "ERROR" | "WARN" | "INFO"; msg: string };
const issues: Issue[] = [];
function fatal(m: string) { issues.push({ sev: "FATAL", msg: m }); }
function err(m: string) { issues.push({ sev: "ERROR", msg: m }); }
function warn(m: string) { issues.push({ sev: "WARN", msg: m }); }
function info(m: string) { issues.push({ sev: "INFO", msg: m }); }

// ─── Load the actual runtime registry from the dev server ─────────────────
async function loadRegistry(): Promise<{
  types: string[];
  meta: Record<string, { hasComponent: string | null; emptyBuild: boolean; hasParamSpecs: boolean; hasParamSpec: boolean; hasMidiSpec: boolean; ioSpec: any; outletCount: number; inletCount: number; category: string }>;
}> {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(BASE + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("select.example-picker"));
  const data = await page.evaluate(async () => {
    const m = await import("/src/registry/index.ts");
    const reg = (m as any).registry;
    const types = Object.keys(reg);
    const meta: Record<string, any> = {};
    for (const t of types) {
      const def = reg[t];
      meta[t] = {
        hasComponent: def.component ?? null,
        // We can't see if build is `() => []` from the runtime in general,
        // but we can detect param-emitter / io nodes (which the compiler
        // bypasses) so the audit can apply allow-lists correctly.
        emptyBuild: typeof def.build === "function" && def.build.length === 0 && (def.build.toString().replace(/\s/g, "").endsWith("=>[]") || def.build.toString().replace(/\s/g, "").endsWith("()=>[]")),
        hasParamSpecs: Array.isArray(def.paramSpecs) && def.paramSpecs.length > 0,
        hasParamSpec: !!def.paramSpec,
        hasMidiSpec: !!def.midiSpec,
        ioSpec: def.ioSpec ?? null,
        outletCount: def.outlets?.length ?? 0,
        inletCount: def.inlets?.length ?? 0,
        category: def.category,
      };
    }
    return { types, meta };
  });
  await browser.close();
  return data;
}

const { types: regTypes, meta } = await loadRegistry();
const registered = new Set(regTypes);
console.log(`Registry: ${registered.size} types loaded from runtime`);

// ─── Examples (recursive over subpatches) ──────────────────────────────────
function readAllExamples(): { byFile: Map<string, Set<string>>; total: Set<string> } {
  const byFile = new Map<string, Set<string>>();
  const total = new Set<string>();
  for (const f of fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(fs.readFileSync(path.join(EXAMPLES, f), "utf8"));
    const used = new Set<string>();
    function walk(p: any) {
      if (!p?.nodes) return;
      for (const n of p.nodes) {
        if (typeof n.type === "string") {
          used.add(n.type);
          total.add(n.type);
        }
        const inner = n.attrs?.patch;
        if (inner) walk(inner);
      }
    }
    walk(data.patch ?? data);
    byFile.set(f, used);
  }
  return { byFile, total };
}

const { byFile, total: used } = readAllExamples();
console.log(`Examples: ${byFile.size} patches, ${used.size} unique types referenced`);

// ─── 1. Coverage: every registry type must appear in ≥1 example ─────────────
const uncovered = [...registered].filter((t) => !used.has(t)).sort();
console.log(`Uncovered: ${uncovered.length}/${registered.size}`);
if (uncovered.length > 0) {
  for (const t of uncovered) warn(`uncovered registry type: ${t}`);
}

// ─── 2. Empty build: source-side scan for `build: () => []` outside an allow-list.
// We pair the runtime probe (def.build.toString) with a literal source scan,
// because either alone is bypassable: the runtime probe could be defeated by
// adding a no-op statement to the function body that still returns []; the
// source scan can miss minified / formatted variants. Together they catch
// the realistic shortcut shapes.
const ALLOW_NOOP = new Set([
  // structural
  "comment", "inlet", "outlet", "patcher",
  // UI param-emitters (compiler special-cases via paramSpec/paramSpecs)
  "slider", "vslider", "dial", "live.dial", "live.slider", "number-box",
  "flonum", "button", "toggle", "kslider", "multislider", "umenu",
  // MIDI inputs (paramSpec-driven)
  "notein", "ctlin", "pitchbend", "midiin",
  // IO (compiler special-cases via ioSpec)
  "adc~", "dac~",
]);
const allRegSrc = fs.readdirSync(REGISTRY).filter(f => f.endsWith(".ts"))
  .map(f => fs.readFileSync(path.join(REGISTRY, f), "utf8"))
  .join("\n");
for (const t of registered) {
  const m = meta[t]!;
  if (!m.emptyBuild) continue;
  if (ALLOW_NOOP.has(t)) continue;
  if (m.hasParamSpec || m.hasParamSpecs || m.ioSpec) continue;
  if (m.category === "structural") continue;
  err(`node "${t}" has empty build (runtime probe) but is not a recognised special type (cat=${m.category})`);
}
// Source-side: catch literal `build: () => []` lines that don't sit next to
// an allow-listed type declaration.
const buildEmptyRe = /type:\s*"([^"]+)"[\s\S]{0,800}?build:\s*\(\s*\)\s*=>\s*\[\s*\]/g;
for (const m of allRegSrc.matchAll(buildEmptyRe)) {
  const t = m[1]!;
  if (ALLOW_NOOP.has(t)) continue;
  // Re-check if this type has paramSpec/paramSpecs/ioSpec/midiSpec via the runtime meta.
  const rt = meta[t];
  if (rt && (rt.hasParamSpec || rt.hasParamSpecs || rt.ioSpec)) continue;
  err(`source scan: node "${t}" declares build: () => [] without paramSpec/ioSpec/allow-list`);
}

// ─── 3. Components: every node with `component:` resolves to a real .vue ────
const componentFiles = new Set(
  fs.readdirSync(COMPONENTS).filter((f) => f.endsWith(".vue")).map((f) => f.replace(/\.vue$/, "")),
);
const componentDecls = new Set<string>();
for (const t of registered) {
  const c = meta[t]?.hasComponent;
  if (c) componentDecls.add(c);
}
for (const c of componentDecls) {
  if (!componentFiles.has(c)) {
    fatal(`component "${c}" referenced by registry but no file at components/nodes/${c}.vue`);
  }
}

// ─── 4. Components must NOT be < 200 chars (= stub) ────────────────────────
for (const c of componentDecls) {
  const file = path.join(COMPONENTS, `${c}.vue`);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, "utf8");
  if (c === "AudioNodeView") continue;
  if (src.length < 200) err(`component "${c}" looks like a stub (file < 200 chars)`);
}

// ─── 5. gen~ component imports monaco-editor ───────────────────────────────
const genFile = path.join(COMPONENTS, "GenView.vue");
if (fs.existsSync(genFile)) {
  const src = fs.readFileSync(genFile, "utf8");
  if (!/monaco-editor/.test(src)) {
    fatal(`GenView.vue does NOT import monaco-editor — gen~ is still a textarea?`);
  }
} else {
  fatal("GenView.vue missing");
}

// ─── 6. AudioRuntime: Web MIDI + mic + setParam ────────────────────────────
const runtimeFile = path.join(SRC, "runtime", "AudioRuntime.ts");
const runtimeSrc = fs.readFileSync(runtimeFile, "utf8");
if (!/requestMIDIAccess/.test(runtimeSrc)) fatal("AudioRuntime: no requestMIDIAccess()");
if (!/onmidimessage/.test(runtimeSrc)) fatal("AudioRuntime: no onmidimessage handler");
if (!/setParam/.test(runtimeSrc)) fatal("AudioRuntime: no setParam method");
if (!/midiOutputs/.test(runtimeSrc)) fatal("AudioRuntime: no MIDIOutput forwarding");
if (!/ensureMidi/.test(runtimeSrc)) fatal("AudioRuntime: no ensureMidi() method");
if (!/ensureMic/.test(runtimeSrc)) fatal("AudioRuntime: no ensureMic() method");

// ─── 7. App.vue exposes Mic + MIDI buttons + breadcrumb + descend ──────────
const appFile = path.join(SRC, "App.vue");
const appSrc = fs.readFileSync(appFile, "utf8");
if (!/enableMic/.test(appSrc)) err("App.vue: no enableMic toolbar action");
if (!/enableMidi/.test(appSrc)) err("App.vue: no enableMidi toolbar action");
if (!/patchStack/.test(appSrc)) err("App.vue: no subpatch breadcrumb stack");
if (!/descend/.test(appSrc)) err("App.vue: no descend handler for patcher subpatch");

// ─── 8. tapin~/tapout~ share via attrs.bus + ctx.shared ────────────────────
const delaysFile = path.join(REGISTRY, "audio-delays.ts");
const delaysSrc = fs.readFileSync(delaysFile, "utf8");
if (!/ctx\.shared\(/.test(delaysSrc)) {
  fatal("tapin~/tapout~ do NOT use ctx.shared — buffer is not actually shared");
}
if (!/attrs\.bus/.test(delaysSrc)) {
  fatal("tapin~/tapout~ do NOT key shared bus by attrs.bus");
}

// ─── 9. compile.ts handles paramSpecs[], MIDI, feedback breaks ─────────────
const compileFile = path.join(SRC, "compiler", "compile.ts");
const compileSrc = fs.readFileSync(compileFile, "utf8");
if (!/paramSpecs/.test(compileSrc)) fatal("compile.ts: no paramSpecs[] support");
if (!/midiInputs/.test(compileSrc)) fatal("compile.ts: no midiInputs route collection");
if (!/midiOutputs/.test(compileSrc)) fatal("compile.ts: no midiOutputs route collection");
if (!/feedbackBreaks/.test(compileSrc)) fatal("compile.ts: no feedback break detection");

// ─── 10. PatcherView has a double-click descent handler ────────────────────
const patcherFile = path.join(COMPONENTS, "PatcherView.vue");
const patcherSrc = fs.readFileSync(patcherFile, "utf8");
if (!/dblclick/.test(patcherSrc) || !/onDescend/.test(patcherSrc)) {
  fatal("PatcherView.vue does NOT implement double-click → descend");
}

// ─── 11. Scope/Meter/Spectroscope/Number subscribe to runtime state ────────
for (const view of ["ScopeView", "MeterView", "SpectroscopeView", "NumberView"]) {
  const f = path.join(COMPONENTS, `${view}.vue`);
  if (!fs.existsSync(f)) {
    fatal(`${view}.vue missing`);
    continue;
  }
  const src = fs.readFileSync(f, "utf8");
  if (!/runtime/.test(src) || !/subscribe/.test(src)) {
    err(`${view}.vue does not subscribe to runtime state`);
  }
}

// ─── coverage matrix file ─────────────────────────────────────────────────
const matrix: Record<string, string[]> = {};
for (const t of [...registered].sort()) {
  matrix[t] = [];
  for (const [file, set] of byFile) if (set.has(t)) matrix[t]!.push(file);
}
const matrixPath = path.join(ROOT, "scripts", "coverage-matrix.json");
fs.writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
console.log(`Coverage matrix → ${matrixPath}`);

// ─── report + exit ────────────────────────────────────────────────────────
issues.sort((a, b) => {
  const order = { FATAL: 0, ERROR: 1, WARN: 2, INFO: 3 };
  return order[a.sev] - order[b.sev];
});
console.log("\n=== AUDIT REPORT ===");
const fatals = issues.filter((i) => i.sev === "FATAL").length;
const errors = issues.filter((i) => i.sev === "ERROR").length;
const warns = issues.filter((i) => i.sev === "WARN").length;
console.log(`Fatals: ${fatals}, Errors: ${errors}, Warnings: ${warns}`);
for (const i of issues) {
  console.log(`  [${i.sev}] ${i.msg}`);
}

if (fatals > 0) {
  console.error("\nAUDIT FAILED — fatal issues present.");
  process.exit(2);
}
if (errors > 0) {
  console.error("\nAUDIT FAILED — errors present.");
  process.exit(1);
}
console.log("\nAUDIT PASSED.");
