const { test } = require("node:test");
const assert = require("node:assert/strict");

const proxyModule = import("../proxy/worker.mjs");
const translation = { sentences: [{ trans: "运行", orig: "run" }], dict: [{ pos: "动词", terms: ["运行", "跑"] }], src: "en" };
const upstreamResponse = () => new Response(JSON.stringify(translation), { headers: { "Content-Type": "application/json" } });
const request = (query = "q=run", options = {}) => new Request(`https://my-proxy.example/translate?${query}`, options);

test("fixed Google request returns all raw translation candidates without forwarding private headers", async () => {
  const { createGoogleProxy } = await proxyModule;
  let captured;
  const proxy = createGoogleProxy({ fetchImpl: async (url, options) => {
    captured = { url: new URL(url), options };
    return upstreamResponse();
  } });
  const response = await proxy.fetch(request("q=Run", { headers: { Cookie: "private=yes", Authorization: "Bearer secret", Referer: "https://private-page.example" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), translation);
  assert.equal(captured.url.origin, "https://translate.googleapis.com");
  assert.equal(captured.url.pathname, "/translate_a/single");
  assert.deepEqual(captured.url.searchParams.getAll("dt"), ["t", "bd"]);
  assert.equal(captured.url.searchParams.get("sl"), "en");
  assert.equal(captured.url.searchParams.get("tl"), "zh-CN");
  assert.equal(captured.url.searchParams.get("q"), "run");
  assert.equal(captured.url.searchParams.get("client"), "gtx");
  assert.equal(captured.url.searchParams.get("dj"), "1");
  assert.deepEqual(captured.options.headers, { Accept: "application/json" });
  assert.equal(captured.options.credentials, "omit");
  assert.equal(captured.options.redirect, "error");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("query validation rejects injection, duplicate parameters, arbitrary targets, phrases and long words", async () => {
  const { createGoogleProxy } = await proxyModule;
  let calls = 0;
  const proxy = createGoogleProxy({ fetchImpl: async () => { calls += 1; return upstreamResponse(); } });
  for (const query of ["", "q=", "q=run&q=jump", "q=run&url=https://internal.example", "q=run&tl=fr", "url=https://internal.example", "q=two%20words", "q=%3Cscript%3E", "q=https%3A%2F%2Finternal.example", `q=${"a".repeat(65)}`, "q=%0Arun"]) {
    assert.equal((await proxy.fetch(request(query))).status, 400, query);
  }
  for (const path of ["/", "/admin", "/https://internal.example", "/translate/extra"]) {
    assert.equal((await proxy.fetch(new Request(`https://my-proxy.example${path}?q=run`))).status, 404);
  }
  assert.equal(calls, 0);
});

test("only GET and route-specific OPTIONS are accepted", async () => {
  const { createGoogleProxy } = await proxyModule;
  const proxy = createGoogleProxy({ fetchImpl: async () => upstreamResponse() });
  const preflight = await proxy.fetch(request("", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assert.equal(await preflight.text(), "");
  assert.equal((await proxy.fetch(request("q=run", { method: "POST" }))).status, 405);
  assert.equal((await proxy.fetch(request("q=run", { method: "HEAD" }))).status, 405);
  assert.equal((await proxy.fetch(new Request("https://my-proxy.example/other", { method: "OPTIONS" }))).status, 404);
});

test("valid hyphenated words and contractions cannot add upstream parameters", async () => {
  const { createGoogleProxy } = await proxyModule;
  const words = [];
  const proxy = createGoogleProxy({ fetchImpl: async (url) => { words.push(new URL(url).searchParams.get("q")); return upstreamResponse(); } });
  assert.equal((await proxy.fetch(request("q=mother-in-law"))).status, 200);
  assert.equal((await proxy.fetch(request("q=don%27t"))).status, 200);
  assert.deepEqual(words, ["mother-in-law", "don't"]);
});

test("upstream timeout includes fetch and body read and aborts the request", async () => {
  const { createGoogleProxy } = await proxyModule;
  let signal;
  const proxy = createGoogleProxy({ upstreamTimeoutMs: 10, fetchImpl: async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const response = await proxy.fetch(request());
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error, "upstream_timeout");
  assert.equal(signal.aborted, true);
  const bodyProxy = createGoogleProxy({ upstreamTimeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "application/json" } }) });
  assert.equal((await bodyProxy.fetch(request())).status, 504);
});

test("rejected non-JSON and timed-out bodies are explicitly cancelled", async () => {
  const { createGoogleProxy } = await proxyModule;
  for (const contentType of ["text/html", "application/json"]) {
    let cancelled = false;
    const proxy = createGoogleProxy({ upstreamTimeoutMs: 10, fetchImpl: async () => new Response(
      new ReadableStream({ cancel() { cancelled = true; } }),
      { headers: { "Content-Type": contentType } }
    ) });
    const response = await proxy.fetch(request());
    assert.equal(response.status, contentType === "text/html" ? 502 : 504);
    assert.equal(cancelled, true);
  }
});

test("HTML, malformed or unexpected JSON, network errors and upstream failures are rejected", async () => {
  const { createGoogleProxy } = await proxyModule;
  const cases = [
    () => new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }),
    () => new Response("not-json", { headers: { "Content-Type": "application/json" } }),
    () => new Response(JSON.stringify({ error: "blocked" }), { headers: { "Content-Type": "application/json" } }),
    () => new Response(JSON.stringify({ sentences: [{ trans: null }] }), { headers: { "Content-Type": "application/json" } }),
    () => new Response(JSON.stringify({ sentences: [{ trans: "跑" }], dict: "unexpected" }), { headers: { "Content-Type": "application/json" } }),
    () => new Response("rate limit", { status: 429 }),
    () => { throw new Error("private network details"); }
  ];
  for (const result of cases) {
    const proxy = createGoogleProxy({ fetchImpl: async () => result() });
    const response = await proxy.fetch(request());
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error.startsWith("upstream") || result === cases[0] || result === cases[1] || result === cases[2] || result === cases[3] || result === cases[4]);
  }
});

test("response size is limited for declared and streamed bodies", async () => {
  const { createGoogleProxy } = await proxyModule;
  for (const declared of [true, false]) {
    const headers = { "Content-Type": "application/json" };
    if (declared) headers["Content-Length"] = "1000";
    const proxy = createGoogleProxy({ maxBodyBytes: 32, fetchImpl: async () => new Response(JSON.stringify(translation), { headers }) });
    const response = await proxy.fetch(request());
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, "upstream_too_large");
  }
});

