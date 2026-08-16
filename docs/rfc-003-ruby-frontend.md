# RFC 003 — `@unworklet/ruby` experimental Ruby authoring frontend

An **experimental, separately-versioned, downstream library** that provides a Ruby DSL on top of `@unworklet/core`'s public API. The library lives outside the main `unworklet` repo (= different npm package, different release cadence, different audience contract); it imports `@unworklet/core` and produces standard `CompiledProcessor<C>` values via the same `compile()` pipeline that Tier A / B / C `.ts` consumers use. No changes to `@unworklet/core`. No changes to the v1.0.0 spec.

## Status

**Draft — not implemented.** No Ruby frontend exists, so this file proposes rather
than describes. The `.uwk.ts` frontend it waits on (RFC-001) has since shipped.
Citations to numbered spec chapters point at design-time documents that were deleted
once the implementation shipped; recover them from git history at the `v0.1.0` tag
if you need them.

Author: AI agent draft on branch `claude/dsl-syntax-compiler-design-wGngh`, awaiting human reviewer grilling.

> **Surface note.** Where this draft shows `message<T>` / `midiInput` / `midiOutput`,
> the ratified core uses the unified **event family** (`event<T>({ from | to: "main" })`
> and `event.midi`, see `decisions-log.md` Q87 / Q88). Current surface: `01-dsl.md`.

## Summary

Ruby has 3 properties that make it a strong DSL host for audio:

1. **Operator overloading is native** — `+ - * /` defined as methods on the `Node` class, no source-level transform required.
2. **Block syntax `do |x| ... end` + postfix `if` + symbol literals + range literals + optional parens** — the syntactic affordances accumulate into roughly 2-3x density gain over TypeScript for the same expression.
3. **A 15-year tradition of internal DSLs** — Sinatra / RSpec / Rake / Rails routing / Sonic Pi all proved the pattern works at scale.

This RFC proposes a **separate experimental library** (working name: `@unworklet/ruby`, alternative `unworklet-rb`) that:

