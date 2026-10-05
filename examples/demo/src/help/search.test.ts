import { expect, test, vi } from "vite-plus/test";
import { filterEntries } from "./catalog.ts";
import type { HelpEntry } from "./types.ts";

test("API identifier search uses stable casing even with Turkish browser locale", () => {
  const spy = vi
    .spyOn(String.prototype, "toLocaleLowerCase")
    .mockImplementation(function (this: string) {
      return this.replaceAll("I", "ı").replaceAll("İ", "i").toLowerCase();
    });
  const entry = {
    id: "audioInput",
    name: "audioInput",
    summary: "",
    category: "I/O",
    details: [],
  } as unknown as HelpEntry;
  try {
    expect(filterEntries([entry], "input", "all")).toEqual([entry]);
  } finally {
    spy.mockRestore();
  }
});
