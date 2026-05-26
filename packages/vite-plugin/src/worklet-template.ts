/**
 * Emit the worklet runtime entry source (= the JS that becomes
 * `<processor>.worklet.js` and is loaded via `audioWorklet.addModule(url)`
 * in the AudioWorkletGlobalScope realm)。
 *
 * `01-dsl.md` §11 + Q80 + `04-worklet-runtime.md` §2 で 規 定 さ れ た 通 り、
 * template は user source を 再 import (= worklet realm 内 で 新 規 closure を
 * 生 成) し、 `class extends AudioWorkletProcessor` の 中 で `def.worklet` の 3
 * entry (= `initialize` / `process` / `parameterDescriptors`) を 共 通 基 盤 と
 * し て 呼 び 出 す。 関 数 本 体 自 体 は 一 切 stringify せ ず、 import 経 由
 * で 取 り 出 す。
 *
 * Live coding path (= bundler 不 在) で も 同 一 shape の 文 字 列 を runtime
 * 側 で 組 み 立 て て Blob URL に 変 換 す る = template 自 体 は bundler /
 * runtime の 両 path で 共 通 化 で きる helper。
 */

export type EmitWorkletTemplateOptions = {
  /** Absolute path to the user's processor source file (= ES module import target). */
  userSourcePath: string;
  /** Name of the `defineProcessor(...)` value exported from the user source. */
  processorExportName: string;
  /** Identifier passed to `registerProcessor(...)` (= main-side `processorName`). */
  processorName: string;
};

export function emitWorkletTemplate(options: EmitWorkletTemplateOptions): string {
  const { userSourcePath, processorExportName, processorName } = options;
  return `import { ${processorExportName} as __unworkletProcessor } from ${JSON.stringify(userSourcePath)};

class UnworkletProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return __unworkletProcessor.worklet.parameterDescriptors;
  }
  constructor(opts) {
    super();
    __unworkletProcessor.worklet.initialize(this, opts);
  }
  process(inputs, outputs, parameters) {
    return __unworkletProcessor.worklet.process(this, inputs, outputs, parameters);
  }
}

registerProcessor(${JSON.stringify(processorName)}, UnworkletProcessor);
`;
}
