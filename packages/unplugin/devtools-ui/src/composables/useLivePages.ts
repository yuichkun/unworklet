import { computed, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { getPanelRpc } from "../lib/rpc";
import { PAGE_SELECTION } from "./usePageState";

type Page = { id: string; title: string; url: string };
type Pages = { pages: Page[] };

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcSharedStates {
    "unworklet:pages": Pages;
  }
}

export function useLivePages() {
  const pages = ref<Page[]>([]);
  const selectedPageId = ref("");
  provide(PAGE_SELECTION, selectedPageId);
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
      const shared = await rpc.sharedState.get("unworklet:pages");
      if (!active) return;
      const apply = (value: unknown): void => {
        pages.value = (value as Pages | undefined)?.pages ?? [];
        if (!selectedPageId.value && pages.value.length) selectedPageId.value = pages.value[0]!.id;
      };
      apply(shared.value());
      unsubscribe = shared.on("updated", apply);
    };
    void connect().catch(() => {});
  });
  const selectedPage = computed(() => pages.value.find((p) => p.id === selectedPageId.value));
  return { pages, selectedPageId, selectedPage };
}
