import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import App from "../App.vue";
import ExampleView from "../views/ExampleView.vue";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "../style.css";

const { prepare, play, stop, recompile, destroy } = vi.hoisted(() => ({
  prepare: vi.fn(),
  play: vi.fn(),
  stop: vi.fn(),
  recompile: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("../composables/useUnworkletDemo.ts", async () => {
  const { ref } = await import("vue");
  return {
    useUnworkletDemo: () => {
      const playing = ref(false);
      return {
        status: ref("ready"),
        failure: ref(null),
        ready: ref(true),
        playing,
        busy: ref(false),
        params: ref([{ name: "drive", value: 4, min: 1, max: 20 }]),
        sourceType: ref("sine"),
        freq: ref(110),
        prepare,
        recompile,
        destroy,
        play: () => {
          playing.value = true;
          play();
        },
        stop: () => {
          playing.value = false;
          stop();
        },
        setSource: vi.fn(),
        setFreq: vi.fn(),
        setParam: vi.fn(),
        noteOn: vi.fn(),
        noteOff: vi.fn(),
        loadFile: vi.fn(),
      };
    },
  };
});

let cleanup: (() => void) | undefined;
afterEach(async () => {
  cleanup?.();
  cleanup = undefined;
  vi.clearAllMocks();
  await page.viewport(1280, 900);
});
async function mount() {
  await page.viewport(1440, 1000);
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { render: () => h("p", "Examples") } },
      { path: "/e/:slug", component: ExampleView, props: true },
    ],
  });
  const app = createApp(App).use(router);
  await router.push("/e/distortion");
  await router.isReady();
  app.mount(host);
  cleanup = () => {
    app.unmount();
    host.remove();
  };
  await nextTick();
  await document.fonts.ready;
  return { router, editor: monaco.editor.getEditors().at(-1)! };
}
const expand = () => page.getByRole("button", { name: "Expand editor", exact: true });
const restore = () => page.getByRole("button", { name: "Restore editor", exact: true });
const dialog = () => document.querySelector<HTMLDialogElement>("dialog.workbench")!;

test("expansion uses the window and preserves the model, cursor, edits, and undo across repeated restore", async () => {
  const { editor } = await mount();
  const model = editor.getModel()!;
  const source = editor.getValue();
  const before = document.querySelector(".monaco-host")!.getBoundingClientRect();
  editor.pushUndoStop();
  editor.executeEdits("test", [{ range: new monaco.Range(1, 1, 1, 1), text: "// local edit\n" }]);
  editor.pushUndoStop();
  editor.setSelection(new monaco.Selection(2, 2, 2, 8));
  const selection = editor.getSelection();
  for (let i = 0; i < 3; i++) {
    await expand().click();
    await expect.element(restore()).toHaveAttribute("aria-expanded", "true");
    expect(dialog().matches(":modal")).toBe(true);
    await expect.poll(() => editor.getLayoutInfo().width).toBeGreaterThan(before.width + 200);
    await expect.poll(() => editor.getLayoutInfo().height).toBeGreaterThan(before.height + 150);
    expect(editor.getModel()).toBe(model);
    expect(editor.getSelection()).toEqual(selection);
    expect(editor.hasTextFocus()).toBe(true);
    if (i === 0)
      await page.screenshot({
        element: dialog(),
        path: "__screenshots__/expansion/desktop-expanded.png",
      });
    await restore().click();
    expect(dialog().matches(":modal")).toBe(false);
    await expect.element(expand()).toHaveAttribute("aria-expanded", "false");
    expect(editor.getSelection()).toEqual(selection);
    expect(editor.hasTextFocus()).toBe(true);
    expect(editor.getValue()).toBe("// local edit\n" + source);
  }
  await expect.poll(() => editor.getLayoutInfo().height).toBe(420);
  await page.screenshot({ path: "__screenshots__/expansion/desktop-restored.png" });
  editor.trigger("test", "undo", null);
  expect(editor.getValue()).toBe(source);
  expect(prepare).toHaveBeenCalledOnce();
  expect(recompile).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
});

test("keyboard activation never starts audio and Escape restores editor focus", async () => {
  const { editor } = await mount();
  (expand().element() as HTMLButtonElement).focus();
  await userEvent.keyboard(" ");
  await expect.element(restore()).toBeVisible();
  expect(play).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(expand()).toBeVisible();
  await expect.poll(() => editor.hasTextFocus()).toBe(true);
  expect(document.body.style.overflow).not.toBe("hidden");
});

