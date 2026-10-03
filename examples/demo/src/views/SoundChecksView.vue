<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { soundChecks, type SoundCheck } from "../sound-checks.ts";
import { createWavLoader } from "../sound-check-loader.ts";
import { compareWav, type Wav } from "../wav.ts";

const urls = import.meta.glob<string>("../__goldens__/*.wav", {
  query: "?url",
  import: "default",
  eager: true,
});
type Status = "loading" | "Changed" | "New" | "Error" | "Same";
type Row = SoundCheck & { status: Status; build?: Wav; reference?: Wav; error?: string };
const rows = ref<Row[]>([]);
const selected = ref<"latest" | "main">("latest");
const reference = ref("");
const notice = ref("");
const onlyChanged = ref(false);
const playing = ref<{ slug: string; side: "ref" | "build" } | null>(null);
const playbackError = ref("");
const loadWav = createWavLoader();
const lifetime = new AbortController();
const builds = new Map<string, Promise<{ wav?: Wav; error?: string }>>();
let comparison: AbortController | undefined;
let generation = 0;
let playGeneration = 0;
let context: AudioContext | undefined;
let source: AudioBufferSourceNode | undefined;
let disposed = false;

const order: Record<Status, number> = { Changed: 0, New: 1, Error: 2, Same: 3, loading: 4 };
const shown = computed(() =>
  rows.value
    .filter((row) => !onlyChanged.value || row.status === "Changed")
    .sort((a, b) => order[a.status] - order[b.status]),
);
const counts = computed(() =>
  Object.fromEntries(
    ["Changed", "New", "Same", "Error", "loading"].map((status) => [
      status,
      rows.value.filter((row) => row.status === status).length,
    ]),
  ),
);
const errorText = (error: unknown) => (error instanceof Error ? error.message : "network error");

function buildFor(slug: string) {
  if (!builds.has(slug)) {
    const url = urls[`../__goldens__/${slug}.wav`];
    builds.set(
      slug,
      url
        ? loadWav(url, lifetime.signal).then(
            (wav) => (wav ? { wav } : { error: "HTTP 404 (this build)" }),
            (error: unknown) => ({ error: errorText(error) }),
          )
        : Promise.resolve({ error: "Missing WAV in this build" }),
    );
  }
  return builds.get(slug)!;
}

function stop() {
  playGeneration++;
  if (source) {
    source.onended = null;
    source.stop();
    source.disconnect();
    source = undefined;
  }
  playing.value = null;
}

async function play(row: Row, side: "ref" | "build") {
  stop();
  playbackError.value = "";
  const wav = side === "ref" ? row.reference : row.build;
  if (!wav) return;
  const current = playGeneration;
  try {
    context ??= new AudioContext();
    await context.resume();
    if (disposed || current !== playGeneration) return;
    const buffer = new AudioBuffer({
      length: wav.channels[0]!.length,
      numberOfChannels: wav.channels.length,
      sampleRate: wav.sampleRate,
    });
    wav.channels.forEach((channel, i) => buffer.copyToChannel(new Float32Array(channel), i));
    const next = context.createBufferSource();
    next.buffer = buffer;
    next.connect(context.destination);
    next.onended = () => {
      next.disconnect();
      if (source === next) {
        source = undefined;
        playing.value = null;
      }
    };
    source = next;
    next.start();
    playing.value = { slug: row.slug, side };
  } catch (error) {
    if (!disposed && current === playGeneration) {
      stop();
      playbackError.value = `Couldn't play ${row.slug}: ${errorText(error)}`;
    }
  }
}

