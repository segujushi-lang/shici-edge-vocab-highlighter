import http from "node:http";
import { pathToFileURL } from "node:url";
import { createGoogleProxy } from "./worker.mjs";

export function startServer({ port = 8787, proxy = createGoogleProxy() } = {}) {
  const server = http.createServer(async (incoming, outgoing) => {
    incoming.resume();
    try {
      const request = new Request(new URL(incoming.url, "http://127.0.0.1"), { method: incoming.method });
      const response = await proxy.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      outgoing.end(JSON.stringify({ error: "internal_error", message: "The proxy could not process the request." }));
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, "127.0.0.1", () => {
    console.log(`拾词 Google 反代已启动：http://127.0.0.1:${server.address().port}/translate`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configuredPort = process.env.SHICI_PROXY_PORT || "8787";
  const port = Number(configuredPort);
  if (!/^\d+$/.test(configuredPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SHICI_PROXY_PORT must be an integer between 1 and 65535.");
  }
  startServer({ port });
}