test("help closes before the expanded editor and restores its editor focus", async () => {
  const { editor } = await mount();
  await expand().click();
  await page.getByRole("button", { name: "API reference", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search help" }).fill("clamp");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Playground help" }))
    .not.toBeInTheDocument();
  expect(dialog().matches(":modal")).toBe(true);
  await expect.poll(() => editor.hasTextFocus()).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(expand()).toBeVisible();
});

test("completion consumes its Escape before the expanded editor closes", async () => {
  const { editor } = await mount();
  await expand().click();
  editor.setValue("audioI");
  editor.setPosition({ lineNumber: 1, column: 7 });
  await editor.getAction("editor.action.triggerSuggest")!.run();
  await expect
    .poll(() => document.querySelector(".suggest-widget.visible")?.textContent, { timeout: 30_000 })
    .toContain("audioInput");
  await userEvent.keyboard("{Escape}");
  expect(document.querySelector(".suggest-widget.visible")).toBeNull();
  expect(dialog().matches(":modal")).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(expand()).toBeVisible();
}, 40_000);

test("transport and diagnostics stay usable without resetting audio when resizing or restoring", async () => {
  const { editor } = await mount();
  await page.getByRole("button", { name: "▶ Play", exact: true }).click();
  await expand().click();
  expect(play).toHaveBeenCalledOnce();
  await expect.element(page.getByRole("button", { name: "■ Stop", exact: true })).toBeEnabled();
  editor.setValue("process(() => { missingName(); });");
  await expect
    .poll(() => document.querySelector(".source-diagnostics")?.textContent, { timeout: 30_000 })
    .toContain("missingName");
  await page
    .getByRole("button", { name: /Line 1, column/ })
    .first()
    .click();
  expect(editor.hasTextFocus()).toBe(true);
  for (const [width, height] of [
    [390, 844],
    [844, 390],
    [1440, 1000],
  ]) {
    await page.viewport(width!, height!);
    await expect.poll(() => Math.round(dialog().getBoundingClientRect().width)).toBe(width);
    await expect.poll(() => Math.round(dialog().getBoundingClientRect().height)).toBe(height);
    const host = document.querySelector(".monaco-host")!;
    await expect
      .poll(() => Math.abs(editor.getLayoutInfo().width - host.clientWidth))
      .toBeLessThan(2);
    expect(editor.getLayoutInfo().height).toBeGreaterThan(80);
    expect(dialog().scrollWidth).toBeLessThanOrEqual(dialog().clientWidth);
    await expect.element(restore()).toBeVisible();
    expect(editor.getValue()).toContain("missingName");
    await page.screenshot({
      element: dialog(),
      path: `__screenshots__/expansion/expanded-${width}x${height}.png`,
    });
  }
  await restore().click();
  expect(stop).not.toHaveBeenCalled();
  expect(prepare).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "■ Stop", exact: true }).click();
  expect(stop).toHaveBeenCalledOnce();
}, 45_000);

test("navigation while expanded releases modal and scroll state and remounts normally", async () => {
  const { editor, router } = await mount();
  const model = editor.getModel()!;
  await expand().click();
  await router.push("/");
  await nextTick();
  await expect.element(page.getByText("Examples", { exact: true })).toBeVisible();
  expect(document.querySelector("dialog:modal")).toBeNull();
  expect(document.body.style.overflow).not.toBe("hidden");
  expect(monaco.editor.getModels()).not.toContain(model);
  expect(destroy).toHaveBeenCalledOnce();
  await router.push("/e/distortion");
  await nextTick();
  await expect.element(expand()).toHaveAttribute("aria-expanded", "false");
  expect(dialog().matches(":modal")).toBe(false);
  await expand().click();
  await userEvent.keyboard("{Escape}");
  await expect.element(expand()).toBeVisible();
});

test("expanded workspace contains keyboard focus at both control boundaries", async () => {
  await mount();
  await expand().click();
  const first = page
    .getByRole("button", { name: "API reference", exact: true })
    .element() as HTMLButtonElement;
  const ranges = dialog().querySelectorAll<HTMLInputElement>('.panel input[type="range"]');
  first.focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(ranges.item(ranges.length - 1));
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(first);
});

test.each(["button", "Escape"])(
  "restoring a scrolled narrow page with %s preserves the page position",
  async (method) => {
    const { editor } = await mount();
    await page.viewport(390, 500);
    window.scrollTo({ top: 180, behavior: "instant" });
    const before = window.scrollY;
    expect(before).toBe(180);
    for (let i = 0; i < 2; i++) {
      await expand().click();
      await expect.element(restore()).toBeVisible();
      if (method === "button") await restore().click();
      else await userEvent.keyboard("{Escape}");
      await expect.element(expand()).toBeVisible();
      await expect.poll(() => window.scrollY).toBe(before);
      expect(editor.hasTextFocus()).toBe(true);
    }
  },
);
