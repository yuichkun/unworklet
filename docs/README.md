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
| `00-foundations.md` | skeleton |
| `01-dsl.md` | skeleton |
| `02-messaging.md` | skeleton |
| `03-compiler.md` | skeleton |
| `04-worklet-runtime.md` | skeleton |
| `05-client.md` | skeleton |
| `06-testing.md` | skeleton |
| `07-tooling.md` | skeleton |
| `08-deployment.md` | skeleton |
| `09-repo-structure.md` | skeleton |
| `10-roadmap.md` | skeleton |
| `11-midi.md` | skeleton |
| `decisions-log.md` | skeleton |

Content is filled in incrementally as design questions are resolved through dialogue. Anything not yet present in a doc is not yet decided — see `decisions-log.md` for what *has* been decided.
