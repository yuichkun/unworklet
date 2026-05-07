# Hot reload (`unworklet dev`)

Watches a processor source file, rebuilds on change, posts an SSE event stream so a connected page can hot-swap.

## Run

```sh
npx unworklet dev ./src/my-processor.ts --port 5174
```

```
[unworklet dev] watching ./src/my-processor.ts
[unworklet dev] artifacts at ./dist-unworklet
[unworklet dev] dev server: http://127.0.0.1:5174

[unworklet dev] rebuilt (reload) — schemaHash=a3f2c1d0, 0 client(s) notified
```

## Page-side wire

```ts
const events = new EventSource("http://127.0.0.1:5174/events");
events.onmessage = async (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "schema-changed") {
    // Slot layout changed — fresh instance with re-init.
    await rebuildAndReplaceNode();
  } else if (msg.type === "reload") {
    // Compatible schema — hot-swap module URL, keep state.
    await replaceWorkletModuleUrl();
  } else if (msg.type === "error") {
    showCompileError(msg.message);
  }
};
```

The dev server exposes the freshly-built artifacts at:

| Path | What |
|---|---|
| `/events` | SSE event stream |
| `/artifact/worklet.js` | Current worklet module JS |
| `/artifact/module.wasm` | Current WASM binary |
| `/artifact/meta.json` | Current build metadata |
| `/artifact/module.wat` | Text format (for debugging) |

## What changes between rebuilds

- **Same `schemaHash`** → hot-reload preserves slot values. New code, same memory layout.
- **Different `schemaHash`** → fresh instance. Use [snapshot + restore](./snapshots) to migrate state programmatically.

The dev server watches the **source directory recursively**, so changes to imported helpers re-trigger the rebuild.
