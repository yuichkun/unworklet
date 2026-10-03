import { readWav, type Wav } from "./wav.ts";

export function createWavLoader(fetcher: typeof fetch = fetch) {
  let active = 0;
  const queue: (() => void)[] = [];
  function drain() {
    while (active < 6 && queue.length) queue.shift()!();
  }
  return (url: string, signal: AbortSignal): Promise<Wav | null> =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        active++;
        const read = async () => {
          let response: Response;
          let bytes: ArrayBuffer;
          try {
            response = await fetcher(url, { signal, mode: "cors" });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            bytes = await response.arrayBuffer();
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            if (error instanceof Error && error.message.startsWith("HTTP ")) throw error;
            throw new Error("network error");
          }
          return readWav(bytes);
        };
        void read()
          .then(resolve, reject)
          .finally(() => {
            active--;
            drain();
          });
      });
      drain();
    });
}
