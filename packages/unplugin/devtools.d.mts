import type {
  DevAudioGraph,
  DevLiveState,
  DevMidiInjectCommand,
  DevMidiState,
  DevSignalsState,
} from "@unworklet/unplugin";
import type { DevToolsRpcSharedStates } from "@vitejs/devtools-kit";

interface DevtoolsRpcFunctions {
  "unworklet:midi-inject": (command: Omit<DevMidiInjectCommand, "seq">) => void;
  "unworklet:page-midi-inject": (
    command: Omit<DevMidiInjectCommand, "seq"> & { pageId: string },
  ) => void;
  "anonymous:unworklet:page-open": (page: { id: string; title: string; url: string }) => boolean;
  "anonymous:unworklet:page-close": (page: { pageId: string }) => void;
  "anonymous:unworklet:graph-update": (data: DevAudioGraph) => void;
  "anonymous:unworklet:state-update": (data: DevLiveState) => void;
  "anonymous:unworklet:signals-update": (data: DevSignalsState) => void;
  "anonymous:unworklet:midi-update": (data: DevMidiState) => void;
  "anonymous:unworklet:page-graph-update": (snapshot: {
    pageId: string;
    data: DevAudioGraph;
  }) => void;
  "anonymous:unworklet:page-state-update": (snapshot: {
    pageId: string;
    data: DevLiveState;
  }) => void;
  "anonymous:unworklet:page-signals-update": (snapshot: {
    pageId: string;
    data: DevSignalsState;
  }) => void;
  "anonymous:unworklet:page-midi-update": (snapshot: {
    pageId: string;
    data: DevMidiState;
  }) => void;
}

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcServerFunctions extends DevtoolsRpcFunctions {}
}

declare module "devframe/types" {
  interface DevframeRpcServerFunctions extends DevtoolsRpcFunctions {}
  interface DevframeRpcSharedStates extends DevToolsRpcSharedStates {}
}
