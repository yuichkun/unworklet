export const meta = {
  name: "guidance-drift-audit",
  description:
    "unworklet の AI ガイド各 file の具体的主張を実装と直接照合する drift 監査 (1 file = 1 agent fan-out → dedup → 独立 skeptic verify)",
  phases: [
    { title: "Audit", detail: "guide file ごとに、主張を実装と突き合わせて drift を挙げる" },
    { title: "Verify", detail: "各 drift を独立 skeptic が REFUTE 試行で検証" },
  ],
};

// ── 事実 context のみ (「ガイドは正しい」を刷り込まない) ─────────────────────
const CONTEXT = `
You are auditing the **AI-facing guidance** of **unworklet** — a TypeScript library (a normal
npm package for the web platform: Web Audio + Web MIDI + WebAssembly) that compiles declarative
DSP, written in a \`.uwk.ts\` file, into a WebAssembly AudioWorklet at build time.

The guidance is what a developer or an LLM reads to USE the library (not the library's own
source). Your job: take each CONCRETE claim the guidance makes — API names, install/build
commands, required steps, described behavior, code examples — and check it against the ACTUAL
implementation. Report every claim that is WRONG (the code does something else), STALE (it
described an older behavior), or that OMITS a step a builder genuinely needs to get working.

Repository layout (read the ACTUAL source to verify — do not trust the guidance you are auditing):
- skills/unworklet/   — the guidance under audit (SKILL.md + dsl/setup/ide-and-typecheck/testing/devtools .md)
- llms.txt, README.md — more guidance under audit (a map for LLMs, and the user-facing readme)
- packages/core/src/      — createNode + main-thread node surface (client.ts), the declaration
  API (dsl/), the worklet audio thread (worklet.ts), compile/ (capture→emit via binaryen)
- packages/lang/src/      — the \`.uwk.ts\` sugar + lowering (lower.ts), the editor typescript-plugin,
  and the \`unworklet-tsc\` typecheck CLI (bin)
- packages/unplugin/src/  — the Vite plugin: build-time lowering/compile, the generated
  \`.unworklet/\` dir (tsconfig + worklets.d.ts seeding), the \`?worklet\` resolve, devtools wiring
- packages/offline/src/   — renderOffline (the deterministic node oracle for tests)
- packages/test/src/      — @unworklet/test: matchers (plain + chain via /extend), signal/MIDI utils

IMPORTANT — judge factual drift, not style. A different wording is not drift; a wrong API name,
a command that fails, a step that is required but missing, or an example that would not compile/run
IS drift. Do NOT assume "the guide differs from the code ⇒ the guide is wrong": sometimes the
guide is honest and the LIBRARY is the thing that should change (e.g. the type says \`number\` but a
fractional value is silently truncated = a "type ⟺ works" violation). When you suspect that, mark
kind="library-bug-suspect" and describe both sides. A maintainer triages each finding against the
product direction afterward.

Ground EVERY finding in the actual code with file:line, and quote the guidance location it
contradicts. No speculation — if you assert drift, you must have read both the guide text and the
code path. Read the files you assess in full so you judge in context.`;

const DRIFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "One-line summary of the drift" },
          guide_loc: {
            type: "string",
            description: "Where in the guidance, e.g. skills/unworklet/setup.md heading or quote",
          },
          claim: { type: "string", description: "What the guidance asserts (quote it)" },
          reality: {
            type: "string",
            description: "What the implementation actually does, with code file:line",
          },
          kind: {
            type: "string",
            enum: ["wrong", "missing", "library-bug-suspect", "by-design"],
            description:
              "wrong=guide states a falsehood; missing=guide omits a needed step; library-bug-suspect=guide is honest but the library may violate direction; by-design=likely just a learning-curve note",
          },
          severity: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "high=a builder following the guide gets stuck/broken; low=minor",
          },
        },
        required: ["title", "guide_loc", "claim", "reality", "kind", "severity"],
      },
    },
  },
  required: ["findings"],
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_real: {
      type: "boolean",
      description:
        "true only if you confirmed by reading BOTH the guide and the code that this drift holds",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    kind_adjusted: {
      type: "string",
      enum: ["wrong", "missing", "library-bug-suspect", "by-design", "not-drift"],
    },
    reasoning: {
      type: "string",
      description: "Why real or why refuted — cite the guide text and the code you read",
    },
  },
  required: ["is_real", "confidence", "kind_adjusted", "reasoning"],
};

