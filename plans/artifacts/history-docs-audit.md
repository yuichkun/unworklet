# WI-2 — history docs old-API audit (FORK A: full spec migration + history kept as annotations)

The historical record (decisions-log + RFC drafts) intentionally KEEPS the
surface as decided at the time — rewriting "we decided/rejected message<T>" into
the current API would distort the history. Per the maintainer's FORK A ruling, these
files are annotated, not rewritten.

## Unification is recorded as a decision

The message → event unification is itself a logged decision, not an undocumented
drift:

- **Q87** — message / event are independent namespaces (same-name in/out OK).
- **Q88** — main-side `node.messages` folded into `node.events`; authoring unified
  into the `event` family (`event({from:'main'})` = old message, `event({to:'main'})`
  = old event, `event.midi({from|to})` = old midiInput/midiOutput). References
  issue #10. Internal WASM/SAB/postMessage wire is frozen (byte-identical).

## Annotation applied

Each history file carries a prominent **surface note** pointing readers at the
current surface (`01-dsl.md` / `11-midi.md`) and at Q87 / Q88:

| file                           | old-API mentions (as-decided) | supersede note                                                        |
| ------------------------------ | ----------------------------- | --------------------------------------------------------------------- |
| docs/decisions-log.md          | 114                           | ✓ "Surface-evolution note" in Status (read before any pre-Q87 entry)  |
| docs/rfc-001-uwk-ts-dsl.md     | 79                            | ✓ Surface note in Status (draft predates .read/.write + event family) |
| docs/RFC-002-ml-integration.md | 9                             | ✓ Surface note after Status                                           |
| docs/rfc-003-ruby-frontend.md  | 7                             | ✓ Surface note after Status                                           |

The remaining mentions are all inside entries that record a decision or a draft
proposal as it stood; the surface note disambiguates each from current API. Spec
docs (00–12) carry zero old-API references — see WI-1 gate.