test("successful words use expiring bounded memory cache and errors are not cached", async () => {
  const { createGoogleProxy } = await proxyModule;
  let time = 0;
  let calls = 0;
  const proxy = createGoogleProxy({ now: () => time, cacheTtlMs: 100, maxCacheEntries: 1, fetchImpl: async () => { calls += 1; return upstreamResponse(); } });
  assert.equal((await proxy.fetch(request())).headers.get("x-shici-cache"), "MISS");
  assert.equal((await proxy.fetch(request("q=RUN"))).headers.get("x-shici-cache"), "HIT");
  assert.equal(calls, 1);
  time = 100;
  assert.equal((await proxy.fetch(request())).headers.get("x-shici-cache"), "MISS");
  await proxy.fetch(request("q=jump"));
  await proxy.fetch(request());
  assert.equal(calls, 4);
  let failedCalls = 0;
  const failingProxy = createGoogleProxy({ fetchImpl: async () => { failedCalls += 1; return new Response("no", { status: 503 }); } });
  await failingProxy.fetch(request());
  await failingProxy.fetch(request());
  assert.equal(failedCalls, 2);
});

test("identical in-flight words share one request and different words respect concurrency limit", async () => {
  const { createGoogleProxy } = await proxyModule;
  let resolveUpstream;
  let calls = 0;
  const proxy = createGoogleProxy({ maxConcurrent: 1, fetchImpl: async () => {
    calls += 1;
    return new Promise((resolve) => { resolveUpstream = resolve; });
  } });
  const first = proxy.fetch(request());
  const same = proxy.fetch(request("q=RUN"));
  const other = await proxy.fetch(request("q=jump"));
  assert.equal(other.status, 429);
  assert.ok(Number(other.headers.get("retry-after")) > 0);
  assert.equal(calls, 1);
  resolveUpstream(upstreamResponse());
  assert.equal((await first).status, 200);
  assert.equal((await same).status, 200);
});

test("upstream request budget resets every minute and cached words do not spend it", async () => {
  const { createGoogleProxy } = await proxyModule;
  let time = 0;
  const proxy = createGoogleProxy({ now: () => time, maxRequestsPerMinute: 1, fetchImpl: async () => upstreamResponse() });
  assert.equal((await proxy.fetch(request())).status, 200);
  assert.equal((await proxy.fetch(request())).status, 200);
  assert.equal((await proxy.fetch(request("q=jump"))).status, 429);
  time = 60_000;
  assert.equal((await proxy.fetch(request("q=jump"))).status, 200);
});
