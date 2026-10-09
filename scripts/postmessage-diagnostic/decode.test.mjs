import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeArtifact } from "./decode.mjs";

function valid() {
  const worklet = Array(128).fill(0);
  const main = Array(128).fill(0);
  const wr = [
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0, 42, 0, 0, 1],
    [5, 0, 42, 0, 0, 1, 0],
    [6, 0, 42, 0, 1, 1],
    [7, 1536, 42, 1, 64, 0, 16936, 0],
    [7, 3072, 42, 2, 0, 0, 16936, 0],
    [8, 3968, 42, 2, 0, 1, 1],
  ];
  const mr = [[1], [7], [2, 42], [3, 1109917696, 1], [4, 1109917696, 1], [5], [6, 42]];
  worklet[0] = 54124;
  worklet[1] = wr.length;
  worklet[3] = 32;
  main[0] = mr.length;
  wr.forEach((row, i) =>
    row.forEach((v, j) => {
      worklet[8 + i * 8 + j] = v;
    }),
  );
  mr.forEach((row, i) => {
    row.forEach((v, j) => {
      main[8 + i * 5 + j] = v;
    });
    main[8 + i * 5 + 4] = i;
  });
  return {
    schema: 2,
    runId: "unit-run",
    transforms: Object.fromEntries(
      ["test", "client", "worklet"].map((role) => [
        role,
        {
          role,
          runId: "unit-run",
          ambiguous: false,
          sourcePath:
            role === "test"
              ? "src/__tests__/browser/postmessage/message-counter.test.ts"
              : `src/${role}.ts`,
          sourceHash: "a".repeat(64),
          transformedHash: "b".repeat(64),
        },
      ]),
    ),
    recording: true,
    observationCaptured: true,
    observed: 42,
    markers: {
      test: "uwk-diag-test-v2:unit-run",
      client: "uwk-diag-client-v2:unit-run",
      workletHandshake: "uwk-diag-worklet-v2:unit-run",
      workletFinal: "uwk-diag-worklet-v2:unit-run",
    },
    worklet,
    main,
  };
}

await test("complete trace decodes publish bits and correlates tail movement", () => {
  const result = decodeArtifact(valid());
  assert.equal(result.status, "complete");
  assert.equal(result.worklet[6].publishedValue, 42);
  assert.equal(result.consumptionConfirmed, true);
  assert.equal(result.audioEvidenceValid, false);
});

const mutations = {
  "missing worklet": (a) => {
    a.worklet = null;
  },
  "short main": (a) => {
    a.main.pop();
  },
  "long worklet": (a) => {
    a.worklet.push(0);
  },
  "negative main count": (a) => {
    a.main[0] = -1;
  },
  "fractional worklet count": (a) => {
    a.worklet[1] = 0.5;
  },
  "NaN main count": (a) => {
    a.main[0] = NaN;
  },
  "infinite worklet count": (a) => {
    a.worklet[1] = Infinity;
  },
  "oversized main count": (a) => {
    a.main[0] = 25;
  },
  "oversized worklet count": (a) => {
    a.worklet[1] = 16;
  },
  "boolean drop": (a) => {
    a.main[1] = false;
  },
  "worklet drop": (a) => {
    a.worklet[2] = 1;
  },
  "partial process count": (a) => {
    a.worklet[3] = 31;
  },
  "missing final event": (a) => {
    a.worklet[8 + 8 * 8] = 7;
  },
  "wrong final frame": (a) => {
    a.worklet[8 + 8 * 8 + 1] = 3840;
  },
  "invalid main event": (a) => {
    a.main[8] = 9;
  },
  "invalid worklet event": (a) => {
    a.worklet[8] = 9;
  },
  "nonfinite value": (a) => {
    a.worklet[8 + 2] = NaN;
  },
  "wrong record shape": (a) => {
    a.main[8 + 4] = 99;
  },
  "missing observation": (a) => {
    a.main[8 + 6 * 5] = 5;
  },
  "duplicate observation": (a) => {
    a.main[8 + 5 * 5] = 6;
  },
  "missing transform marker": (a) => {
    a.markers.client = null;
  },
  "unfrozen observation": (a) => {
    a.observationCaptured = false;
  },
  "recording off": (a) => {
    a.recording = false;
  },
};
Object.assign(mutations, {
  "missing run ID": (a) => {
    delete a.runId;
  },
  "stale test marker": (a) => {
    a.markers.test = "uwk-diag-test-v2:another";
  },
  "stale client marker": (a) => {
    a.markers.client = "uwk-diag-client-v2:another";
  },
  "stale worklet marker": (a) => {
    a.markers.workletHandshake = "uwk-diag-worklet-v2:another";
  },
  "missing source hash": (a) => {
    delete a.transforms.client.sourceHash;
  },
  "missing transformed hash": (a) => {
    delete a.transforms.worklet.transformedHash;
  },
  "missing transform": (a) => {
    delete a.transforms.test;
  },
  "malformed transformed hash": (a) => {
    a.transforms.test.transformedHash = "bad";
  },
  "wrong transform ID": (a) => {
    a.transforms.worklet.runId = "another";
  },
  "ambiguous transform": (a) => {
    a.transforms.client.ambiguous = true;
  },
});
for (const [name, mutate] of Object.entries(mutations)) {
  await test(`${name} is incomplete and cannot support negative delivery evidence`, () => {
    const artifact = valid();
    mutate(artifact);
    const result = decodeArtifact(artifact);
    assert.equal(result.status, "incomplete");
    assert.equal(result.negativeEvidenceAllowed, false);
    assert.equal(result.consumptionConfirmed, false);
  });
}

await test("decoder rejects a trace from another manifest or a different transform", () => {
  const artifact = valid();
  const manifest = structuredClone(artifact);
  manifest.runId = "another";
  assert.equal(decodeArtifact(artifact, manifest).status, "incomplete");
  manifest.runId = artifact.runId;
  manifest.transforms.client.transformedHash = "c".repeat(64);
  assert.equal(decodeArtifact(artifact, manifest).status, "incomplete");
});

await test("WASM return without tail advance does not confirm consumption", () => {
  const artifact = valid();
  artifact.worklet[8 + 5 * 8 + 5] = 0;
  assert.equal(decodeArtifact(artifact).consumptionConfirmed, false);
});

await test("tail advance without expected live value does not confirm consumption", () => {
  const artifact = valid();
  artifact.worklet[8 + 5 * 8 + 2] = 0;
  assert.equal(decodeArtifact(artifact).consumptionConfirmed, false);
});
