import { renderOffline } from "../../../../../offline/src/index.ts";
import { saw } from "./saw.processor.ts";
import { stereoGain } from "./stereo-gain.processor.ts";
import { crossrealmStateful } from "./crossrealm-stateful.processor.ts";
import {
  CROSSREALM_SAMPLES,
  crossRealmInputs,
  crossRealmGainSamples,
  observeCrossRealm,
  type CrossRealmCase,
  type CrossRealmEvent,
} from "./crossrealm-observation.ts";

export async function renderCrossRealmOracle(
  name: CrossRealmCase,
  sampleRate: number,
  gainSamples?: number[],
) {
  const inputs = crossRealmInputs(name);
  const result = await renderOffline(
    { saw, stereo: stereoGain, "automated-stereo": stereoGain, stateful: crossrealmStateful }[name],
    {
      sampleRate,
      duration: CROSSREALM_SAMPLES / sampleRate,
      inputs: { main: inputs },
      params:
        name === "automated-stereo"
          ? { gain: gainSamples ?? crossRealmGainSamples() }
          : name === "stereo"
            ? { gain: [0.5] }
            : {},
    },
  );
  if (result.diagnostics.scrubbedSamples !== 0)
    throw new Error("cross-realm oracle scrubbed output");
  return observeCrossRealm(
    result.outputs.main!,
    result.events.map((event) => ({
      name: event.name,
      atSample: event.atSample,
      payload: Object.fromEntries(
        Object.entries(event.payload as Record<string, number | Float32Array>).map(
          ([key, value]) => [key, typeof value === "number" ? value : Array.from(value)],
        ),
      ),
    })) as CrossRealmEvent[],
    result.state,
  );
}
