import { accessSync, constants, existsSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { boundedError } from "./retention.mjs";
import { decodeArtifact, decodeFile } from "./decode.mjs";

const runnerError = (error) => {
  const bounded = boundedError(error);
  return {
    name: bounded.name.slice(0, 64),
    message: bounded.message.slice(0, 384),
    stack: bounded.stack.slice(0, 1024),
  };
};

function writeBounded(file, value, maxBytes) {
  const json = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(json) > maxBytes) throw new Error("Diagnostic artifact capacity exceeded");
  writeFileSync(file, json, { flag: "wx" });
}

export function createArtifactSink(output, manifest) {
  if (typeof output !== "string" || !path.isAbsolute(output))
    throw new Error("UWK_DIAG_OUTPUT must be an absolute new file path");
  accessSync(path.dirname(output), constants.W_OK);
  const pending = output + ".manifest.json.pending";
  for (const file of [output, output + ".manifest.json", output + ".runner.json", pending]) {
    if (existsSync(file)) throw new Error(`Diagnostic artifact already exists: ${file}`);
  }
  manifest = { ...manifest, transforms: {} };
  let started = false;
  return {
    start() {
      writeBounded(output + ".manifest.json", manifest, 16_384);
      started = true;
    },
    recordTransform(record) {
      if (!["test", "client", "worklet"].includes(record.role))
        throw new Error("Unknown transform role");
      if (record.runId !== manifest.runId) throw new Error("Transform run ID mismatch");
      const previous = manifest.transforms[record.role];
      if (previous) {
        if (
          previous.sourceHash === record.sourceHash &&
          previous.transformedHash === record.transformedHash &&
          previous.sourcePath === record.sourcePath
        )
          return;
        previous.ambiguous = true;
      } else {
        manifest.transforms[record.role] = { ...record, ambiguous: false };
      }
      if (started) {
        writeBounded(pending, manifest, 16_384);
        renameSync(pending, output + ".manifest.json");
      }
    },
    write(result) {
      const artifact = { ...result, ...manifest };
      const validation = decodeArtifact(artifact, manifest);
      writeBounded(
        output,
        {
          ...artifact,
          validation: { status: validation.status, reasons: validation.reasons ?? [] },
        },
        65_536,
      );
    },
    finish({
      reason,
      errors = [],
      moduleStates = [],
      caseResult = null,
      collection = null,
      secondaryExportFailure = null,
    }) {
      const tracePresent = existsSync(output);
      const traceStatus = decodeFile(output).status;
      const metadata = {
        runId: manifest.runId,
        reason: String(reason).slice(0, 128),
        tracePresent,
        traceStatus,
        collection,
        secondaryExportFailure:
          secondaryExportFailure === null ? null : runnerError(secondaryExportFailure),
        moduleStates: moduleStates.slice(0, 2).map((s) => String(s).slice(0, 128)),
        caseResult:
          caseResult === null
            ? null
            : {
                state: String(caseResult.state).slice(0, 128),
                errors: (caseResult.errors ?? []).slice(0, 1).map(runnerError),
              },
        errors: errors.slice(0, 2).map(runnerError),
      };
      writeBounded(output + ".runner.json", metadata, 16_384);
      return metadata;
    },
  };
}
