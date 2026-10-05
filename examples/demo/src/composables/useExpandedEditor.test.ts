import { afterEach, expect, test, vi } from "vite-plus/test";
import { effectScope, nextTick, ref } from "vue";
import { useExpandedEditor } from "./useExpandedEditor.ts";

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);

function setup(overflow = "auto", priority = "important") {
  let value = overflow;
  let importance = priority;
  let modal = false;
  const style = {
    getPropertyValue: () => value,
    getPropertyPriority: () => importance,
    setProperty: vi.fn((_name: string, next: string, nextPriority = "") => {
      value = next;
      importance = nextPriority;
    }),
  };
  const dialog = {
    open: true,
    ownerDocument: { body: { style } },
    close: vi.fn(() => {
      dialog.open = false;
      modal = false;
    }),
    show: vi.fn(() => {
      dialog.open = true;
    }),
    showModal: vi.fn(() => {
      if (dialog.open && !modal) throw new Error("InvalidStateError");
      dialog.open = true;
      modal = true;
    }),
  };
  const focus = vi.fn();
  const scope = effectScope();
  cleanups.push(() => scope.stop());
  const state = scope.run(() =>
    useExpandedEditor(ref(dialog as unknown as HTMLDialogElement), focus),
  )!;
  return { ...state, dialog, focus, scope, overflow: () => value, priority: () => importance };
}

test("promotes the existing nonmodal dialog without an invalid open-state transition", async () => {
  const view = setup();
  expect(view.expanded.value).toBe(false);
  await view.toggle();
  expect(view.expanded.value).toBe(true);
  expect(view.dialog.close).toHaveBeenCalledOnce();
  expect(view.dialog.showModal).toHaveBeenCalledOnce();
  expect(view.overflow()).toBe("hidden");
  expect(view.focus).toHaveBeenCalledOnce();
});

test("repeated expansion and restore preserve the original scroll style and editor focus", async () => {
  const view = setup();
  for (let i = 0; i < 3; i++) {
    await view.toggle();
    await view.restore();
    expect(view.expanded.value).toBe(false);
    expect(view.dialog.open).toBe(true);
    expect(view.overflow()).toBe("auto");
    expect(view.priority()).toBe("important");
  }
  expect(view.dialog.showModal).toHaveBeenCalledTimes(3);
  expect(view.dialog.show).toHaveBeenCalledTimes(3);
  expect(view.focus).toHaveBeenCalledTimes(6);
  await view.restore();
  expect(view.focus).toHaveBeenCalledTimes(6);
});

test("disposal while expanded restores scrolling without refocusing or reopening disposed content", async () => {
  const view = setup("");
  const pending = view.toggle();
  view.scope.stop();
  await pending;
  expect(view.expanded.value).toBe(false);
  expect(view.overflow()).toBe("");
  expect(view.dialog.open).toBe(false);
  expect(view.dialog.show).not.toHaveBeenCalled();
  expect(view.focus).not.toHaveBeenCalled();
});

test("normal disposal does not change the page scroll style", () => {
  const view = setup("scroll", "");
  view.scope.stop();
  expect(view.overflow()).toBe("scroll");
  expect(view.dialog.close).not.toHaveBeenCalled();
});

test("restoring then navigating before the next tick never focuses a dead editor", async () => {
  const view = setup();
  await view.toggle();
  view.focus.mockClear();
  const pending = view.restore();
  view.scope.stop();
  await pending;
  await nextTick();
  expect(view.focus).not.toHaveBeenCalled();
  expect(view.overflow()).toBe("auto");
});

test("rapid toggles leave one expanded session and still restore the page's original overflow", async () => {
  const view = setup("scroll", "important");
  await Promise.all([view.toggle(), view.toggle(), view.toggle()]);
  expect(view.expanded.value).toBe(true);
  expect(view.dialog.open).toBe(true);
  expect(view.overflow()).toBe("hidden");
  await view.restore();
  expect(view.overflow()).toBe("scroll");
  expect(view.priority()).toBe("important");
});

test("focus containment leaves editor-consumed and modified keys alone", async () => {
  const view = setup();
  view.containFocus({ key: "Tab" } as KeyboardEvent);
  await view.toggle();
  for (const event of [
    { key: "Escape" },
    { key: "Tab", defaultPrevented: true },
    { key: "Tab", altKey: true },
    { key: "Tab", ctrlKey: true },
    { key: "Tab", metaKey: true },
  ]) {
    const preventDefault = vi.fn();
    view.containFocus({ ...event, preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).not.toHaveBeenCalled();
  }
});
