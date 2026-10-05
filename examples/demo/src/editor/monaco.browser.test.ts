import { afterEach, expect, test } from "vite-plus/test";
import { createApp, h, nextTick, ref } from "vue";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import MonacoEditor from "../components/MonacoEditor.vue";
import type { EditorDiagnostic } from "./protocol.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
});
function mount(source: string) {
  const host = document.createElement("div");
  host.style.cssText = "width:1000px;height:600px";
  document.body.append(host);
  const text = ref(source);
  let diagnostics: EditorDiagnostic[] = [];
  let status = "";
  const app = createApp({
    render: () =>
      h(MonacoEditor, {
        modelValue: text.value,
        "onUpdate:modelValue": (value: string) => {
          text.value = value;
        },
        onDiagnostics: (items: EditorDiagnostic[], value: string) => {
          diagnostics = items;
          status = value;
        },
      }),
  });
  app.mount(host);
  (host.firstElementChild as HTMLElement).style.height = "550px";
  const editor =
    monaco.editor
      .getEditors()
      .find((candidate) => candidate.getDomNode()?.parentElement?.parentElement === host) ??
    monaco.editor.getEditors().at(-1)!;
  editor.layout({ width: 1000, height: 550 });
  const dispose = () => {
    app.unmount();
    host.remove();
  };
  cleanups.push(dispose);
  return { editor, text, diagnostics: () => diagnostics, status: () => status, dispose };
}

test("actual Monaco accepts a source completion, shows sugar hover and call signature", async () => {
  const { editor } = mount("audioI");
  editor.focus();
  editor.setPosition({ lineNumber: 1, column: 7 });
  await editor.getAction("editor.action.triggerSuggest")!.run();
  await expect
    .poll(() => document.querySelector(".suggest-widget.visible")?.textContent, { timeout: 30_000 })
    .toContain("audioInput");
  editor.trigger("test", "acceptSelectedSuggestion", {});
  expect(editor.getValue()).toBe("audioInput");
  const source =
    'const input = audioInput({ channels: 2 }); const gain = param.f32({ default: 1, min: 0, max: 2, automationRate: "a-rate" }); process(() => { forSample((i) => { const l = input.left[i] * gain[i]; }); });';
  editor.setValue(source);
  editor.setPosition(editor.getModel()!.getPositionAt(source.indexOf("const l") + 6));
  editor.revealPositionInCenter(editor.getPosition()!);
  await editor.getAction("editor.action.showHover")!.run();
  await expect
    .poll(() => document.querySelector(".monaco-hover")?.textContent, { timeout: 20_000 })
    .toContain('Node<"f32">');
  editor.setValue("clamp(f32(0), ");
  editor.setPosition({ lineNumber: 1, column: 15 });
  await editor.getAction("editor.action.triggerParameterHints")!.run();
  await expect
    .poll(() => document.querySelector(".parameter-hints-widget.visible")?.textContent, {
      timeout: 20_000,
    })
    .toContain("clamp");
}, 60_000);

test("editing diagnoses, fixes and clears errors without stale markers after remount", async () => {
  const first = mount("process(() => { missingName(); });");
  const model = first.editor.getModel()!;
  await expect
    .poll(() => first.diagnostics().some((d) => d.message.includes("missingName")), {
      timeout: 30_000,
    })
    .toBe(true);
  expect(monaco.editor.getModelMarkers({ resource: model.uri }).length).toBeGreaterThan(0);
  first.editor.setValue("process(() => { anotherMissing(); });");
  first.editor.setValue("process(() => {});");
  await expect
    .poll(() => first.status(), { timeout: 20_000 })
    .toBe("No static issues. Recompile to apply changes.");
  expect(monaco.editor.getModelMarkers({ resource: model.uri })).toEqual([]);
  first.editor.setValue("process(() => { staleExample(); });");
  first.dispose();
  cleanups.pop();
  const second = mount("process(() => {});");
  await nextTick();
  await expect
    .poll(() => second.status(), { timeout: 30_000 })
    .toBe("No static issues. Recompile to apply changes.");
  expect(monaco.editor.getModels()).not.toContain(model);
  expect(monaco.editor.getModelMarkers({ resource: second.editor.getModel()!.uri })).toEqual([]);
}, 60_000);
