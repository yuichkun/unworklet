import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import ExampleView from "../views/ExampleView.vue";

const { recompile, destroy, runtimeError } = vi.hoisted(() => ({
  recompile: vi.fn(),
  destroy: vi.fn(),
  runtimeError: vi.fn(),
}));
vi.mock("../composables/useUnworkletDemo.ts", async () => {
  const { ref } = await import("vue");
  return {
    useUnworkletDemo: () => {
      const failure = ref<import("./protocol.ts").EditorDiagnostic | null>(null);
      const status = ref("ready");
      runtimeError.mockImplementation(() => {
        failure.value = {
          phase: "runtime",
          severity: "error",
          code: "queue-overflow",
          message: "midi keys dropped: 2",
        };
      });
      return {
        status,
        failure,
        ready: ref(true),
        playing: ref(false),
        busy: ref(false),
        params: ref([]),
        sourceType: ref("sine"),
        freq: ref(110),
        prepare: vi.fn(),
        play: vi.fn(),
        stop: vi.fn(),
        setSource: vi.fn(),
        setFreq: vi.fn(),
        setParam: vi.fn(),
        noteOn: vi.fn(),
        noteOff: vi.fn(),
        loadFile: vi.fn(),
        destroy,
        recompile: async (source: string) => {
          await recompile(source);
          failure.value = {
            phase: "compile",
            severity: "error",
            code: "uwk-test-failure",
            message: "A located compilation failure",
            start: 0,
            length: 5,
          };
          status.value = "recompile failed";
        },
      };
    },
  };
});

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.resetAllMocks();
});
async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { template: "<div/>" } }],
  });
  const app = createApp({ render: () => h(ExampleView, { slug: "distortion" }) });
  app.use(router);
  await router.push("/");
  await router.isReady();
  app.mount(host);
  cleanup = () => {
    app.unmount();
    host.remove();
  };
  const editor = monaco.editor.getEditors().at(-1)!;
  editor.layout({ width: 800, height: 420 });
  return editor;
}

test("explicit Recompile failure shows structured details and source navigation", async () => {
  const editor = await mount();
  editor.setValue("process(() => {});");
  await nextTick();
  expect(recompile).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "↻ Recompile", exact: true }).click();
  await expect
    .element(page.getByRole("alert", { name: "Compilation and runtime errors" }))
    .toHaveTextContent("uwk-test-failure");
  expect(recompile).toHaveBeenCalledExactlyOnceWith("process(() => {});");
  expect(
    monaco.editor.getModelMarkers({ owner: "uwk-compile", resource: editor.getModel()!.uri }),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "Show Line 1, column 1" }).click();
  expect(editor.getSelection()?.startColumn).toBe(1);
  editor.setValue("process(() => { });");
  await nextTick();
  expect(
    monaco.editor.getModelMarkers({ owner: "uwk-compile", resource: editor.getModel()!.uri }),
  ).toEqual([]);
});

test("a slow compile cannot mark text edited after the request", async () => {
  let finish: (() => void) | undefined;
  recompile.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const editor = await mount();
  await page.getByRole("button", { name: "↻ Recompile", exact: true }).click();
  editor.setValue("process(() => {});");
  await nextTick();
  finish!();
  await expect
    .element(page.getByRole("alert", { name: "Compilation and runtime errors" }))
    .toHaveTextContent("A located compilation failure");
  expect(
    monaco.editor.getModelMarkers({ owner: "uwk-compile", resource: editor.getModel()!.uri }),
  ).toEqual([]);
  await expect.element(page.getByText("No current source location is available.")).toBeVisible();
});

test("closing help restores editor focus, source and undo history without compiling", async () => {
  const editor = await mount();
  const before = editor.getValue();
  editor.pushUndoStop();
  editor.executeEdits("test", [{ range: new monaco.Range(1, 1, 1, 1), text: "// local edit\n" }]);
  editor.pushUndoStop();
  const edited = editor.getValue();
  await page.getByRole("button", { name: "Sugar help", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search help" }).fill("short");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => editor.hasTextFocus()).toBe(true);
  expect(editor.getValue()).toBe(edited);
  expect(recompile).not.toHaveBeenCalled();
  editor.trigger("test", "undo", null);
  expect(editor.getValue()).toBe(before);
});

test("a later runtime event cannot inherit a failed compile's source marker", async () => {
  const editor = await mount();
  await page.getByRole("button", { name: "↻ Recompile", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Show Line 1, column 1" })).toBeVisible();
  runtimeError();
  await expect
    .element(page.getByRole("alert", { name: "Compilation and runtime errors" }))
    .toHaveTextContent("queue-overflow");
  await expect
    .element(page.getByRole("button", { name: "Show Line 1, column 1" }))
    .not.toBeInTheDocument();
  expect(
    monaco.editor.getModelMarkers({ owner: "uwk-compile", resource: editor.getModel()!.uri }),
  ).toEqual([]);
});
