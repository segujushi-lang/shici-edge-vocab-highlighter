// A small fixed-upstream Google Translate gateway for personal, self-hosted use.
const UPSTREAM_URL = "https://translate.googleapis.com/translate_a/single";
const WORD_PATTERN = /^[a-z]+(?:['-][a-z]+)*$/i;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "300",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

function proxyError(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

async function readLimitedJson(response, maxBytes, signal) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel();
    throw proxyError("invalid_upstream", "The upstream did not return JSON.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw proxyError("upstream_too_large", "The upstream response exceeded the size limit.");
  }
  if (!response.body) throw proxyError("invalid_upstream", "The upstream response was empty.");
  const reader = response.body.getReader();
  const cancelOnAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  if (signal.aborted) cancelOnAbort();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw proxyError("upstream_too_large", "The upstream response exceeded the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let result;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
  } catch {
    throw proxyError("invalid_upstream", "The upstream returned malformed JSON.");
  }
  if (!result || Array.isArray(result) || !Array.isArray(result.sentences) ||
      !result.sentences.some((item) => item && typeof item.trans === "string" && item.trans.trim()) ||
      (result.dict !== undefined && !Array.isArray(result.dict))) {
    throw proxyError("invalid_upstream", "The upstream returned an unexpected translation format.");
  }
  return JSON.stringify(result);
}

export function createGoogleProxy({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  upstreamTimeoutMs = 10_000,
  maxBodyBytes = 128 * 1024,
  cacheTtlMs = 10 * 60 * 1000,
  maxCacheEntries = 256,
  maxRequestsPerMinute = 30,
  maxConcurrent = 2
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let windowStarted = now();
  let windowRequests = 0;

  async function queryUpstream(word) {
    const controller = new AbortController();
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(proxyError("upstream_timeout", "The upstream translation request timed out.", 504));
      }, upstreamTimeoutMs);
    });
    const work = (async () => {
      const upstream = new URL(UPSTREAM_URL);
      upstream.search = new URLSearchParams({ client: "gtx", sl: "en", tl: "zh-CN", dj: "1", q: word }).toString();
      upstream.searchParams.append("dt", "t");
      upstream.searchParams.append("dt", "bd");
      const response = await fetchImpl(upstream.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw proxyError("upstream_http", `The upstream returned HTTP ${response.status}.`);
      }
      return readLimitedJson(response, maxBodyBytes, controller.signal);
    })();
    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      if (error?.code && error?.status) throw error;
      throw proxyError("upstream_unavailable", "The upstream translation service could not be reached.");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function handle(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return jsonResponse({ error: "invalid_url", message: "Invalid request URL." }, 400);
    }
    if (url.pathname !== "/translate") {
      return jsonResponse({ error: "not_found", message: "Use /translate?q=word." }, 404);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed", message: "Only GET is supported." }, 405, { Allow: "GET, OPTIONS" });
    }
    const queries = [...url.searchParams];
    const word = url.searchParams.get("q");
    if (url.href.length > 2048 || queries.length !== 1 || queries[0][0] !== "q" ||
        !word || word.length > 64 || !WORD_PATTERN.test(word)) {
      return jsonResponse({ error: "invalid_word", message: "Provide exactly one English word (up to 64 characters) as q." }, 400);
    }
    const normalizedWord = word.toLowerCase();
    const currentTime = now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= currentTime) cache.delete(key);
    }
    const cached = cache.get(normalizedWord);
    if (cached) {
      cache.delete(normalizedWord);
      cache.set(normalizedWord, cached);
      return jsonResponse(cached.body, 200, { "X-Shici-Cache": "HIT" });
    }

    let pending = inFlight.get(normalizedWord);
    if (!pending) {
      if (currentTime - windowStarted >= 60_000 || currentTime < windowStarted) {
        windowStarted = currentTime;
        windowRequests = 0;
      }
      if (windowRequests >= maxRequestsPerMinute || inFlight.size >= maxConcurrent) {
        const retryAfter = Math.max(1, Math.ceil((60_000 - (currentTime - windowStarted)) / 1000));
        return jsonResponse({ error: "rate_limited", message: "The personal proxy request limit was reached. Try again later." }, 429, { "Retry-After": String(retryAfter) });
      }
      windowRequests += 1;
      pending = queryUpstream(normalizedWord).then((body) => {
        if (maxCacheEntries > 0 && cacheTtlMs > 0) {
          cache.set(normalizedWord, { body, expiresAt: now() + cacheTtlMs });
          while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
        }
        return body;
      });
      inFlight.set(normalizedWord, pending);
    }
    try {
      return jsonResponse(await pending, 200, { "X-Shici-Cache": "MISS" });
    } catch (error) {
      return jsonResponse({ error: error.code || "upstream_unavailable", message: error.message || "Translation failed." }, error.status || 502);
    } finally {
      if (inFlight.get(normalizedWord) === pending) inFlight.delete(normalizedWord);
    }
  }

  return { fetch: handle };
}

export default createGoogleProxy();
