import { test } from "vite-plus/test";
import { checkGenericIngress } from "./fixtures/generic-ingress-browser.ts";

test("generic ingress: SAB stopped admission, FIFO, PCM, complete ledger and snapshots at native 48kHz", () =>
  checkGenericIngress("sab"));
