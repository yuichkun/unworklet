import type { EditorQuery, EditorResult, WorkerRequest, WorkerResponse } from "./protocol.ts";

type Cancellation = {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
};
type Document = Pick<EditorQuery, "uri" | "version" | "source">;

export class EditorWorkerClient {
  private document?: Document;
  private nextId = 0;
  private disposed = false;
  private pending = new Map<number, { finish(result?: EditorResult): void; document: Document }>();

  constructor(
    private worker: Worker,
    private onFailure: (message: string, permanent: boolean) => void,
  ) {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const { id, result, error } = event.data;
      const pending = this.pending.get(id);
      if (!pending) return;
      if (error) {
        pending.finish();
        onFailure(`Editor assistance could not analyze this source: ${error}`, false);
      } else {
        pending.finish(
          result?.uri === this.document?.uri && result?.version === this.document?.version
            ? result
            : undefined,
        );
      }
    };
    worker.onerror = () =>
      this.fail("Editor assistance is unavailable. You can keep editing and recompile.");
    worker.onmessageerror = () =>
      this.fail("Editor assistance could not read a worker response. You can keep editing.");
  }

  update(document: Document): void {
    this.document = document;
    for (const pending of this.pending.values()) {
      if (pending.document.uri !== document.uri || pending.document.version !== document.version)
        pending.finish();
    }
  }

  query(
    kind: EditorQuery["kind"],
    offset: number,
    token?: Cancellation,
  ): Promise<EditorResult | undefined> {
    if (this.disposed || !this.document || token?.isCancellationRequested)
      return Promise.resolve(undefined);
    const document = this.document;
    const id = ++this.nextId;
    return new Promise((resolve) => {
      let cancellation: { dispose(): void } | undefined;
      const timer = setTimeout(
        () => this.fail("Editor assistance timed out. Editing and Recompile are still available."),
        30_000,
      );
      const finish = (result?: EditorResult) => {
        clearTimeout(timer);
        cancellation?.dispose();
        this.pending.delete(id);
        resolve(result);
      };
      this.pending.set(id, { finish, document });
      cancellation = token?.onCancellationRequested(() => finish());
      const request: WorkerRequest = { ...document, id, kind, offset };
      try {
        this.worker.postMessage(request);
      } catch {
        this.fail("Editor assistance could not start. Editing and Recompile are still available.");
      }
    });
  }

  private fail(message: string): void {
    if (this.disposed) return;
    this.dispose();
    this.onFailure(message, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.finish();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
  }
}
