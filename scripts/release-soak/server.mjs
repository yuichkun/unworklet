import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
import unworklet from "../../packages/unplugin/dist/index.mjs";

export async function startServer(transport, cacheDir) {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("./", import.meta.url)),
    cacheDir,
    logLevel: "warn",
    resolve: {
      alias: [
        {
          find: /^@unworklet\/core\/worklet$/,
          replacement: fileURLToPath(
            new URL("../../packages/core/src/worklet-entry.ts", import.meta.url),
          ),
        },
      ],
    },
    plugins: [unworklet({ crossOriginIsolation: transport === "sab" })],
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: null,
      fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] },
    },
  });
  await server.listen();
  const address = server.httpServer.address();
  return { server, url: `http://127.0.0.1:${address.port}/?transport=${transport}` };
}
