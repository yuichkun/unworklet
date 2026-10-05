import { nextTick, onScopeDispose, ref } from "vue";
import type { Ref } from "vue";

export function useExpandedEditor(
  dialog: Ref<HTMLDialogElement | undefined>,
  focusEditor: () => void,
) {
  const expanded = ref(false);
  let disposed = false;
  let overflow = "";
  let priority = "";

  function restoreScroll(): void {
    dialog.value!.ownerDocument.body.style.setProperty("overflow", overflow, priority);
  }

  async function restore(): Promise<void> {
    if (!expanded.value) return;
    expanded.value = false;
    dialog.value!.close();
    dialog.value!.show();
    restoreScroll();
    await nextTick();
    if (!disposed) focusEditor();
  }

  async function toggle(): Promise<void> {
    if (expanded.value) return restore();
    const element = dialog.value!;
    const style = element.ownerDocument.body.style;
    overflow = style.getPropertyValue("overflow");
    priority = style.getPropertyPriority("overflow");
    // An open nonmodal dialog must close before entering the top layer.
    element.close();
    element.showModal();
    expanded.value = true;
    style.setProperty("overflow", "hidden");
    await nextTick();
    if (!disposed) focusEditor();
  }

  function containFocus(event: KeyboardEvent): void {
    if (
      !expanded.value ||
      event.defaultPrevented ||
      event.key !== "Tab" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
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
    const active = dialog.value!.ownerDocument.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onScopeDispose(() => {
    disposed = true;
    if (expanded.value) {
      restoreScroll();
      dialog.value!.close();
      expanded.value = false;
    }
  });

  return { expanded, toggle, restore, containFocus };
}
