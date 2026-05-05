import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { audioContext, ensureRunning } from "./AudioEngine";
import { createWasmNode, type WasmUnworkletNode } from "./createWasmNode";
import { processorRegistry } from "./registry";

// Public type kept stable for views — the WASM-backed node has a similar
// shape to the previous JS-interpreter-backed BrowserUnworkletNode.
export type PlaygroundNode = WasmUnworkletNode & {
  // Provide a __engine compatibility shim so views that read the legacy
  // BrowserUnworkletNode.__engine field don't break (they fall back to noop).
  __engine?: any;
};

export type UseProcessorOptions = {
  processorName: string;
  autoConnect?: boolean;
};

export function useProcessor(options: UseProcessorOptions) {
  const node = shallowRef<PlaygroundNode | null>(null);
  const error = ref<string | null>(null);
  const ready = ref(false);

  async function init() {
    try {
      await ensureRunning();
      const ctx = audioContext();
      const processor = processorRegistry[options.processorName];
      if (!processor) {
        error.value = `Unknown processor: ${options.processorName}`;
        return;
      }
      const n = await createWasmNode(ctx, processor, options.processorName);
      node.value = n as PlaygroundNode;
      if (options.autoConnect !== false && n.outputs.main) {
        n.outputs.main.connect(ctx.destination);
      }
      ready.value = true;
    } catch (e: any) {
      console.error(e);
      error.value = String(e?.message ?? e);
    }
  }

  onMounted(init);
  onBeforeUnmount(() => {
    node.value?.dispose();
  });

  return { node, error, ready };
}
