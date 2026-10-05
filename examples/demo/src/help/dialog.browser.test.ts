import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createApp, h, nextTick, ref } from "vue";
import PlaygroundHelp from "../components/PlaygroundHelp.vue";
import { apiEntries } from "./catalog.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
});

function mount(initialTab: "api" | "sugar" = "api") {
  const host = document.createElement("div");
  document.body.append(host);
  const open = ref(true);
  const closes = vi.fn(() => {
    open.value = false;
  });
  const app = createApp({
    render: () =>
      open.value ? h(PlaygroundHelp, { initialTab, onClose: closes }) : h("button", "Editor"),
  });
  app.mount(host);
  dispose = () => {
    app.unmount();
    host.remove();
  };
  return { open, closes };
}

test("keyboard search, detail, explicit copy, and Escape close need no editor mutation", async () => {
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const { closes } = mount();
  await expect.element(page.getByRole("dialog", { name: "Playground help" })).toBeVisible();
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Search help");
  await userEvent.keyboard("clamp");
  await page.getByRole("button", { name: "clamp", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "clamp", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy example", exact: true }).click();
  expect(copy).toHaveBeenCalledExactlyOnceWith(
    apiEntries.find((entry) => entry.id === "clamp")!.example,
  );
  await userEvent.keyboard("{Escape}");
  expect(closes).toHaveBeenCalledOnce();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

test("tabs support arrow keys, filters show empty results, and remount resets listeners", async () => {
  const { open, closes } = mount("sugar");
  await page.getByRole("tab", { name: "Sugar guide" }).click();
  await userEvent.keyboard("{ArrowLeft}");
  await expect
    .element(page.getByRole("tab", { name: "API reference" }))
    .toHaveAttribute("aria-selected", "true");
  await page.getByRole("searchbox", { name: "Search help" }).fill("no-such-operator");
  await expect
    .element(page.getByText("No matching entries. Try another name or purpose."))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(closes).toHaveBeenCalledOnce();
  open.value = true;
  await nextTick();
  await expect.element(page.getByRole("dialog", { name: "Playground help" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(closes).toHaveBeenCalledTimes(2);
});

test("native modal contains Tab focus and clipboard rejection stays actionable", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("blocked"));
  mount();
  document.querySelector<HTMLButtonElement>('[aria-label="Close help"]')!.focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.querySelector("dialog")!.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Example source"]'));
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Close help"]'));
  await page.getByRole("button", { name: "Copy example", exact: true }).click();
  await expect
    .element(page.getByText("Copy unavailable. Select the example below and copy it manually."))
    .toBeVisible();
  await page.getByRole("button", { name: "Close help" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
