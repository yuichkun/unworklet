<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import signatures from "virtual:uwk-help-signatures";
import { apiEntries, filterEntries, sugarEntries } from "../help/catalog.ts";
import type { HelpEntry } from "../help/types.ts";

const props = defineProps<{ initialTab: "api" | "sugar" }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const search = ref<HTMLInputElement>();
const tab = ref(props.initialTab);
const query = ref("");
const category = ref("all");
const selectedId = ref("");
const copyStatus = ref("");
const buildLabel = __DEMO_BUILD_LABEL__;
const entries = computed<HelpEntry[]>(() => (tab.value === "api" ? apiEntries : sugarEntries));
const categories = computed(() => [...new Set(entries.value.map((entry) => entry.category))]);
const filtered = computed(() => filterEntries(entries.value, query.value, category.value));
const selected = computed(
  () => filtered.value.find((entry) => entry.id === selectedId.value) ?? filtered.value[0],
);
const api = computed(() =>
  tab.value === "api" ? apiEntries.find((entry) => entry.id === selected.value?.id) : undefined,
);
const sugar = computed(() =>
  tab.value === "sugar" ? sugarEntries.find((entry) => entry.id === selected.value?.id) : undefined,
);

watch(
  () => selected.value?.id,
  () => {
    copyStatus.value = "";
  },
);
onMounted(() => {
  dialog.value!.showModal();
  search.value!.focus();
});
onBeforeUnmount(() => {
  dialog.value!.close();
});

function dialogKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    // Search inputs otherwise consume Escape to clear their value.
    event.preventDefault();
    event.stopPropagation();
    emit("close");
    return;
  }
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  const controls = [
    ...dialog.value!.querySelectorAll<HTMLElement>(
      "button, a[href], input, select, textarea, [tabindex]",
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden",
  );
  const first = controls[0]!;
  const last = controls.at(-1)!;
  // Native dialog focus can leave an embedded document at its boundaries.
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function changeTab(value: "api" | "sugar") {
  tab.value = value;
  query.value = "";
  category.value = "all";
  selectedId.value = "";
  copyStatus.value = "";
}

async function tabKey(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  changeTab(
    event.key === "Home"
      ? "api"
      : event.key === "End"
        ? "sugar"
        : tab.value === "api"
          ? "sugar"
          : "api",
  );
  await nextTick();
  dialog.value!.querySelector<HTMLButtonElement>(`#help-tab-${tab.value}`)!.focus();
}

async function copyExample() {
  const entry = selected.value!;
  try {
    await navigator.clipboard.writeText(entry.example);
    if (selected.value?.id === entry.id) copyStatus.value = "Example copied.";
  } catch {
    if (selected.value?.id === entry.id)
      copyStatus.value = "Copy unavailable. Select the example below and copy it manually.";
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="playground-help"
    aria-labelledby="help-title"
    aria-describedby="help-scope"
    @cancel.prevent="emit('close')"
    @keydown="dialogKey"
  >
    <header class="help-header">
      <div>
        <h2 id="help-title">Playground help</h2>
        <p class="help-version">{{ buildLabel }}</p>
      </div>
      <button type="button" class="btn" aria-label="Close help" @click="emit('close')">
        Close <span aria-hidden="true">Esc</span>
      </button>
    </header>
    <p id="help-scope" class="help-scope">
      Single-file .uwk.ts authoring. DSL names are ambient; external-file imports and SIMD are not
      available here. Reference types come from this build’s ambient/core declarations.
    </p>
    <div class="help-tabs" role="tablist" aria-label="Help sections" @keydown="tabKey">
      <button
        id="help-tab-api"
        type="button"
        role="tab"
        :aria-selected="tab === 'api'"
        :tabindex="tab === 'api' ? 0 : -1"
        aria-controls="help-panel"
        @click="changeTab('api')"
      >
        API reference
      </button>
      <button
        id="help-tab-sugar"
        type="button"
        role="tab"
        :aria-selected="tab === 'sugar'"
        :tabindex="tab === 'sugar' ? 0 : -1"
        aria-controls="help-panel"
        @click="changeTab('sugar')"
      >
        Sugar guide
      </button>
    </div>
    <div id="help-panel" class="help-panel" role="tabpanel" :aria-labelledby="`help-tab-${tab}`">
      <div class="help-filters">
        <label class="help-search"
          >Search by name or purpose
          <input
            ref="search"
            v-model="query"
            type="search"
            aria-label="Search help"
            placeholder="Try clamp, delay, or short-circuit"
            autocomplete="off"
          />
        </label>
        <label
          >Category
          <select v-model="category" aria-label="Help category">
            <option value="all">All categories</option>
            <option v-for="item in categories" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
      </div>
      <div class="help-content">
        <nav class="help-index" aria-label="Reference entries">
          <p class="help-count" aria-live="polite">
            {{ filtered.length }} {{ filtered.length === 1 ? "entry" : "entries" }}
          </p>
          <ul>
            <li v-for="entry in filtered" :key="entry.id">
              <button
                type="button"
                :aria-current="selected?.id === entry.id ? 'true' : undefined"
                @click="selectedId = entry.id"
              >
                {{ entry.name }}
              </button>
            </li>
          </ul>
        </nav>
        <article
          v-if="selected"
          :key="selected.id"
          class="help-detail"
          aria-label="Selected help entry"
        >
          <p class="help-category">
            {{ selected.category }}<span v-if="api"> · {{ api.scope }}</span>
          </p>
          <h3>{{ selected.name }}</h3>
          <p>{{ selected.summary }}</p>
          <section v-if="api" aria-label="Current signatures">
            <h4>Arguments and return type</h4>
            <p v-if="api.scope === 'Member'" class="help-note">
              Shown on a representative handle. The receiver determines its scalar type.
            </p>
            <div
              v-for="(signature, index) in signatures[api.id]"
              :key="index"
              class="help-signature"
            >
              <pre tabindex="0"><code>{{ signature.label }}</code></pre>
              <a :href="signature.source" target="_blank" rel="noopener noreferrer"
                >Declaration source ↗</a
              >
            </div>
          </section>
          <section aria-label="Usage and constraints">
            <h4>Where and how to use it</h4>
            <ul>
              <li v-for="detail in selected.details" :key="detail">{{ detail }}</li>
            </ul>
          </section>
          <section v-if="sugar" aria-label="Sugar translation">
            <h4>Written in .uwk.ts</h4>
            <pre tabindex="0"><code>{{ sugar.before }}</code></pre>
            <h4>Core operations after lowering</h4>
            <p class="help-note">Relevant fragments from this example’s real lower() output.</p>
            <pre tabindex="0"><code>{{ sugar.after.join('\n') }}</code></pre>
            <a :href="sugar.reference" target="_blank" rel="noopener noreferrer"
              >Lowering source ↗</a
            >
          </section>
          <section aria-label="Complete processor example">
            <div class="help-example-heading">
              <h4>Complete Playground example</h4>
              <button type="button" class="btn" @click="copyExample">Copy example</button>
            </div>
            <p class="help-note">
              Includes declarations, process, and a main output. Choose where to paste it; your
              current source stays as it is.
            </p>
            <p class="help-copy-status" role="status">{{ copyStatus }}</p>
            <pre tabindex="0" aria-label="Example source"><code>{{ selected.example }}</code></pre>
          </section>
        </article>
        <p v-else class="help-empty" role="status">
          No matching entries. Try another name or purpose.
        </p>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.playground-help {
  width: min(1000px, calc(100vw - 2rem));
  height: min(820px, calc(100dvh - 2rem));
  max-width: none;
  max-height: none;
  margin: auto;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--surface);
  color: var(--fg);
  overflow: hidden;
}
.playground-help[open] {
  display: flex;
  flex-direction: column;
}
.playground-help::backdrop {
  background: rgb(15 23 42 / 45%);
}
.help-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.25rem 0.5rem;
}
.help-header h2 {
  font-size: 1.25rem;
}
.help-header button {
  white-space: nowrap;
}
.help-header button span {
  margin-left: 0.5rem;
  color: var(--muted);
  font-size: 0.75rem;
}
.help-version,
.help-scope,
.help-note,
.help-count {
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.5;
}
.help-version {
  margin: 0.15rem 0 0;
}
.help-scope {
  padding: 0 1.25rem;
  margin: 0 0 0.75rem;
}
.help-tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0 1.25rem;
  border-bottom: 1px solid var(--line);
}
.help-tabs button {
  padding: 0.65rem 0.85rem;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  font: inherit;
  color: var(--fg-secondary);
  cursor: pointer;
}
.help-tabs button[aria-selected="true"] {
  border-bottom-color: var(--link);
  color: var(--link);
}
.help-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.help-filters {
  display: flex;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--line);
}
.help-filters label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--fg-secondary);
}
.help-search {
  flex: 1;
  min-width: 0;
}
.help-filters input,
.help-filters select {
  min-width: 0;
  width: 100%;
  padding: 0.5rem 0.65rem;
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  font: inherit;
  font-size: 0.875rem;
}
.help-content {
  display: grid;
  grid-template-columns: minmax(170px, 25%) minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.help-index {
  overflow: auto;
  border-right: 1px solid var(--line);
  padding: 0.5rem;
}
.help-count {
  margin: 0.25rem 0.5rem 0.5rem;
}
.help-index ul {
  padding: 0;
  margin: 0;
  list-style: none;
}
.help-index button {
  display: block;
  width: 100%;
  padding: 0.45rem 0.6rem;
  text-align: left;
  background: transparent;
  color: var(--fg-secondary);
  border: 1px solid transparent;
  border-radius: var(--radius);
  font: inherit;
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.help-index button:hover {
  background: var(--surface-hover);
}
.help-index button[aria-current="true"] {
  border-color: var(--line-strong);
  background: var(--surface-hover);
  color: var(--link);
}
.help-detail {
  padding: 1rem 1.25rem 2rem;
  overflow: auto;
  min-width: 0;
  font-size: 0.875rem;
  line-height: 1.65;
}
.help-detail h3 {
  font-size: 1.15rem;
  overflow-wrap: anywhere;
}
.help-detail h4 {
  margin: 1.1rem 0 0.4rem;
  font-size: 0.875rem;
}
.help-detail ul {
  padding-left: 1.15rem;
}
.help-detail li + li {
  margin-top: 0.5rem;
}
.help-category {
  margin: 0 0 0.3rem;
  font-size: 0.75rem;
  color: var(--muted);
}
.help-detail pre {
  margin: 0.4rem 0;
  padding: 0.75rem;
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: auto;
  font-size: 0.75rem;
  line-height: 1.6;
  tab-size: 2;
}
.help-signature pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.help-signature a,
.help-detail section > a {
  font-size: 0.75rem;
}
.help-example-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.help-example-heading .btn {
  white-space: nowrap;
}
.help-copy-status {
  margin: 0.25rem 0;
  font-size: 0.75rem;
  color: var(--fg-secondary);
}
.help-empty {
  padding: 1rem 1.25rem;
  font-size: 0.875rem;
}
button:focus-visible,
input:focus-visible,
select:focus-visible,
pre:focus-visible,
a:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
@media (max-width: 600px) {
  .playground-help {
    width: calc(100vw - 1rem);
    height: calc(100dvh - 1rem);
  }
  .help-header,
  .help-filters {
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }
  .help-scope {
    padding: 0 0.75rem;
  }
  .help-tabs {
    padding: 0 0.5rem;
  }
  .help-filters {
    flex-direction: column;
    gap: 0.4rem;
  }
  .help-content {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(70px, 24%) minmax(0, 1fr);
  }
  .help-index {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .help-index ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
  }
  .help-index button {
    width: auto;
  }
  .help-detail {
    padding: 0.75rem;
  }
}
</style>
