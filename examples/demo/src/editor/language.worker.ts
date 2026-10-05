import snapshot from "virtual:uwk-editor-snapshot";
import { createEditorLanguageService } from "./language-service.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

const service = createEditorLanguageService(snapshot);
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  let response: WorkerResponse;
  try {
    response = { id: request.id, result: service.query(request) };
  } catch (error) {
    response = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
};
