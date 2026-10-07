import { inject, onBeforeUnmount, onMounted, ref, type Ref } from "vue";
import { getPanelRpc, type PanelRpc } from "../lib/rpc";

export type PageSnapshots<T> = { pages: Record<string, T> };
export const PAGE_SELECTION = "unworklet:page-id";

export function usePageState<T>(
  key: string,
  apply: (value: T | undefined) => void,
  connected?: (rpc: PanelRpc) => void,
): string {
  // A remount freezes the owner of held-note releases while the selector changes.
  const pageId = inject<Ref<string>>(PAGE_SELECTION, ref("")).value;
  let active = true;
  let unsubscribe: (() => void) | undefined;
  onBeforeUnmount(() => {
    active = false;
    unsubscribe?.();
  });
  onMounted(() => {
    const connect = async (): Promise<void> => {
      const rpc = await getPanelRpc();
      if (!active) return;
      const shared = await rpc.sharedState.get<PageSnapshots<T>>(key);
      if (!active) return;
      connected?.(rpc);
      let previous: unknown = Symbol();
      const update = (value: unknown): void => {
        const next = (value as PageSnapshots<T> | undefined)?.pages?.[pageId];
        // Shared-state patches preserve untouched pages; their updates must not add history samples.
        if (next === previous) return;
        previous = next;
        apply(next);
      };
      update(shared.value());
      unsubscribe = shared.on("updated", update);
    };
    void connect().catch(() => {});
  });
  return pageId;
}
