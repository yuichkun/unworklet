# Changelog

The five published packages — `@unworklet/core`, `@unworklet/lang`,
`@unworklet/offline`, `@unworklet/test`, `@unworklet/unplugin` — are versioned in
lockstep, so one entry covers all of them.

This project is pre-1.0: the minor is the breaking-change axis, matching npm's
`^0.1.0` range semantics (`^0.1.0` accepts `0.1.x` and refuses `0.2.0`).

## 0.2.0 — 2026-08-14

Adds `and` / `or` / `noiseSource`, headless multi-file `.uwk.ts` rendering, and a
one-command install for the agent guide. Type-level narrowing and a DevTools peer
bump make this a breaking release — read the migration notes before upgrading.

### Breaking

**DevTools panels now require `@vitejs/devtools` 0.4.x.** The `@vitejs/devtools-kit`
peer moved from the exact pin `0.3.3` to `^0.4.0`. The 0.3 line pinned to Vite 6/7,
so a consumer on Vite 8 could not install at all. Upgrade the whole DevTools stack
together — host, kit, and the four adapters — because the RPC scope prefix they
share changed with the underlying `devframe` major:

```
npm i -D @vitejs/devtools@^0.4 @vitejs/devtools-kit@^0.4 \
         @vitejs/devtools-vite@^0.4 @vitejs/devtools-rolldown@^0.4 \
         @vitejs/devtools-oxc@^0.4 @vitejs/devtools-vitest@^0.4
```

Mixing majors leaves every panel rendering empty rather than erroring, so check
the panel after upgrading. If you do not use the DevTools panel, the peer is
optional and nothing is required of you.

**`node.midi.<name>` is now narrowed by port direction.** It used to expose the
full surface regardless of direction, so a wrong-direction call type-checked and
then threw at runtime. Now an inbound port (`from: "main"`) offers `.send` /
`.connectFromWebMIDI` and an outbound port (`to: "main"`) offers `.onEvent`:

```ts
const arpOut = event.midi({ to: "main", name: "arpOut" });

node.midi.arpOut.send({ type: "noteOn", ... }); // 0.1.0: compiled, threw at runtime
                                                // 0.2.0: compile error
node.midi.arpOut.onEvent("noteOn", handler);    // the correct call for an out port
```

Code that already called the right method is unaffected.

**`node.events.<name>` payloads and `node.state.<name>` values are now typed.**
Both used to degrade to `unknown` even though the generated `?worklet` witness
carried the declared shape, which forced casts. They now recover the declared
types, so a cast that used to compile may now conflict, and a typo that used to
pass now fails:

```ts
const meter = event<{ peak: number }>({ to: "main", name: "meter" });

node.events.meter.on((p) => p.peak); // 0.1.0: unknown, needed a cast. 0.2.0: number
node.events.meter.on((p) => p.pk); // 0.1.0: compiled. 0.2.0: Property 'pk' does not exist
```

Remove the casts; fix what the new types reject.

**`unworklet-tsc` now type-checks against real processor types on a cold
checkout, so it can surface errors it previously hid.** It generates
`.unworklet/worklets.d.ts` itself at startup instead of waiting for a `vite build`
to write it. Before, a first run on a fresh clone fell back to the wildcard
`CompiledProcessor<unknown>` and silently passed genuine mistakes. A build that
passed on 0.1.0 can therefore fail on 0.2.0 — the errors were always real. Cold
runs now compile every `.uwk.ts` in your tsconfig, which costs a few hundred
milliseconds; warm runs are unchanged.

**Processors that declare an inbound `event` / `message` with payload fields get
a new `schemaHash`.** Inbound payload fields carry a per-field wire type now (see
Fixed), and the schema hash covers declarations, so it changes for those
processors only. Two consequences:

- Saved snapshot blobs still restore. The blob format is unchanged, and a blob
  whose hash no longer matches falls back to restoring slots by name, which is
  every slot — the changed declaration is not a snapshot slot.
- **A `migrations` chain anchored on the old hash stops running** for those
  processors, because no chain step reaches the new hash. Re-anchor the final
  `to` of your chain to the new `schemaHash` (read it from
  `CompiledProcessor.schemaHash`).

