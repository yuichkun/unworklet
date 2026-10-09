import { randomUUID } from "node:crypto";
import { createArtifactSink } from "./artifacts.mjs";

const registryKey = Symbol.for("unworklet.postmessage-diagnostic.sessions.v1");
const sessions = (globalThis[registryKey] ??= new Map());

export function getDiagnosticSession(output, settings) {
  const identity = JSON.stringify(settings);
  const previous = sessions.get(output);
  if (previous) {
    if (previous.finished) throw new Error("Diagnostic session already finished");
    if (previous.identity !== identity) throw new Error("Diagnostic session identity mismatch");
    return previous.session;
  }
  const runId = randomUUID();
  const sink = createArtifactSink(output, { ...settings, runId });
  const entry = { identity, finished: false, session: null };
  let started = false;
  const requireStarted = () => {
    if (entry.finished) throw new Error("Diagnostic session already finished");
    if (!started) throw new Error("Diagnostic session has not started");
  };
  entry.session = Object.freeze({
    runId,
    sink: Object.freeze({
      start() {
        if (entry.finished) throw new Error("Diagnostic session already finished");
        sink.start();
        started = true;
      },
      recordTransform(record) {
        requireStarted();
        return sink.recordTransform(record);
      },
      write(result) {
        requireStarted();
        return sink.write(result);
      },
      finish(result) {
        requireStarted();
        try {
          return sink.finish(result);
        } finally {
          entry.finished = true;
        }
      },
    }),
  });
  sessions.set(output, entry);
  return entry.session;
}