// ── 1 target = 1 guide file。focus = どの実装と突き合わせるか ───────────────
const TARGETS = [
  {
    key: "SKILL.md",
    focus: `Audit skills/unworklet/SKILL.md. Verify: the overview claims; the "Mandatory workflow"
steps (install commands, the vite.config snippet importing @unworklet/unplugin, the tsconfig that
extends "./.unworklet/tsconfig.json", the package.json build script "unworklet-tsc --noEmit && vite
build", the 48 kHz createNode rate gate); the ".uwk.ts taste" fixture; and the sibling-file
pointers. Check against packages/unplugin/src/index.ts (plugin export, .unworklet seeding, ?worklet),
packages/core/src/client.ts (createNode + the rate gate), and packages/unplugin/__fixtures__/stereo-gain.uwk.ts.`,
  },
  {
    key: "dsl.md",
    focus: `Audit skills/unworklet/dsl.md. Verify every authoring form it shows: the .uwk.ts sugar
(operators, index read/assign, bare-state read, if/?:, $prev, auto-name, subgraphs) and the
underlying @unworklet/core declaration API (audioInput/audioOutput, param.*, state.*, state.buffer,
event/event.midi, forSample, defineSubgraph/instantiate, math ops), plus the .processor.ts
alternative. Check names/signatures/behavior against packages/lang/src/ (lower.ts + the sugar) and
packages/core/src/dsl/ (primitives, declarations, loop, constants). Flag any API the guide shows
that does not exist or has a different shape, and any behavior described that the lowering does not
actually produce.`,
  },
  {
    key: "setup.md",
    focus: `Audit skills/unworklet/setup.md. Verify: which @unworklet/* packages to install and as
which dep kind; the vite.config.ts; the generated .unworklet/ dir + tsconfig (what the plugin seeds
and when); file conventions; the ?worklet import; createNode; the UnworkletNode surface
(params/state/events/midi/inputs/outputs); the 48 kHz rate gate. Check against
packages/unplugin/src/index.ts (seedUnworkletDir, the generated tsconfig contents, ?worklet resolve)
and packages/core/src/client.ts (createNode + node surface + rate gate). Pay special attention to
the BUILD-ORDER cold-start: does the documented build/typecheck order actually work before the
plugin has seeded .unworklet/?`,
  },
  {
    key: "ide-and-typecheck.md",
    focus: `Audit skills/unworklet/ide-and-typecheck.md. Verify: the editor plugin
(@unworklet/lang/typescript-plugin) — its real name and how it is enabled; and the unworklet-tsc
drop-in typecheck CLI — its real bin name, how it is invoked, and exactly what it does (does it seed
.unworklet/ itself or rely on a prior vite build?). Check against packages/lang/ (the
typescript-plugin source, the unworklet-tsc bin/entry, and packages/lang/package.json "bin"). Flag
any wrong command, wrong plugin name, or a documented order that fails on a cold checkout.`,
  },
  {
    key: "testing.md",
    focus: `Audit skills/unworklet/testing.md. Verify: renderOffline (its import, signature, what it
returns — messages vs events vs PCM) and @unworklet/test (the plain matchers list, the chain form via
@unworklet/test/extend, signal generators, MIDI builders). Check against packages/offline/src/
(renderOffline) and packages/test/src/ (the actual exported matchers, extend, generators, builders).
Flag any matcher/util the guide names that does not exist, any wrong signature, and the vitest-version
typing caveat (does the chain matcher augmentation actually take effect under the installed vitest?).`,
  },
  {
    key: "devtools.md",
    focus: `Audit skills/unworklet/devtools.md. Verify: the Vite DevTools dock + panels; the pinned
@vitejs/devtools (and -kit) version; cross-origin isolation requirements; and the wiring the plugin
does. Check against packages/unplugin/src/ (the devtools define/integration) and
packages/core/src/client.ts (the devtools client gate). Flag a wrong version pin, a wrong package
name, or a setup step that does not actually surface the panel.`,
  },
  {
    key: "llms.txt+README.md",
    focus: `Audit llms.txt and README.md (repo root). For llms.txt: it is a MAP for general LLMs —
verify it points to skills/unworklet/ (NOT to docs/), and that its listed entries match the actual
guide file set. For README.md: verify the user-facing quick-start (install, the createNode example,
the 48 kHz context) actually compiles/runs against packages/core/src/client.ts and the fixture. Flag
any docs/ reference that should be gone, any stale example, and any example that would throw.`,
  },
];