### Added

- **`and(a, b)` / `or(a, b)` boolean primitives**, plus `Node#and` / `Node#or`.
  In `.uwk.ts`, `&&` and `||` between two `Node<"bool">` lower to them. Both
  operands always evaluate — WASM has no branch-free short-circuit — so use
  `select(cond, a, b)` when you need guarding.
- **`noiseSource({ seed })`** — an xorshift32 PRNG declaration primitive; call
  `.next()` per sample. Wired into the `.uwk.ts` ambient surface.
- **`loadUwkProcessor(path)` in `@unworklet/lang`** — loads a `.uwk.ts` and its
  sibling `.uwk.ts` subgraph imports to a `CompiledProcessor`, so `renderOffline`
  can render a multi-file processor with no bundler.
- **The agent guide installs with one command**, giving an agent the DSL reference,
  setup, type-checking, testing, and DevTools docs. It detects the coding agents you
  have — Claude Code, Codex, Cursor, opencode, Zed, Copilot and others — and installs
  for each:

  ```sh
  npx skills add https://github.com/yuichkun/unworklet/tree/main/skills/unworklet
  ```

- **`unworklet-tsc` self-seeds `.unworklet/tsconfig.json`**, so a cold clone whose
  tsconfig `extends` it no longer fails with TS5083 before anything has run.
- `@unworklet/lang` additionally exports `seedUnworkletDir`, `GENERATED_TSCONFIG`,
  `isUwkSource`, `lowerUwkSource`, `materializeLowered`, `deriveExportName`,
  `workletDts`, and `workletsDts` for tooling built on top of it.

### Fixed

- **Fractional numbers sent from the main thread no longer truncate to zero.**
  An inbound `event` / `message` payload field rode a uniform i32 wire, so
  `emit({ gain: 0.8 })` arrived as `0`; boolean fields only worked by accident.
  The wire type is now decided per field — `number` defaults to f32 and keeps its
  fraction, `boolean` seals to bool when consumed in a boolean position.
- **`@unworklet/test`'s chain matchers now attach for vitest 4 consumers**
  (`@vitest/expect` added as a required peer — the matchers cannot register
  without it, so a missing install surfaces as an install error rather than a
  silently absent `toRenderSilence`).
- **DevTools panels render again after the 0.4 upgrade** — the page bridge used
  the pre-0.4 anonymous-RPC prefix and the panel bundle was still built against
  the 0.3 kit, so an authenticated session showed empty panels.
- **DevTools no longer hangs `vitest` for 10 seconds** — the plugin's DevTools
  host is gated off under `VITEST`.
- **`unworklet-tsc` reports the right line and column.** Diagnostics were
  resolved against the virtual module's text, so every error landed a few lines
  above its real position.
- `.uwk.ts` bare-state auto-read now fires in three more positions it missed: a
  buffer index synthesized by `if` sugar, an object-literal shorthand in an
  `emit` payload (`{ peak }`), and a property-name position that previously
  crashed the pass.
- Subgraph types resolve across sibling `.uwk.ts` files.
- Passing a `Param` where a `Node` is expected now fails at graph capture with a
  message naming `Param` and the `param[i]` fix, instead of a misleading `i64`
  overload error.
- `unwrapAst` reports an actionable message for `undefined` / `null` / non-object
  input instead of a bare property access failure.
- The generated tsconfig seeds `module` / `moduleResolution`, so the ambient
  authoring identifiers keep their types in a consumer project.
- The demo handles generator-style processors that declare no audio input.

### Docs

The agent-facing guide (`skills/unworklet/`) was rewritten around `.uwk.ts` as the
primary authoring form and then corrected across five rounds of building real
projects from the guide alone — API names, commands, setup order, and every code
sample now match the implementation.

The design-time specification that drove the v1.0.0 build was deleted, along with
`llms.txt`. Both restated behaviour that `skills/unworklet/` describes, without
being verified against it, and both had drifted. `docs/` now holds history only:
the decisions log and the RFCs. Recover the deleted chapters from git history at
the `v0.1.0` tag if you need them.

## 0.1.0 — 2026-06-28

First public release of the five packages.