1. Provides a Ruby DSL for unworklet processors authored in `.uwk.rb` files.
2. Lives in **its own repository** (= not in the main `unworklet/unworklet` repo), under its own release cadence, governance, and audience contract.
3. Imports `@unworklet/core` as a regular npm dependency. Calls only the **public API** (= `defineProcessor`, `audioInput`, `state`, `param`, `compile`, etc. — the same surface RFC-001's `.uwk.ts` produces).
4. Uses **Opal** (Ruby-to-JavaScript compiler) for build-time transpilation. The output is standard JavaScript that drives `@unworklet/core`'s existing pipeline. No bespoke compile path.
5. Optionally provides a **Ruby.wasm-based REPL** for live coding (= future scope, deferred until library proves its audience).

The library is **experimental by design**: failure to find an audience means deprecating the library, not retracting any spec. Success means a stable downstream that can graduate to a sibling-official path later.

## Why a separate experimental library — not in main repo

This is the architectural core of this RFC.

### What lives in main repo (= `unworklet/unworklet`)

- The v1.0.0 spec (`docs/`)
- `@unworklet/core` — WASM emission, runtime, public DSL surface
- `@unworklet/unplugin` — build pipeline integration
- `@unworklet/offline` — headless render
- `@unworklet/test` — test matchers
- `@unworklet/lang` (proposed in RFC-001) — `.uwk.ts` AST rewriting + TS LSP plugin
- AGENTS.md hard contracts (= canonical examples integrity, TDD policy, branches coverage, etc.)

These collectively form the **TypeScript-first contract**: a stable, type-safe, npm-native, IDE-native audio DSL with realtime-safety guarantees.

### What `@unworklet/ruby` would bring in

If it lived in the main repo:

- Opal toolchain dependency (~1 MB minified runtime + compiler)
- Or Ruby.wasm dependency (~3-5 MB compressed CRuby)
- Ruby community / gem ecosystem expectations
- snake_case vs camelCase reconciliation across language boundaries
- Sorbet (optional Ruby type checker) integration questions
- Sonic Pi user expectations (= live coding REPL, pattern primitives, scale theory helpers — none of which are in unworklet's scope)
- ruby-lsp / Solargraph integration (= editor plugin space)
- Ruby gem vs npm distribution tension
- Idiomatic Ruby vs idiomatic JS / TS naming clashes
- Different cadence (= Ruby ecosystem releases on different schedules than npm)

None of these belong inside the realtime-safety contract that `@unworklet/core` provides. They're **adjacent**, not central.

### Concrete benefits of separation

1. **Focus.** `@unworklet/core` stays a TypeScript-first WASM-emitting framework. The "what does this project do?" answer stays simple.

2. **Bundle isolation.** Consumers who don't use Ruby never pay for Opal in their build pipeline. Consumers who do use Ruby get a heavier build but isolated to their own dependency tree.

3. **Audience clarity.** Sonic Pi users have different expectations than VST / Web Audio plugin developers. Treating them as a separate downstream lets each audience get what they want without compromise.

4. **Experimental cadence.** RFC-001 (Tier B/C) commits to the v1.0.0 surface for the long haul; the AGENTS.md integrity rule binds it. An experimental Ruby library can iterate freely — break syntax, change conventions, retire features — without spec retract.

5. **Failure mode bounded.** If Ruby uptake is small, `@unworklet/ruby` can be archived without affecting `@unworklet/core` users. The library being "experimental" is itself the contract: no long-tail support guarantee.

6. **Public API as discipline.** The library can only access what `@unworklet/core` exposes publicly. This forces clarity on what is and isn't public API. Any deficiency (= the Ruby layer needs something `@unworklet/core` doesn't expose) becomes a feature request, properly grilled and ratified before adding.

7. **Versioning independence.** `@unworklet/ruby` can pin to `@unworklet/core@^1.1.0` and ship at its own pace. Breaking changes in either project are contained at the npm boundary.

8. **Repo governance.** The main `unworklet/unworklet` repo's review process (= AGENTS.md, spec integrity rule, TDD gate) doesn't have to accommodate Ruby-specific concerns. The experimental library can have its own lighter process.

### Concrete risks of separation

1. **Discovery friction.** Users searching for "unworklet Ruby" might not find the separate library. Mitigation: link prominently from main README, npm keyword tagging, mention in v1.x.0 release notes.

2. **Version drift.** The experimental library might lag behind `@unworklet/core` releases. Mitigation: pin to minimum version, document compatibility matrix.

3. **Cross-repo bug reports.** Users might file Ruby DSL bugs against the main repo. Mitigation: explicit issue template + redirect.

4. **Shared concerns split poorly.** Some features (e.g., source map propagation across the Ruby → JS boundary) need cooperation from `@unworklet/core`. Mitigation: open structured feature requests; if `@unworklet/core` API needs to grow, do it through the normal ratify process.

5. **Author bandwidth.** Two repos = double the maintenance burden. Mitigation: explicitly scope as "experimental", lower SLA, smaller audience.

### Decision

**Separate library.** The risks are all manageable; the benefits compound long-term. Main repo stays TypeScript-first; the Ruby experiment lives as a sibling.

## Goals

1. **Public-API-only contract.** `@unworklet/ruby` uses only `@unworklet/core`'s published exports (= `defineProcessor`, `audioInput`, `state`, etc.). No internal access, no private imports, no monkey-patching.
2. **Same WASM output.** A `.uwk.rb` file produces a `CompiledProcessor<C>` indistinguishable from an equivalent `.ts` / `.uwk.ts` file. WASM is bit-exact regardless of source language.
3. **Idiomatic Ruby DSL.** snake_case, symbols, blocks, postfix `if`, operator overloading — all native Ruby. Author doesn't feel like they're writing "Ruby-flavored TypeScript".
4. **Build-time transpilation primary.** Opal compiles `.uwk.rb` to standard `@unworklet/core`-using JavaScript at build time. No Ruby runtime in shipped browser bundles.
5. **Live coding optional.** Ruby.wasm REPL is a future enhancement, not a v0.1 deliverable.
6. **Sonic Pi audience overlap.** Conventions chosen to feel familiar to Sonic Pi authors when possible (= block-based, symbol-keyed, postfix conditionals).
7. **TypeScript interop at the npm boundary.** `.uwk.rb` consumes `@unworklet/core` types. Library types published as `.d.ts`. TypeScript consumers can `import` from `@unworklet/ruby` if they need type-checked Ruby-DSL helpers (= rare).

## Non-Goals

1. **Not a replacement for Tier A/B/C.** Tier A/B/C remain the primary supported authoring path. Ruby is a sibling.
2. **Not in the main repo.** Lives separately, documented as experimental.
3. **Not part of the v1.0.0 / v1.1.0 ship surface.** Independent versioning from `@unworklet/core`.
4. **Not a music-making framework.** Same non-goals as unworklet itself (`00-foundations.md` §2). No sequencer, no pattern language, no scale theory helpers. Those live in user-land or in additional libraries.
5. **Not a Sonic Pi clone.** The DSL is for unworklet processor authoring; the audience overlap with Sonic Pi is opportunistic, not directive.
6. **Not a typed Ruby.** Sorbet integration is out of scope for v0.1. Users wanting type safety stay on Tier A/B/C.

## Package architecture

### Repo layout

```
github.com/yuichkun/unworklet-rb              # separate repo (= proposed naming)
├── README.md
├── LICENSE                                   # MIT, same as main
├── package.json                              # npm package = `@unworklet/ruby`
├── docs/
│   ├── design.md
│   ├── ruby-conventions.md
│   ├── opal-build.md
│   └── examples.md
├── lib/                                      # Ruby source
│   ├── unworklet.rb                          # main DSL entry
│   ├── unworklet/
│   │   ├── processor.rb                      # processor DSL
│   │   ├── node.rb                           # Node class with operator overloads
│   │   ├── declarations.rb                   # state / buffer / param / I/O helpers
│   │   ├── unit.rb                           # stateful function DSL
│   │   └── primitives.rb                     # sin / cos / exp / etc.
├── src/                                      # JS-side bridge
│   ├── vite-plugin.ts                        # Vite plugin entry
│   ├── compile.ts                            # Opal invocation wrapper
│   └── runtime.ts                            # JS bridge for Ruby DSL methods
├── examples/
│   ├── stereo-gain.uwk.rb
│   ├── three-band-eq.uwk.rb
│   └── ...
└── tests/
    ├── canonical/                            # Ports of unworklet canonical Ex 1-10
    └── ...
```

### Dependency graph

```
@unworklet/ruby (this library)
├── @unworklet/core         (= peer / regular dep, ^x.y.z)
├── @unworklet/unplugin  (= optional peer for build integration)
├── opal-compiler           (= Ruby-to-JS compiler, ~1 MB)
└── @opal/runtime           (= Opal's runtime support, included via opal-compiler)
```

### Runtime architecture

```
.uwk.rb source                                (= user-authored Ruby DSL)
  ↓ Opal compiler (build time, via Vite plugin)
JavaScript source                             (= Opal output + unworklet-rb glue)
  ↓ standard module resolution
@unworklet/core API calls                     (= defineProcessor / audioInput / ...)
  ↓ existing compile() pipeline
WASM binary                                   (= identical to TS path)
  ↓ AudioWorklet runtime
```

The Opal-compiled JavaScript executes at build time inside Vite. The output is a standard ES module that exports a `CompiledProcessor<C>`. From `@unworklet/core`'s perspective, there's no difference between a `.uwk.rb`-sourced processor and a `.uwk.ts`-sourced one.

### Vite plugin integration

```javascript
// In a user's Vite config
import unworklet from "@unworklet/unplugin";
import unworkletRuby from "@unworklet/ruby/vite";

export default {
  plugins: [
    unworklet(), // handles .ts / .uwk.ts
    unworkletRuby(), // handles .uwk.rb
  ],
};
```

The Ruby plugin:

1. Globs `**/*.uwk.rb`.
2. Invokes Opal to transpile each file to JavaScript.
3. Resolves the result as a regular `?worklet` import.
4. Delegates to `@unworklet/unplugin` for WASM compilation / artifact emission.

The plugin chains transparently; `@unworklet/unplugin` never knows the Ruby plugin exists.

## Ruby DSL design

### Top-level structure

A `.uwk.rb` file contains a single `processor` block:

```ruby
processor :stereo_gain do
  # declarations (= ambient methods inside this block via instance_eval)
  param :gain, 1.0, range: 0..4
  state :meter_l, 0, publish: { rate_fps: 30 }

  # process body
  process do
    for_sample do |i|
      # per-sample code
    end
    # per-block code
  end

  # optional
  on midi_in.note_on do |note, velocity|
    # MIDI handler
  end

  migrations [...]
end
```

`processor :name do ... end` is the entry point. The block runs once at build time (= `instance_eval` on a `Processor` context object), constructing the graph the same way `defineProcessor((ctx) => { ... })` does.

### Declarations

| Ruby form                                                   | Lowers to                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `param :gain, 1.0, range: 0..4`                             | `param.f32({ default: 1.0, min: 0, max: 4, automationRate: 'a-rate' }).named('gain')` |
| `param :gain, 1.0, range: 0..4, rate: :k_rate`              | `param.f32({...}).named('gain')` with `automationRate: 'k-rate'`                      |
| `state :z, 0`                                               | `state.f32(0)` (plain)                                                                |
| `state :meter_l, 0, publish: { rate_fps: 30 }`              | `state.f32(0).expose({ name: 'meter_l', publish: { rateFps: 30 } })`                  |
| `state :counter, 0, type: :i32`                             | `state.i32(0)`                                                                        |
| `buffer :ring, size: 44100`                                 | `buffer.f32({ size: 44100 })`                                                         |
| `audio_in :input, channels: 2`                              | `audioInput({ channels: 2, name: 'input' })`                                          |
| `audio_out :out, channels: 2`                               | `audioOutput({ channels: 2, name: 'out' })`                                           |
| `event :overshoot, payload: { level: :f32, channel: :i32 }` | `event<{ level: number, channel: number }>({ name: 'overshoot' })`                    |
| `message :load_preset, payload: { slot: :i32 }`             | `message<{ slot: number }>({ name: 'load_preset' })`                                  |
| `midi_in :note_in`                                          | `midiInput({ name: 'note_in' })`                                                      |
| `midi_out :arp_out`                                         | `midiOutput({ name: 'arp_out' })`                                                     |

Each declaration:

- Takes the slot name as the first arg (= symbol).
- The slot name auto-defines two methods on the processor context: a reader (`gain`) and a writer (`gain <<` via `<<` operator).
- snake_case Ruby names map 1:1 to camelCase on the JS / main-thread side via the bridge's automatic conversion.

### Stateful functions (`unit` keyword)

```ruby
unit :onepole do |coef|
  process do |input|
    coef * input + (1 - coef) * prev
  end
end
```

Lowers to:

```javascript
const onepole = defineSubgraph((coef) => ({
  process: (input) => coef.mul(input).add(sub(1, coef).mul(prev)),
}));
```

The `prev` bare reference is recognized inside `unit`'s `process` block — it injects a per-instance state slot (= same semantics as RFC-001's `$prev`, but without the sigil since Ruby's metaprogramming naturally handles the scoping).

Multi-method units:

```ruby
unit :oscillator do |sr|
  state :phase, 0.0
  state :freq, 440.0

  set_frequency do |hz|
    freq << hz
  end

  tick do
    phase << phase + freq / sr
    sin(phase * TAU)
  end

  reset do
    phase << 0.0
  end
end
```

Each method (`set_frequency`, `tick`, `reset`) lowers to a key in the subgraph's return record.

### Operators

`Node` class defines all binary / unary operators as instance methods. Ruby's operator overload is uniform across `+, -, *, /, %, **, ==, !=, <, <=, >, >=, &, |, ^, ~, <<, >>, [], []=` (= all parser-mapped to methods).

Mapping:

| Ruby operator                         | Maps to (= `@unworklet/core` primitive)                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `+` / `-` / `*` / `/` / `%`           | `add` / `sub` / `mul` / `div` / `mod`                                         |
| `**`                                  | `pow` (= new primitive needed, see Open Questions O3)                         |
| `-` (unary)                           | `neg`                                                                         |
| `==` / `!=` / `<` / `<=` / `>` / `>=` | `eq` / not(eq) / `lt` / `lte` / `gt` / `gte`                                  |
| `!`                                   | `not` (= shared with RFC-001 S3)                                              |
| `[]`                                  | sample-offset / buffer / param access                                         |
| `[]=`                                 | sample-offset / buffer write                                                  |
| `<<` (Node receiver)                  | `store` for state slots; `lshift` for `Node<'i32'>` bit-shift via method form |

The `<<` overload is the one sharp edge: it overloads "store" semantics on `State<T>` receivers and "left bit-shift" semantics on `Node<'i32'>` receivers. Disambiguation is by receiver type at the AST level. Documented as a known Ruby-specific convention.

### Index access (= same as RFC-001 S5)

```ruby
input.left[i]        # read sample at offset i
out.left[i] = expr   # write
buf[idx]             # buffer read
buf[idx] = expr      # buffer write
param[i]             # param read
```

Ruby's `[]` / `[]=` are method calls, so this is built-in operator overloading — no transform pass needed.

### Ternary

```ruby
gr = e > ceiling ? ceiling / e : 1
```

Ruby's ternary `? :` is a parser feature, not an operator method. The library's `Node` class needs to participate via `to_a` / `&` / truthiness tricks, OR the user uses an explicit form:

```ruby
gr = select(e > ceiling, ceiling / e, 1)
```

The implicit `?:` form would require careful Ruby trickery; the explicit `select` is always available. See §"Open Questions" O5 for the design choice.

### `if` statement sugar

Same 3 shapes as RFC-001 S7, expressed in Ruby:

```ruby
# Shape 1 — guarded store
state_slot << expr if cond

# Shape 2 — symmetric if-else
if cond
  state_slot << a
else
  state_slot << b
end

# Shape 3 — guarded emit
overshoot.emit(payload) if cond

if cond
  arp_out.emit type: :note_on, ...
  step_fired.emit ...
end
```

Ruby's postfix `if` reads more naturally than the TS prefix form. The library's runtime detects these shapes at graph capture and lowers to `select` / `emitIf` accordingly.

### MIDI handlers

```ruby
on midi_in.note_on do |note, velocity|
  root_note << note
  last_vel << velocity
end
```

`on` is a method that accepts an event reference and a block. Reads as English: "on noteOn, do this".

### Build-time / runtime split

Ruby code inside the `processor` block executes at build time (= via Opal). The Ruby `Node` class methods construct AST nodes (just like the TS Proxy-based capture). The graph is finalized when the block exits; the WASM emit stage takes over.

Build-time Ruby features available:

- Standard library (Math, Array, Hash, etc.) for build-time computation
- Build-time loops (`NUM_VOICES.times do |v| ... end`) for unrolling
- File I/O (= Opal supports this in Node.js build context) for loading coefficient tables
- Error handling (`raise` / `rescue`) for build-time validation
- Module / class system for reuse across `.uwk.rb` files (= Ruby `require` works through Opal)

The audio thread sees only WASM. No Ruby code, no Opal runtime, no Ruby objects.

## Concrete examples

(Abbreviated comparisons; full set lives in the experimental library's `examples/` once built.)

### Ex 1 — stereo gain + meter

```ruby
processor :stereo_gain do
  param :gain, 1.0, range: 0..4
  state :meter_l, 0, publish: { rate_fps: 30 }
  state :meter_r, 0, publish: { rate_fps: 30 }

  process do
    for_sample do |i|
      l = input.left[i] * gain[i]
      r = input.right[i] * gain[i]
      out.left[i]  = l
      out.right[i] = r
      meter_l << [l.abs, meter_l].max
      meter_r << [r.abs, meter_r].max
    end

    meter_l << meter_l * 0.95
    meter_r << meter_r * 0.95
  end
end
```

(`input` / `out` are ambient defaults provided by the library, parallel to RFC-001 S12 Tier C.)

### Ex 2 — 3-band biquad EQ (peaking coefficients + biquad subgraph)

```ruby
def peaking_coeffs(freq, q, gain_db, sr)
  a     = exp(gain_db * 0.05 * LN10)
  w0    = freq * TAU / sr
  cosw0 = cos(w0)
  alpha = sin(w0) / (q * 2)
  inv   = 1 / (1 + alpha / a)
  {
    b0: (1 + alpha * a) * inv,
    b1: -2 * cosw0      * inv,
    b2: (1 - alpha * a) * inv,
    a1: -2 * cosw0      * inv,
    a2: (1 - alpha / a) * inv,
  }
end

unit :peaking_band do |sr|
  state :z1, 0
  state :z2, 0

  process do |x, freq, q, gain_db|
    c = peaking_coeffs(freq, q, gain_db, sr)
    y = c[:b0] * x + z1
    z1 << c[:b1] * x + z2 - c[:a1] * y
    z2 << c[:b2] * x - c[:a2] * y
    y
  end
end

processor :three_band_eq do
  low_freq  = param :low_freq,  120,  range: 20..1000,    rate: :k_rate
  mid_freq  = param :mid_freq,  1000, range: 200..8000,   rate: :k_rate
  hi_freq   = param :hi_freq,   6000, range: 1000..20000, rate: :k_rate
  # ... q / gain bands omitted for brevity ...

  low_l = create_subgraph :peaking_band, sample_rate
  mid_l = create_subgraph :peaking_band, sample_rate
  hi_l  = create_subgraph :peaking_band, sample_rate
  low_r = create_subgraph :peaking_band, sample_rate
  mid_r = create_subgraph :peaking_band, sample_rate
  hi_r  = create_subgraph :peaking_band, sample_rate

  process do
    for_sample do |i|
      out.left[i]  = hi_l.process(mid_l.process(low_l.process(input.left[i],  low_freq[i], 0.7, 0), mid_freq[i], 1.0, 0), hi_freq[i], 0.7, 0)
      out.right[i] = hi_r.process(mid_r.process(low_r.process(input.right[i], low_freq[i], 0.7, 0), mid_freq[i], 1.0, 0), hi_freq[i], 0.7, 0)
    end
  end
end
```

### Ex 4 — Lookahead limiter (envelope follower + ternary + if-emit)

```ruby
def envelope_follow(x, attack_coef, release_coef, prev_slot)
  r = x.abs
  coef = r > prev_slot ? attack_coef : release_coef
  y = (r - prev_slot) * coef + prev_slot
  prev_slot << y
  y
end

processor :lookahead_limiter do
  param :ceiling,    -1, range: -24..0,  rate: :k_rate
  param :release_ms, 50, range: 1..500,  rate: :k_rate

  buffer :dly_l, size: LOOKAHEAD_SAMPLES
  buffer :dly_r, size: LOOKAHEAD_SAMPLES
  state  :dly_head, 0, type: :i32
  state  :env, 0
  state  :gain_reduction_db, 0, publish: { rate_fps: 30 }

  event :overshoot, payload: { level: :f32, channel: :i32 }

  process do
    ceiling_lin     = exp(ceiling * LN10 * 0.05)
    release_samples = release_ms * sample_rate / 1000
    release_coef    = 1 - exp(-1 / release_samples)
    attack_coef     = 1.0
    head_block      = dly_head

    for_sample do |i|
      peak = [input.left[i].abs, input.right[i].abs].max
      e    = envelope_follow(peak, attack_coef, release_coef, env)
      gr   = e > ceiling_lin ? ceiling_lin / e : 1

      w_idx = (head_block + i) % LOOKAHEAD_SAMPLES
      dly_l[w_idx] = input.left[i]
      dly_r[w_idx] = input.right[i]

      r_idx = (w_idx + 1) % LOOKAHEAD_SAMPLES
      out.left[i]  = dly_l[r_idx] * gr
      out.right[i] = dly_r[r_idx] * gr

      overshoot.emit at_sample: i, channel: 0, level: input.left[i].abs  if input.left[i].abs  > ceiling_lin
      overshoot.emit at_sample: i, channel: 1, level: input.right[i].abs if input.right[i].abs > ceiling_lin

      gain_reduction_db << [gain_reduction_db, log(gr) * 20 / LN10].min
    end

    dly_head          << (head_block + SAMPLES_PER_BLOCK) % LOOKAHEAD_SAMPLES
    gain_reduction_db << gain_reduction_db * 0.85
  end
end
```

### Ex 6 — MIDI arpeggiator (event handlers + emit cluster)

```ruby
processor :arpeggiator do
  midi_in  :note_in
  midi_out :arp_out
  audio_out :out, channels: 1

  state :root_note,    60, type: :i32
  state :last_vel,     96, type: :i32
  state :step_idx,     0,  type: :i32, publish: { rate_fps: 60 }
  state :sample_accum, 0,  type: :i32

  PATTERN_LEN.times do |s|
    state :"step_#{s}", 0, type: :i32
  end

  event   :step_fired, payload: { step: :i32, note: :i32 }
  message :load_pattern, payload: { steps: :i32_array }

  on note_in.note_on do |note, velocity|
    root_note << note
    last_vel  << velocity
  end

  on load_pattern do |steps|
    PATTERN_LEN.times do |s|
      slot = method(:"step_#{s}")
      slot << steps[s] if s < steps.length
    end
  end

  process do
    samples_per_step = 48000 / 8

    for_sample do |i|
      out.ch(0)[i] = 0

      acc  = sample_accum + 1
      roll = acc > samples_per_step
      sample_accum << (roll ? 0 : acc)

      next_step = (step_idx + 1) % PATTERN_LEN

      # build-time unrolled select chain across PATTERN_LEN slots
      offset = method(:step_0).call
      (1...PATTERN_LEN).each do |s|
        offset = select(next_step == s, method(:"step_#{s}").call, offset)
      end
      fire_note = root_note + offset

      if roll
        arp_out.emit    type: :note_on, at_sample: i, note: fire_note, velocity: last_vel, channel: 0
        step_fired.emit at_sample: i, step: next_step, note: fire_note
      end

      step_idx << (roll ? next_step : step_idx)
    end
  end
end
```

The `method(:"step_#{s}")` form retrieves a named state slot dynamically — Ruby's reflection makes this clean. (TS equivalent requires an array indexed by `s` from RFC-001 S9 auto-derive, which works but is less direct.)

### Live coding REPL (= future, not v0.1)

```ruby
# minimal.uwk.rb
processor :minimal do
  process do
    for_sample do |i|
      out.left[i] = sin(440 * TAU * t[i] / sample_rate)
    end
  end
end
```

REPL-style 1-liner (= with additional ambient sugars):

```ruby
out << sin(440 * TAU * t / sample_rate)
```

(`out << expr` = "write to output at every sample, implicit forSample". This is a Ruby-DSL-only convenience that doesn't exist in the TS surface.)

## Build pipeline detail

### Opal invocation

```javascript
// @unworklet/ruby/src/compile.ts
import { compile as opalCompile } from 'opal-compiler';

export async function compileUwkRb(source: string, filePath: string): Promise<string> {
  // Inject the unworklet-rb runtime as a Ruby require
  const wrapped = `
require 'unworklet'
${source}
  `;

  const jsCode = opalCompile(wrapped, {
    file: filePath,
    sourceMap: true,
    // ... Opal options
  });

  return jsCode;
}
```

The Opal output is standard JavaScript that:

1. Initializes Opal's runtime.
2. Loads `unworklet-rb`'s Ruby module (= which has been pre-Opal-compiled and shipped with the library).
3. Executes the user's Ruby code.
4. The user's code calls into the `unworklet-rb` Ruby DSL, which internally calls `@unworklet/core` JS functions via Opal's JS interop (= `\`backtick\` strings`, `Native()`, etc.).
5. The result is a `CompiledProcessor<C>` exported as the module's default export.

### Vite plugin

```javascript
// @unworklet/ruby/src/vite-plugin.ts
import type { Plugin } from 'vite';
import { compileUwkRb } from './compile.ts';

export default function unworkletRuby(): Plugin {
  return {
    name: '@unworklet/ruby',
    async transform(code, id) {
      if (!id.endsWith('.uwk.rb')) return null;
      const js = await compileUwkRb(code, id);
      return { code: js };
    },
  };
}
```

### Source maps

Two stages compose:

```
.uwk.rb source position
  ↓ (Opal-emitted source map)
Opal-output JS position
  ↓ (existing @unworklet/core source map pipeline)
WASM position
```

Opal supports source maps natively; the rest is the standard `@unworklet/core` pipeline.

### Build-time isolation

The Opal runtime + transpiled user code runs at **build time only**. The resulting WASM module embedded in the worklet has no trace of Ruby or Opal. Production bundles ship just the WASM + the AudioWorkletProcessor JS wrapper that `@unworklet/core` emits.

## Live coding REPL (= optional future scope)

Build-time Opal is sufficient for plugin development. For live coding REPL, an in-browser Ruby runtime is needed:

- **Ruby.wasm** ships a CRuby build (~3-5 MB compressed).
- A REPL UI loads Ruby.wasm in the browser.
- Each REPL cell's Ruby code is evaluated; the result is a `CompiledProcessor<C>`.
- `replaceProcessor` (= `05-client.md` §8) swaps the running processor.

This is **out of scope for v0.1** of `@unworklet/ruby`. Deferred until build-time path validates.

## Relationship to other RFCs

| RFC            | Scope                                              | Status              |
| -------------- | -------------------------------------------------- | ------------------- |
| RFC-001        | `.uwk.ts` Tier B/C authoring frontend in main repo | Draft (this branch) |
| RFC-002        | Reserved (= potentially Tier D bespoke language)   | Not started         |
| RFC-003 (this) | `@unworklet/ruby` experimental library             | Draft (this branch) |

RFC-001 commits the main repo to a TypeScript-first contract. RFC-003 explores a Ruby-flavored sibling without touching that contract. They are **complementary, not exclusive** — both can ship; users pick whichever fits their workflow.

If RFC-002 (bespoke language) is later pursued, it would also live as a separate experimental library following the same model as RFC-003 (= isolated repo, downstream consumer of `@unworklet/core`).

## Public API surface requirements for `@unworklet/core`

For `@unworklet/ruby` to work as a downstream library, `@unworklet/core` must export:

| Export                                           | Purpose              | Already exported?    |
| ------------------------------------------------ | -------------------- | -------------------- |
| `defineProcessor`                                | Build processor      | ✓                    |
| `defineSubgraph`                                 | Build subgraph       | ✓                    |
| `instantiate`                                    | Instantiate subgraph | ✓                    |
| `audioInput` / `audioOutput`                     | Declarations         | ✓                    |
| `state` / `buffer` / `param`                     | Declarations         | ✓                    |
| `event` / `message` / `midiInput` / `midiOutput` | Declarations         | ✓                    |
| `forSample`                                      | Per-sample loop      | ✓                    |
| `select`                                         | Conditional          | ✓                    |
| All math primitives (`sin`, `cos`, `exp`, etc.)  | Math                 | ✓                    |
| Scalar constructors (`f32`, `i32`, etc.)         | Constructors         | ✓                    |
| `compile`                                        | WASM emit            | ✓                    |
| `Node<T>` type                                   | TypeScript type      | ✓                    |
| `State<T>` / `Buffer<T>` / `Param` types         | TypeScript types     | ✓                    |
| `not(b)` primitive (= RFC-001 S3)                | Logical not          | ✗ (= RFC-001 ratify) |
| `Node<T>.pipe()` method (= RFC-001 S10)          | Pipe chain           | ✗ (= RFC-001 ratify) |
| `pipe()` free function                           | Pipe free            | ✗ (= RFC-001 ratify) |

The library is **fully buildable on `@unworklet/core` as it stands today** (= pre-RFC-001). The `not` / `pipe` items from RFC-001 are nice-to-have for the Ruby surface but not blockers — Ruby's `!` would lower to `select(eq, false, true)` until `not(b)` lands.

## Open questions

### O1 — Repo location and naming

| Option                                            | Repo                                   | npm package       | Notes                                               |
| ------------------------------------------------- | -------------------------------------- | ----------------- | --------------------------------------------------- |
| (a) Same org, sibling repo                        | `yuichkun/unworklet-rb`                | `@unworklet/ruby` | Branded as unworklet's experimental sibling         |
| (b) Separate org                                  | `unworklet-rb/unworklet-rb`            | `unworklet-rb`    | Distance from main project; community-led potential |
| (c) Inside `yuichkun/unworklet` as a subdirectory | `yuichkun/unworklet/experimental/ruby` | `@unworklet/ruby` | Same repo, different package — partial separation   |

Recommendation: **(a)**. Sibling repo under same GitHub user / org, scoped npm package. Clear "experimental" naming, but inheriting visibility from main project.

### O2 — Ruby version target

Opal supports a Ruby 3.2-compatible subset. Target Ruby 3.2 syntax features (= pattern matching, endless methods, etc.). Document supported / unsupported Ruby features in `docs/ruby-conventions.md`.

### O3 — `**` power operator

Ruby's `**` (= `Numeric#**`) is exponentiation. unworklet has no `pow` primitive currently. Add `pow(base, exponent)` primitive to `@unworklet/core`?

- (a) Add `pow` to `@unworklet/core` — small additive change, useful for both Tier A `.ts` and `.uwk.rb`.
- (b) Library-side: lower `a ** b` to `exp(log(a) * b)` — works for `Node<'f32'>` / `Node<'f64'>` but inefficient for integer powers.
- (c) Reject `**` in `.uwk.rb`, force authors to write `exp(log(a) * b)` or use square as `x * x`.

Recommendation: (a). Cheap addition; benefits all surfaces.

### O4 — `<<` for store vs bit-shift

The `<<` operator on `Node<'i32'>` could be bit-shift (= Ruby's `Integer#<<`). For `State<T>` receivers, we want it to mean "store into". Disambiguation by receiver type at the Ruby level.

- (a) `<<` on `State<T>` = store; `<<` on `Node<'i32'>` rejected (= use `.lshift(n)` method form).
- (b) `<<` on `State<T>` = store; `<<` on `Node<'i32'>` = lshift (= disambiguate by receiver).
- (c) Different operator for store (= `:=` is not a Ruby operator; `<<<` ambiguous).

Recommendation: (b). Both make sense by receiver type; Ruby's operator dispatch handles it.

### O5 — Ternary `? :` on `Node<'bool'>`

Ruby's `cond ? x : y` evaluates `cond` for truthiness, then returns `x` or `y`. To work with `Node<'bool'>`, the Node would need to participate in Ruby's truthiness mechanism (= override `!` / be falsy). But this conflicts with `!` lowering to `not(b)`.

Option (a): Disable ternary on `Node<'bool'>`, force authors to write `select(cond, x, y)` explicitly.
Option (b): Support ternary via a clever truthiness hack (= `Node<'bool'>` truthy in Ruby always; ternary detection happens by inspecting the call site via tracepoint or method_missing).
Option (c): Custom Ruby method `cond.then_else(x, y)` — verbose but clean.

Recommendation: (a). Explicit `select` is short enough; ternary trickery is risky.

### O6 — `prev` keyword

Bare `prev` inside `unit`'s `process` block injects a state slot. Library implementation:

- `Unit` context object has a `prev` method that returns the slot reference.
- The graph-capture mechanism detects `prev` reads and writes, and at unit-method-exit injects a `slot.store(returnValue)`.

Confirm during PoC implementation.

### O7 — TypeScript types for library consumers

`@unworklet/ruby` exports its compiled `CompiledProcessor<C>` to TS consumers. The `.d.ts` declares the wrapped processor's `C` channel count and named slot map for `node.params.<name>`, `node.state.<name>`, etc.

Need: the library tooling generates `.d.ts` files alongside the JS output, matching the structure of `@unworklet/unplugin`'s typed client emission.

### O8 — Source map fidelity

Opal source maps + `@unworklet/core` source maps compose. Confirm during PoC that runtime errors in the WASM project back to the original `.uwk.rb` position correctly.

### O9 — Live coding REPL scope

Defer to post-v0.1. Reassess based on Tier B/C live-coding adoption + community demand for Ruby specifically.

## Implementation phases (= experimental library, not unworklet roadmap)

| Phase | Scope                                                                   | Deliverable                                                                      | Effort (AI-assist) |
| ----- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------ |
| R0    | Repo setup, Opal smoke test                                             | `unworklet-rb` empty package, "hello world" Ruby → JS → WASM via @unworklet/core | 1-2 days           |
| R1    | Core DSL (declarations + process + operator overloading + index access) | Ex 1 stereo gain ports verbatim, audio comes out                                 | 3-5 days           |
| R2    | Stateful units + `prev`                                                 | Ex 2 biquad EQ ports                                                             | 2-3 days           |
| R3    | If-sugar + ternary + emit                                               | Ex 4 limiter ports                                                               | 2 days             |
| R4    | MIDI handlers + dynamic slot reflection                                 | Ex 6 arpeggiator ports                                                           | 2 days             |
| R5    | Source maps + Vite plugin polish                                        | Errors project to `.uwk.rb` positions                                            | 2 days             |
| R6    | Canonical Ex 1-10 all port + bit-exact regression                       | All canonical examples in `.uwk.rb`, identical WASM                              | 3 days             |
| R7    | Documentation + README + audience pitch                                 | Library is documented; positioning vs Tier B/C clear                             | 2 days             |
| R8    | (= optional, deferred) Ruby.wasm REPL                                   | Live coding playground                                                           | 5-8 days           |

**Total: ~17-22 days for v0.1 (= R0-R7), excluding REPL.**

Single contributor, AI-assisted. Independent of `@unworklet/core` development.

## Effort, audience size estimate, kill criteria

### When to ship

Ship `@unworklet/ruby` v0.1 (= R0-R7 complete) **after RFC-001's Tier B/C `.uwk.ts` is in user hands and Tier C live-coding fit is measured**. The order matters: if Tier C already covers the live coding use cases comfortably, the Ruby experiment may be unnecessary.

### When to deprecate

Honest kill criteria:

- **6 months post-v0.1**: < 50 active users, no third-party contributions, no Sonic Pi audience uptake → mark library as inactive, recommend Tier B/C, freeze at last release.
- **12 months post-v0.1**: < 200 active users, no organic ecosystem growth → archive repo, retire npm package.
- **Anytime**: a Ruby ecosystem shift that obsoletes Opal (= e.g., browser-native Ruby) → reassess implementation, possibly rewrite.

Failure is fine. The point of "experimental" is permission to fail without spec retract.

## References

### unworklet (internal)

- `00-foundations.md` §2 — non-goals (= unworklet is not a music-making framework; this RFC respects that)
- `01-dsl.md` — Tier A chain DSL (= public API surface this library depends on)
- `09-repo-structure.md` §2.4 — package dependency graph (= experimental library is a downstream consumer)
- `10-roadmap.md` §3 — explicitly deferred items (= Ruby is not in deferred mandatory mitigations, it's a separate experimental track)
- RFC-001 — `.uwk.ts` Tier B/C frontend (= sibling RFC, complementary)

### Ruby + Opal

- [Opal — Ruby-to-JavaScript compiler](https://opalrb.com/)
- [opal-compiler npm package](https://www.npmjs.com/package/opal-compiler)
- [Ruby.wasm — CRuby compiled to WebAssembly](https://github.com/ruby/ruby.wasm)

### Audio-domain Ruby precedents

- [Sonic Pi](https://sonic-pi.net/) — Ruby-based live coding music environment (= primary audience overlap)
- [Sonic Pi's DSL source](https://github.com/sonic-pi-net/sonic-pi) — patterns for Ruby DSL in audio context

### Internal DSL design references

- [Sinatra](https://github.com/sinatra/sinatra) — minimal Ruby web DSL (= block / symbol patterns)
- [RSpec](https://github.com/rspec/rspec) — Ruby test DSL (= description-style nesting)
- [Rake](https://github.com/ruby/rake) — Ruby task DSL (= declaration-heavy)

These three established the Ruby internal DSL conventions this library follows.
