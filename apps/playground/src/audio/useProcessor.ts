import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { audioContext, ensureRunning } from "./AudioEngine";
import { createBrowserNode, type BrowserUnworkletNode } from "./createBrowserNode";

export type UseProcessorOptions = {
  processorName: string;
  autoConnect?: boolean; // connect outputs.main to destination
};

export function useProcessor(options: UseProcessorOptions) {
  const node = shallowRef<BrowserUnworkletNode | null>(null);
  const error = ref<string | null>(null);
  const ready = ref(false);

  async function init() {
    try {
      await ensureRunning();
      const ctx = audioContext();
      const n = await createBrowserNode(ctx, options.processorName);
      node.value = n;
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
