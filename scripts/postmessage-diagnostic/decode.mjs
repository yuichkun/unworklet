import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const namesW = [
  "",
  "ready-send",
  "listener-registered",
  "port-started",
  "queued",
  "injected",
  "wasm-returned",
  "publish-posted",
  "render-cutoff",
];
const namesM = [
  "",
  "ready-received",
  "send",
  "publish-received",
  "mirror-written",
  "render-resolved",
  "observed",
  "createNode-returned",
];

export function decodeArtifact(artifact, manifest = artifact) {
  const reasons = [];
  const reject = (reason) => {
    if (reasons.length < 16) reasons.push(reason);
  };
  const incomplete = () => ({
    status: "incomplete",
    reasons,
    negativeEvidenceAllowed: false,
    consumptionConfirmed: false,
    audioEvidenceValid: false,
  });
  if (!artifact || artifact.schema !== 2) {
    reject("schema");
    return incomplete();
  }
  const { worklet: w, main: m, markers, runId } = artifact;
  if (
    typeof runId !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(runId) ||
    manifest?.runId !== runId
  )
    reject("run ID / manifest mismatch");
  if (
    markers?.test !== `uwk-diag-test-v2:${runId}` ||
    markers?.client !== `uwk-diag-client-v2:${runId}` ||
    markers?.workletHandshake !== `uwk-diag-worklet-v2:${runId}` ||
    markers?.workletFinal !== `uwk-diag-worklet-v2:${runId}`
  )
    reject("transform markers");
  for (const [role, sourcePath] of [
    ["test", "src/__tests__/browser/postmessage/message-counter.test.ts"],
    ["client", "src/client.ts"],
    ["worklet", "src/worklet.ts"],
  ]) {
    const actual = artifact.transforms?.[role];
    const expected = manifest?.transforms?.[role];
    if (
      !actual ||
      !expected ||
      actual.role !== role ||
      actual.runId !== runId ||
      actual.sourcePath !== sourcePath ||
      actual.ambiguous !== false ||
      expected.ambiguous !== false ||
      !/^[a-f0-9]{64}$/.test(actual.sourceHash) ||
      !/^[a-f0-9]{64}$/.test(actual.transformedHash) ||
      ["runId", "role", "sourcePath", "sourceHash", "transformedHash"].some(
        (key) => actual[key] !== expected[key],
      )
    )
      reject(`missing / mismatched ${role} transform hashes`);
  }
  if (artifact.recording !== true || artifact.observationCaptured !== true)
    reject("recording / observation cutoff");
  if (!Array.isArray(w) || !Array.isArray(m) || w.length !== 128 || m.length !== 128) {
    reject("both arrays must have exactly 128 elements");
    return incomplete();
  }
  if (!Array.from(w).every(Number.isFinite) || !Array.from(m).every(Number.isFinite))
    reject("nonfinite / nonnumeric element");
  if (!integer(w[1], 0, 15) || !integer(m[0], 0, 24)) {
    reject("finite integer record counts");
    return incomplete();
  }
  if (w[0] !== 54124 || w[2] !== 0 || m[1] !== 0 || w[3] !== 32)
    reject("marker / dropped / process count");
  if (w.slice(4, 8).some((v) => v !== 0) || m.slice(2, 8).some((v) => v !== 0))
    reject("reserved header");
  if (w.slice(8 + w[1] * 8).some((v) => v !== 0) || m.slice(8 + m[0] * 5).some((v) => v !== 0))
    reject("nonzero unused records");
  const wr = Array.from({ length: w[1] }, (_, i) => w.slice(8 + i * 8, 16 + i * 8));
  const mr = Array.from({ length: m[0] }, (_, i) => m.slice(8 + i * 5, 13 + i * 5));
  let lastFrame = 0;
  for (const [code, frame, value, version, a, b, c, d] of wr) {
    if (
      !integer(code, 1, 8) ||
      !integer(frame, lastFrame, 3968) ||
      frame % 128 !== 0 ||
      !Number.isFinite(value) ||
      !integer(version, 0, 0x7fffffff) ||
      ![a, b, c, d].every((v) => integer(v, 0, 0xffffffff))
    )
      reject("worklet record shape");
    lastFrame = frame;
    if (code <= 3 && [value, version, a, b, c, d].some((v) => v !== 0))
      reject("worklet lifecycle shape");
    if (code === 4 && (version !== 0 || a !== 0 || c !== 0 || d !== 0))
      reject("queue record shape");
    if (code === 5 && (version !== 0 || a !== 0 || d !== 0)) reject("injection record shape");
    if (code === 6 && (version !== 0 || c !== 0 || d !== 0)) reject("WASM record shape");
    if (code === 7 && (version < 1 || b > 65535 || c > 65535 || d !== 0))
      reject("publish record shape");
    if (code === 8 && d !== 0) reject("final record shape");
  }
  const finals = wr.filter((r) => r[0] === 8);
  if (finals.length !== 1 || wr.at(-1)?.[0] !== 8 || finals[0]?.[1] !== 3968)
    reject("final event8/frame3968");
  for (const [i, [code, value, version, a, seq]] of mr.entries()) {
    if (
      !integer(code, 1, 7) ||
      !Number.isFinite(value) ||
      !integer(version, 0, 0x7fffffff) ||
      a !== 0 ||
      seq !== i
    )
      reject("main record shape");
    if ([1, 5, 7].includes(code) && (value !== 0 || version !== 0)) reject("main lifecycle shape");
    if ([2, 6].includes(code) && version !== 0) reject("main scalar shape");
    if ([3, 4].includes(code) && (!integer(value, -0x80000000, 0x7fffffff) || version < 1))
      reject("main publish shape");
  }
  const observations = mr.filter((r) => r[0] === 6);
  if (
    observations.length !== 1 ||
    mr.at(-1)?.[0] !== 6 ||
    observations[0]?.[1] !== artifact.observed
  )
    reject("exactly one terminal observation");
  if (reasons.length) return incomplete();
  const bits = new Int32Array(1);
  const floats = new Float32Array(bits.buffer);
  const decode = (value) => {
    bits[0] = value;
    return floats[0];
  };
  const injections = wr.filter((r) => r[0] === 5);
  const consumptionConfirmed =
    mr.filter((r) => r[0] === 2 && r[1] === 42).length === 1 &&
    injections.length === 1 &&
    injections[0][2] === 42 &&
    wr.some(
      (r, i) =>
        r[0] === 4 && r[2] === 42 && i < wr.indexOf(injections[0]) && r[1] <= injections[0][1],
    ) &&
    wr.some(
      (r, i) =>
        r[0] === 6 &&
        i > wr.indexOf(injections[0]) &&
        r[1] === injections[0][1] &&
        r[2] === 42 &&
        r[4] === injections[0][5] &&
        r[5] === injections[0][6] + 1 &&
        r[5] === r[4],
    );
  return {
    status: "complete",
    negativeEvidenceAllowed: true,
    audioEvidenceValid: false,
    cutoff: "main observation / worklet final process only; no claim about later delivery",
    consumptionConfirmed,
    worklet: wr.map(([code, frame, value, version, a, b, c, d]) => ({
      event: namesW[code],
      frame,
      value,
      version,
      a,
      b,
      c,
      d,
      ...(code === 7 ? { publishedValue: decode((c << 16) | b) } : {}),
    })),
    main: mr.map(([code, value, version, a, seq]) => ({
      event: namesM[code],
      value,
      version,
      a,
      seq,
      ...([3, 4].includes(code) ? { publishedValue: decode(value) } : {}),
    })),
  };
}

export function decodeFile(file) {
  try {
    if (statSync(file).size > 65_536) throw new Error("capacity");
    const manifestFile = file + ".manifest.json";
    if (statSync(manifestFile).size > 16_384) throw new Error("manifest capacity");
    return decodeArtifact(
      JSON.parse(readFileSync(file, "utf8")),
      JSON.parse(readFileSync(manifestFile, "utf8")),
    );
  } catch {
    return {
      status: "incomplete",
      reasons: ["missing, unreadable, oversized or malformed artifact"],
      negativeEvidenceAllowed: false,
      consumptionConfirmed: false,
      audioEvidenceValid: false,
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = decodeFile(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "complete") process.exitCode = 1;
}