const auditPrompt = (t) => `${CONTEXT}

YOUR AUDIT TARGET: ${t.key}
${t.focus}

Read the target guidance file(s) IN FULL and the implementation files needed to verify each claim.
Produce a list of concrete drift findings. Be thorough within your target. Only report drift you can
ground in both the guide text and the code (file:line) — quote the guide claim and cite the code. If,
after a genuine read, the guidance for your target is accurate and complete, return an empty findings
array rather than inventing weak findings.`;

const verifyPrompt = (f) => `${CONTEXT}

An auditor reported the following guidance-drift finding. ADVERSARIALLY VERIFY it: try to REFUTE it.
Read the actual guide text at the cited location AND the actual code, then decide whether the drift
is genuine or a false positive (the guide is actually correct, the auditor misread the code, the
behavior is configurable/handled elsewhere, or it is a deliberate by-design note). Default toward
skepticism: only is_real=true if you independently confirmed it by reading both sides. Re-classify
kind if the auditor mis-bucketed (especially: is this really a guide error, or is the guide honest
and the LIBRARY the thing at fault = library-bug-suspect?).

FINDING:
- title: ${f.title}
- guide_loc: ${f.guide_loc}
- claim: ${f.claim}
- reality: ${f.reality}
- kind(claimed): ${f.kind}
- severity(claimed): ${f.severity}
- target: ${f.target}`;

phase("Audit");
const audits = await parallel(
  TARGETS.map(
    (t) => () =>
      agent(auditPrompt(t), {
        label: `audit:${t.key}`,
        phase: "Audit",
        schema: DRIFT_SCHEMA,
        agentType: "general-purpose",
      }),
  ),
);

// Tag each finding with its target (index-aligned; BEFORE filtering nulls).
const allFindings = audits.flatMap((r, i) =>
  r && Array.isArray(r.findings) ? r.findings.map((f) => ({ ...f, target: TARGETS[i].key })) : [],
);

// Dedup (same guide_loc + title prefix → one verification).
const seen = new Set();
const deduped = [];
for (const f of allFindings) {
  const key = `${f.target}::${(f.guide_loc || "").slice(0, 40)}::${(f.title || "").toLowerCase().slice(0, 50)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(f);
}
log(
  `Audit: ${allFindings.length} drift findings across ${TARGETS.length} guide targets → ${deduped.length} after dedup`,
);

phase("Verify");
const verified = await parallel(
  deduped.map(
    (f) => () =>
      agent(verifyPrompt(f), {
        label: `verify:${f.target}`,
        phase: "Verify",
        schema: VERDICT_SCHEMA,
        agentType: "general-purpose",
      }).then((v) => ({ ...f, verdict: v })),
  ),
);

const checked = verified.filter(Boolean);
const confirmed = checked.filter((f) => f.verdict && f.verdict.is_real);
log(`Verify: ${confirmed.length} confirmed drift of ${checked.length} verified`);

// Sort confirmed by severity then kind for triage.
const sev = { high: 0, medium: 1, low: 2 };
confirmed.sort((a, b) => (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9));

return {
  totalFindings: allFindings.length,
  dedupedFindings: deduped.length,
  confirmedCount: confirmed.length,
  confirmed: confirmed.map((f) => ({
    title: f.title,
    target: f.target,
    guide_loc: f.guide_loc,
    claim: f.claim,
    reality: f.reality,
    kind: f.verdict.kind_adjusted,
    severity: f.severity,
    reasoning: f.verdict.reasoning,
  })),
  refuted: checked
    .filter((f) => !(f.verdict && f.verdict.is_real))
    .map((f) => ({
      title: f.title,
      target: f.target,
      reasoning: f.verdict ? f.verdict.reasoning : "no verdict",
    })),
};
