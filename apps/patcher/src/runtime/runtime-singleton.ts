// A single shared AudioRuntime instance for the app. Exposed as a module
// singleton so visualization components (ScopeView, MeterView, etc.) and
// the App's toolbar / inspector all talk to the same live processor.

import { AudioRuntime } from "./AudioRuntime";

export const runtime = new AudioRuntime();
