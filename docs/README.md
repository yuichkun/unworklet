# unworklet — implementation specification

This `docs/` tree is the authoritative specification for the v1.0.0 implementation. It is **disposable**: it exists to align humans and AI implementers during v1.0.0 build-out and is not maintained after.

End-user documentation (tutorials, recipe guides, library reference) is **out of scope** for this tree and will live elsewhere.

## How to use this spec

1. Every implementer reads `00-foundations.md` first — vocabulary, type system, realtime-safety invariants.
2. Pick up the component doc(s) for your assigned area.
3. Consult `decisions-log.md` for the rationale behind any decision you encounter.

If your work touches an area not covered here, **stop and surface the gap** to the human reviewer rather than inventing the missing decision.

## Read & implementation order

```
                    00-foundations.md
                           │
        ┌──────────┬───────┴───────┬──────────┐
        ▼          ▼               ▼          ▼
    01-dsl.md  02-messaging.md  03-compiler.md
        │          │               │
        └──────────┴───────┬───────┘
                           ▼
              04-worklet-runtime.md  ──►  05-client.md
                  │                            │
                  └──────►  11-midi.md  ◄──────┘
                           │
                           ▼
        06-testing.md   07-vite-plugin.md   08-deployment.md   13-offline-render.md
```

Independent and can be picked up at any time:

* `09-repo-structure.md` — monorepo tool, package layout, license, npm scope, TS version policy
* `10-roadmap.md` — v1.0.0 acceptance criteria and beyond
* `12-canonical-examples.md` — full-stack, self-contained reference plugins; **integrity anchor** that every other doc is checked against (see `AGENTS.md` "Canonical examples integrity rule")
* `decisions-log.md` — cross-cutting reference

## Status

| Doc | Status |
|---|---|
| `00-foundations.md` | partial (§§1–5 written; §6 cross-cutting still placeholder) |
| `01-dsl.md` | written |
| `02-messaging.md` | written |
| `03-compiler.md` | partial (§2 graph capture + §2.4 three-layer error written; §1, §3–§8 placeholder) |
| `04-worklet-runtime.md` | partial (§7 publish scheduling written; §1–§6 + §8 placeholder, Q18 / Q19 / Q20 / Q21 will resolve) |
| `05-client.md` | partial (§2 surface listing + §2.6 snapshot/restore + §5 event/state subscription + §6 timing + §7 latency-comp written; §1, §3, §4 placeholder) |
| `06-testing.md` | skeleton (Q23 + Q24 + Q25 resolved at scope level; matcher / golden-file detail pending) |
| `07-vite-plugin.md` | skeleton (Q23 + Q24 + Q25 resolved at scope level; per-section detail pending) |
| `08-deployment.md` | skeleton (Q11 + Q24 resolved; §3 SAB degradation + §4 WASM distribution detail pending) |
| `09-repo-structure.md` | skeleton (Q12 / Q13 / Q15 / Q16 / Q26 will resolve) |
| `10-roadmap.md` | partial (§3.1 mandatory deferred mitigations written; §1 / §2 / §3.2 placeholder, Q14 will resolve) |
| `11-midi.md` | written |
| `12-canonical-examples.md` | written (integrity anchor; updated together with any spec change — see `AGENTS.md`) |
| `13-offline-render.md` | skeleton (Q23 + Q24 + Q25 resolved at scope level; API / backend detail pending) |
| `decisions-log.md` | populated (Q1–Q10, Q22, Q27 resolved; remaining open Qs tracked in index) |

Content is filled in incrementally as design questions are resolved through dialogue. Anything not yet present in a doc is not yet decided — see `decisions-log.md` for what *has* been decided.
