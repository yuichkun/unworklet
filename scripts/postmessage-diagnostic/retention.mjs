export function boundedError(error) {
  try {
    return {
      name: String(error?.name ?? typeof error).slice(0, 128),
      message: String(error?.message ?? error).slice(0, 1024),
      stack: String(error?.stack ?? "").slice(0, 4096),
    };
  } catch {
    return { name: "unreadable-error", message: "Error serialization failed", stack: "" };
  }
}

const copy = (data) => (data == null ? null : Array.from(data.slice(0, 128)));

export function createRetention({
  write,
  report,
  readClient,
  testMarker,
  taskMeta,
  exportTimeoutMs = 100,
}) {
  let attempted = false;
  let frozen = null;
  const warn = (error) => {
    try {
      report("UWK_DIAGNOSTIC_EXPORT_FAILURE " + JSON.stringify(boundedError(error)));
    } catch {
      /* A diagnostic sink cannot replace the test failure. */
    }
  };
  const run = {
    stage: "entered",
    closed: false,
    node: null,
    context: null,
    rendered: null,
    observed: null,
    adoptNode(node) {
      if (run.closed) {
        try {
          node.dispose();
        } catch (error) {
          warn(error);
        }
        return false;
      }
      run.node = node;
      return true;
    },
    freezeObservation(observed) {
      run.observed = observed;
      const client = readClient();
      client?.record(6, observed);
      frozen = Object.freeze(copy(client?.data));
    },
    async finish(primaryFailed, primaryError, origin = "finally") {
      if (attempted) return;
      attempted = true;
      run.closed = true;
      const failures = {
        primary: primaryFailed ? boundedError(primaryError) : null,
        capture: null,
        dispose: null,
      };
      const artifact = {
        schema: 2,
        origin,
        stage: run.stage,
        primaryFailed,
        observed: run.observed,
        observationCaptured: frozen !== null,
        markers: {
          test: testMarker ?? null,
          client: null,
          workletHandshake: null,
          workletFinal: null,
        },
        main: null,
        worklet: null,
        workletHandshake: null,
        failures,
        audioEvidenceValid: false,
      };
      try {
        const client = readClient();
        artifact.markers.client = client?.marker ?? null;
        artifact.markers.workletHandshake = client?.workletMarker ?? null;
        artifact.main = frozen ?? copy(client?.data);
        artifact.workletHandshake = copy(client?.handshake);
        if (run.rendered) {
          artifact.worklet = copy(run.rendered.getChannelData(0).subarray(3968, 4096));
          if (artifact.worklet?.[0] === 54124)
            artifact.markers.workletFinal = client?.workletMarker ?? null;
        }
        artifact.environment = {
          userAgent: String(globalThis.navigator?.userAgent ?? "unavailable").slice(0, 256),
          isolated: globalThis.crossOriginIsolated ?? null,
          transport: run.node?.diagnostics?.transport ?? null,
          sampleRate: run.context?.sampleRate ?? null,
          length: run.rendered?.length ?? null,
        };
      } catch (error) {
        failures.capture = boundedError(error);
      }
      let disposeFailed = false;
      let disposeError;
      try {
        run.node?.dispose();
      } catch (error) {
        disposeFailed = true;
        disposeError = error;
        failures.dispose = boundedError(error);
      }
      let exportFailed = false;
      let exportError;
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Diagnostic export exceeded ${exportTimeoutMs}ms`);
            error.name = "DiagnosticExportTimeout";
            reject(error);
          }, exportTimeoutMs);
        });
        await Promise.race([Promise.resolve().then(() => write(artifact)), timeout]);
      } catch (error) {
        exportFailed = true;
        exportError = error;
        try {
          if (taskMeta) taskMeta.uwkDiagnosticExportFailure = boundedError(error);
        } catch {
          /* Secondary metadata cannot replace the original error. */
        }
        warn(error);
      } finally {
        clearTimeout(timer);
      }
      if (primaryFailed) return;
      if (disposeFailed) throw disposeError;
      if (exportFailed) throw exportError;
    },
  };
  return run;
}
