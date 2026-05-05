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
        06-testing.md   07-tooling.md   08-deployment.md
```

Independent and can be picked up at any time:

* `09-repo-structure.md` — monorepo tool, package layout, license, npm scope, TS version policy
* `10-roadmap.md` — v1.0.0 acceptance criteria and beyond
* `decisions-log.md` — cross-cutting reference

## Status

| Doc | Status |
|---|---|
| `00-foundations.md` | partial (§§1–4 written; §5 realtime-safety + §6 cross-cutting still placeholder) |
| `01-dsl.md` | written |
| `02-messaging.md` | skeleton (Q27 will resolve) |
| `03-compiler.md` | partial (§2 graph capture + §2.4 three-layer error written; §1, §3–§8 placeholder) |
| `04-worklet-runtime.md` | skeleton (Q18 / Q19 / Q20 / Q21 will resolve) |
| `05-client.md` | partial (§2.6 snapshot/restore + §6 timing + §7 latency-comp written; §1–§5 placeholder) |
| `06-testing.md` | skeleton |
| `07-tooling.md` | skeleton |
| `08-deployment.md` | skeleton (Q11 / Q24 will resolve) |
| `09-repo-structure.md` | skeleton (Q12 / Q13 / Q15 / Q16 / Q26 will resolve) |
| `10-roadmap.md` | skeleton (Q14 will resolve) |
| `11-midi.md` | written |
| `decisions-log.md` | populated (Q1–Q10, Q22 resolved; remaining open Qs tracked in index) |

Content is filled in incrementally as design questions are resolved through dialogue. Anything not yet present in a doc is not yet decided — see `decisions-log.md` for what *has* been decided.