async function selectRef(choice: "latest" | "main") {
  stop();
  playbackError.value = "";
  comparison?.abort();
  comparison = new AbortController();
  const signal = comparison.signal;
  const current = ++generation;
  const stale = () => disposed || current !== generation;
  selected.value = choice;
  notice.value = "";
  reference.value = choice === "main" ? "main" : "";
  rows.value = soundChecks.map((check) => ({ ...check, status: "loading" }));
  let refName = "main";
  if (choice === "latest") {
    try {
      const response = await fetch(
        "https://api.github.com/repos/yuichkun/unworklet/releases/latest",
        { signal, mode: "cors" },
      );
      if (response.status !== 200) throw new Error(String(response.status));
      const release: unknown = await response.json();
      if (
        !release ||
        typeof release !== "object" ||
        !("tag_name" in release) ||
        typeof release.tag_name !== "string" ||
        !release.tag_name.trim()
      )
        throw new Error("invalid response");
      refName = release.tag_name;
    } catch (error) {
      if (stale()) return;
      const reason = error instanceof TypeError ? "network error" : errorText(error);
      notice.value = `Couldn't read the latest release from GitHub (${reason}). Comparing with main.`;
      selected.value = "main";
    }
  }
  if (stale()) return;
  reference.value = refName;
  await Promise.all(
    soundChecks.map(async (check, index) => {
      const build = await buildFor(check.slug);
      if (stale()) return;
      const row: Row = { ...check, status: "loading", build: build.wav };
      rows.value[index] = row;
      if (build.error) {
        rows.value[index] = { ...row, status: "Error", error: build.error };
        return;
      }
      try {
        const previous = await loadWav(
          `https://raw.githubusercontent.com/yuichkun/unworklet/${encodeURIComponent(refName)}/examples/demo/src/__goldens__/${check.slug}.wav`,
          signal,
        );
        if (stale()) return;
        rows.value[index] = {
          ...row,
          reference: previous ?? undefined,
          status: previous ? (compareWav(build.wav!, previous, 1e-5) ? "Same" : "Changed") : "New",
        };
      } catch (error) {
        if (!stale()) rows.value[index] = { ...row, status: "Error", error: errorText(error) };
      }
    }),
  );
}

onMounted(() => {
  void selectRef("latest");
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  stop();
  comparison?.abort();
  lifetime.abort();
  void context?.close().catch(() => {});
});
</script>

<template>
  <section class="hero">
    <h1 class="headline">Sound checks</h1>
    <p class="subhead">
      One second of sound for every DSP operation and demo example. Compare this build with another
      version and listen to what changed.
    </p>
  </section>
  <div class="toolbar">
    <div class="filters" aria-label="Comparison version">
      <button
        :class="{ active: selected === 'latest' }"
        :aria-pressed="selected === 'latest'"
        @click="selectRef('latest')"
      >
        Latest release
      </button>
      <button
        :class="{ active: selected === 'main' }"
        :aria-pressed="selected === 'main'"
        @click="selectRef('main')"
      >
        main
      </button>
    </div>
    <span class="muted">{{
      reference ? `Comparing with ${reference}` : "Finding latest release…"
    }}</span>
    <label><input v-model="onlyChanged" type="checkbox" /> Only changed</label>
  </div>
  <p v-if="notice" role="status">{{ notice }}</p>
  <p v-if="playbackError" role="alert">{{ playbackError }}</p>
  <p v-if="counts.loading" class="muted" role="status">
    Loading {{ soundChecks.length - counts.loading }} of {{ soundChecks.length }}…
  </p>
  <p role="status">
    {{ counts.Changed }} changed · {{ counts.New }} new · {{ counts.Same }} same ·
    {{ counts.Error }} errors
  </p>
  <div class="check-list">
    <article
      v-for="row in shown"
      :key="row.slug"
      class="check-row"
      :data-slug="row.slug"
      :data-status="row.status"
      :data-playing="playing?.slug === row.slug ? playing.side : undefined"
    >
      <div class="check-description">
        <strong class="mono">{{ row.slug }}</strong>
        <span class="tag">{{ row.group }}</span>
        <span class="tag">{{ row.status === "loading" ? "Loading…" : row.status }}</span>
        <p class="muted">{{ row.exercises }}</p>
        <p v-if="row.error" role="status">{{ row.error }}</p>
      </div>
      <div class="filters check-controls">
        <button
          :disabled="!row.reference || row.status === 'Error'"
          :aria-label="`Play ${row.slug} from ${reference || 'reference'}`"
          @click="play(row, 'ref')"
        >
          ▶ {{ reference || "Reference" }}
        </button>
        <button
          :disabled="!row.build"
          :aria-label="`Play ${row.slug} from this build`"
          @click="play(row, 'build')"
        >
          ▶ This build
        </button>
        <button :aria-label="`Stop ${row.slug}`" @click="stop">■ Stop</button>
      </div>
    </article>
  </div>
  <p v-if="onlyChanged && !shown.length && !counts.loading" class="muted">No changed sounds.</p>
</template>

<style scoped>
.check-list {
  margin: 1.5rem 0 4rem;
}
.check-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.25rem 0;
  border-bottom: 1px solid var(--border, #e2e8f0);
}
.check-description {
  min-width: 0;
}
.check-description > .tag {
  margin-left: 0.5rem;
}
.check-description p {
  margin: 0.5rem 0 0;
}
.check-controls {
  flex-wrap: wrap;
  flex-shrink: 0;
}
.check-row[data-playing] {
  border-left: 3px solid currentColor;
  padding-left: 1rem;
}
@media (max-width: 760px) {
  .check-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.75rem;
  }
}
</style>
