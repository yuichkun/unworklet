import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";

// Monaco worker setup. Without this, gen~'s code editor falls back to the
// main-thread tokenizer (slow + no IntelliSense). Vite's `?worker` suffix
// builds each as a Web Worker bundle.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

createApp(App).mount("#app");
