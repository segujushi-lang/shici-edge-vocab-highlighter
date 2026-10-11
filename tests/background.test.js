const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");

const root = resolve(__dirname, "..");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBackgroundHarness({ fetchImpl, permissionsGranted = true } = {}) {
  const local = {};
  const session = {};
  let fetchCalls = 0;
  const fetchUrls = [];
  const permissionChecks = [];
  let messageListener;
  let commandListener;

  function createStorageArea(store) {
    return {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.flatMap((key) => (
          Object.hasOwn(store, key) ? [[key, clone(store[key])]] : []
        )));
      },
      async set(updates) {
        Object.assign(store, clone(updates));
      }
    };
  }

  const chrome = {
    permissions: {
      async contains({ origins }) {
        permissionChecks.push([...origins]);
        return typeof permissionsGranted === "function" ? permissionsGranted(origins) : permissionsGranted;
      }
    },
    commands: {
      onCommand: { addListener(listener) { commandListener = listener; } }
    },
    contextMenus: {
      onClicked: { addListener() {} },
      removeAll(callback) { callback(); },
      create(_options, callback) { callback(); }
    },
    runtime: {
      lastError: null,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    storage: {
      local: createStorageArea(local),
      session: createStorageArea(session)
    },
    tabs: {
      query(_options, callback) { callback([]); },
      sendMessage(_tabId, _message, callback) { callback(); }
    }
  };

  const context = vm.createContext({
    AbortController,
    URL,
    chrome,
    console: { warn() {} },
    fetch: async (url, options) => {
      fetchCalls += 1;
      fetchUrls.push(String(url));
      if (fetchImpl) {
        return fetchImpl(url, options);
      }
      throw new Error("Unexpected network request in background test");
    },
    setTimeout,
    clearTimeout
  });
  context.importScripts = (filename) => {
    vm.runInContext(readFileSync(resolve(root, filename), "utf8"), context, { filename });
  };
  vm.runInContext(readFileSync(resolve(root, "background.js"), "utf8"), context, { filename: "background.js" });

  return {
    local,
    session,
    get fetchCalls() { return fetchCalls; },
    fetchUrls,
    permissionChecks,
    async send(message) {
      return new Promise((resolveResponse) => {
        messageListener(message, {}, resolveResponse);
      });
    },
    async command(name) {
      commandListener(name);
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    }
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return clone(value); }
  };
}

test("default MyMemory source stores multiple deduplicated translations", async () => {
  const harness = createBackgroundHarness({
    fetchImpl(url) {
      assert.equal(new URL(url).hostname, "api.mymemory.translated.net");
      return jsonResponse({
        responseStatus: 200,
        responseData: { translatedText: "意外发现" },
        matches: [
          { translation: "意外发现" },
          { translation: "机缘" },
          { translation: "serendipity" }
        ]
      });
    }
  });

  const response = await harness.send({ type: "ADD_WORD", word: "Serendipity" });
  assert.equal(response.ok, true);
  assert.equal(harness.fetchCalls, 1);
  assert.deepEqual(clone(response.entry.translationResults.map((result) => result.text)), ["意外发现", "机缘"]);
  assert.deepEqual(clone(response.entry.translationResults.map((result) => result.source)), ["mymemory", "mymemory"]);
  assert.equal(response.entry.translation, "意外发现");
});

test("opted-in Wiktionary survives another source failure and keeps manual text first", async () => {
  const harness = createBackgroundHarness({
    fetchImpl(url) {
      const hostname = new URL(url).hostname;
      if (hostname === "api.mymemory.translated.net") {
        throw new Error("MyMemory unavailable");
      }
      assert.equal(hostname, "zh.wiktionary.org");
      return jsonResponse({
        query: {
          pages: [{
            title: "curious",
            extract: "== 英语 ==\n=== 形容词 ===\ncurious (比較級 more curious)\n好奇的\n奇怪的"
          }]
        }
      });
    }
  });

  const sourceChange = await harness.send({
    type: "SET_TRANSLATION_SOURCE",
    source: "wiktionary",
    enabled: true
  });
  assert.equal(sourceChange.settings.translationSources.wiktionary, true);
  assert.equal(harness.fetchCalls, 0);

  const added = await harness.send({ type: "ADD_WORD", word: "Curious" });
  assert.equal(added.entry.translationStatus, "ready");
  assert.equal(harness.fetchCalls, 2);
  assert.deepEqual(clone(added.entry.translationResults.map((result) => result.text)), ["好奇的", "奇怪的"]);
  assert.ok(added.entry.translationResults.every((result) => result.source === "wiktionary"));

  await harness.send({ type: "UPDATE_TRANSLATION", key: "curious", translation: "好奇；稀奇" });
  const retried = await harness.send({ type: "RETRY_TRANSLATION", key: "curious" });
  assert.equal(retried.entry.translation, "好奇；稀奇");
  assert.equal(retried.entry.translationResults[0].source, "manual");
  assert.ok(retried.entry.translationResults.some((result) => result.source === "wiktionary"));
});

test("translation source opt-in is reversible and never performs a lookup by itself", async () => {
  const harness = createBackgroundHarness();
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "wiktionary", enabled: true });
  assert.equal(harness.local.vocabSettings.translationSources.wiktionary, true);
  assert.equal(harness.fetchCalls, 0);
  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabSettings.translationSources.wiktionary, false);
  assert.equal(harness.fetchCalls, 0);
});

test("disabling every automatic source prevents all translation requests", async () => {
  const harness = createBackgroundHarness();
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "mymemory", enabled: false });
  const added = await harness.send({ type: "ADD_WORD", word: "Private" });
  assert.equal(added.entry.translationStatus, "error");
  assert.equal(added.entry.translationResults.length, 0);
  assert.equal(harness.fetchCalls, 0);
});

test("Google proxy configuration and opt-in are reversible and never perform lookups", async () => {
  const harness = createBackgroundHarness();
  const initial = await harness.send({ type: "GET_STATE" });
  assert.equal(initial.settings.googleProxyUrl, "");
  assert.equal(initial.settings.translationSources.google, false);
  const noEndpoint = await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: true });
  assert.equal(noEndpoint.ok, false);
  const invalid = await harness.send({ type: "SET_GOOGLE_PROXY_URL", url: "https://proxy.example/api?token=secret" });
  assert.equal(invalid.ok, false);
  const saved = await harness.send({ type: "SET_GOOGLE_PROXY_URL", url: "https://proxy.example/translate_a/single" });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.translationSources.google, false);
  assert.equal(saved.history.undoLabel, "修改 Google 反代地址");
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: true });
  assert.equal(harness.local.vocabSettings.translationSources.google, true);
  assert.equal(harness.fetchCalls, 0);
  assert.deepEqual(harness.permissionChecks, [["https://proxy.example/*"]]);
  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabSettings.translationSources.google, false);
  await harness.send({ type: "REDO_LAST_ACTION" });
  assert.equal(harness.local.vocabSettings.translationSources.google, true);
  await harness.send({ type: "SET_GOOGLE_PROXY_URL", url: "" });
  assert.equal(harness.local.vocabSettings.googleProxyUrl, "");
  assert.equal(harness.local.vocabSettings.translationSources.google, false);
  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabSettings.googleProxyUrl, "https://proxy.example/translate_a/single");
  assert.equal(harness.local.vocabSettings.translationSources.google, true);
  assert.equal(harness.fetchCalls, 0);
});

test("Google queries only the user proxy with the q-only protocol and privacy-safe fetch options", async () => {
  const harness = createBackgroundHarness({
    fetchImpl(url, options) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "http://127.0.0.1:8787");
      assert.equal(parsed.pathname, "/translate_a/single");
      assert.deepEqual([...parsed.searchParams.keys()], ["q"]);
      assert.equal(parsed.searchParams.get("q"), "run");
      assert.equal(parsed.searchParams.has("sourceUrl"), false);
      assert.equal(options.credentials, "omit");
      assert.equal(options.referrerPolicy, "no-referrer");
      assert.equal(options.redirect, "error");
      return jsonResponse({
        sentences: [{ trans: "跑步" }],
        dict: [{ pos: "verb", terms: ["运行", "执行", "跑"] }]
      });
    }
  });
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "mymemory", enabled: false });
  await harness.send({ type: "SET_GOOGLE_PROXY_URL", url: "http://127.0.0.1:8787/translate_a/single" });
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: true });
  const added = await harness.send({ type: "ADD_WORD", word: "Run", sourceUrl: "https://private.example/page" });
  assert.equal(added.ok, true);
  assert.equal(added.entry.translation, "跑步");
  assert.deepEqual(clone(added.entry.translationResults), [
    { source: "google", text: "跑步" },
    { source: "google", text: "运行；执行；跑", partOfSpeech: "动词" }
  ]);
  assert.equal(harness.fetchCalls, 1);
  assert.deepEqual(harness.permissionChecks, [
    ["http://127.0.0.1:8787/*"],
    ["http://127.0.0.1:8787/*"]
  ]);
});

test("background and the real proxy handler agree on the q-only gateway protocol", async () => {
  const { createGoogleProxy } = await import("../proxy/worker.mjs");
  let upstreamCalls = 0;
  const proxy = createGoogleProxy({
    fetchImpl: async (url) => {
      upstreamCalls += 1;
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://translate.googleapis.com");
      assert.equal(parsed.pathname, "/translate_a/single");
      assert.equal(parsed.searchParams.get("client"), "gtx");
      assert.equal(parsed.searchParams.get("sl"), "en");
      assert.equal(parsed.searchParams.get("tl"), "zh-CN");
      assert.equal(parsed.searchParams.get("dj"), "1");
      assert.deepEqual(parsed.searchParams.getAll("dt"), ["t", "bd"]);
      assert.equal(parsed.searchParams.get("q"), "bank");
      return new Response(JSON.stringify({
        sentences: [{ trans: "银行" }],
        dict: [{ pos: "noun", terms: ["银行", "岸"] }]
      }), { headers: { "Content-Type": "application/json" } });
    }
  });
  const harness = createBackgroundHarness({
    fetchImpl: (url, options) => proxy.fetch(new Request(String(url), options))
  });
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "mymemory", enabled: false });
  await harness.send({ type: "SET_GOOGLE_PROXY_URL", url: "http://127.0.0.1:8787/translate" });
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: true });
  const added = await harness.send({ type: "ADD_WORD", word: "Bank" });
  assert.equal(added.ok, true);
  assert.equal(added.entry.translationStatus, "ready");
  assert.deepEqual(clone(added.entry.translationResults), [
    { source: "google", text: "银行" },
    { source: "google", text: "银行；岸", partOfSpeech: "名词" }
  ]);
  assert.equal(upstreamCalls, 1);
  assert.equal(harness.fetchUrls[0], "http://127.0.0.1:8787/translate?q=bank");
});

test("Google fails closed without permission and other sources still succeed", async () => {
  let granted = false;
  const harness = createBackgroundHarness({
    permissionsGranted: () => granted,
    fetchImpl(url) {
      assert.equal(new URL(url).hostname, "api.mymemory.translated.net");
      return jsonResponse({ responseStatus: 200, responseData: { translatedText: "好奇的" } });
    }
  });
  await harness.send({ type: "SET_GOOGLE_PROXY_URL", url: "https://proxy.example/google" });
  const denied = await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: true });
  assert.equal(denied.ok, false);
  assert.equal(harness.local.vocabSettings.translationSources.google, false);
  assert.equal(harness.fetchCalls, 0);
  granted = true;
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: true });
  granted = false;
  const added = await harness.send({ type: "ADD_WORD", word: "Curious" });
  assert.equal(added.entry.translationStatus, "ready");
  assert.equal(added.entry.translation, "好奇的");
  assert.equal(harness.fetchCalls, 1);
  assert.equal(added.entry.translationResults.every((result) => result.source === "mymemory"), true);
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "mymemory", enabled: false });
  const googleOnly = await harness.send({ type: "ADD_WORD", word: "Private" });
  assert.equal(googleOnly.entry.translationStatus, "error");
  assert.equal(harness.fetchCalls, 1);
});

test("Google refresh replaces old automatic results while keeping manual definitions", async () => {
  let iteration = 0;
  const harness = createBackgroundHarness({
    fetchImpl() {
      iteration += 1;
      return jsonResponse({ sentences: [{ trans: iteration === 1 ? "旧的谷歌释义" : "新的谷歌释义" }] });
    }
  });
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "mymemory", enabled: false });
  await harness.send({ type: "SET_GOOGLE_PROXY_URL", url: "https://proxy.example/google" });
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: true });
  await harness.send({ type: "ADD_WORD", word: "Run" });
  await harness.send({ type: "UPDATE_TRANSLATION", key: "run", translation: "手工释义" });
  const retried = await harness.send({ type: "RETRY_TRANSLATION", key: "run" });
  assert.deepEqual(clone(retried.entry.translationResults), [
    { source: "manual", text: "手工释义" },
    { source: "google", text: "新的谷歌释义" }
  ]);
  assert.equal(retried.entry.translation, "手工释义");
  assert.equal(harness.fetchCalls, 2);
});

for (const failureMode of ["network", "empty", "revoked permission"]) {
  test(`Google cached definitions survive partial refresh failure: ${failureMode}`, async () => {
    let googleMode = "initial";
    let myMemoryText = "跑";
    let permissionGranted = true;
    const harness = createBackgroundHarness({
      permissionsGranted: () => permissionGranted,
      fetchImpl(url) {
        if (new URL(url).hostname === "api.mymemory.translated.net") {
          return jsonResponse({ responseStatus: 200, responseData: { translatedText: myMemoryText } });
        }
        if (googleMode === "network") throw new Error("Proxy unavailable");
        return jsonResponse({
          sentences: [{ trans: googleMode === "empty" ? "run" : googleMode === "recovered" ? "运转" : "运行" }]
        });
      }
    });
    await harness.send({ type: "SET_GOOGLE_PROXY_URL", url: "https://proxy.example/translate" });
    await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: true });
    await harness.send({ type: "ADD_WORD", word: "Run" });
    await harness.send({ type: "UPDATE_TRANSLATION", key: "run", translation: "人工释义" });

    myMemoryText = "奔跑";
    googleMode = failureMode;
    permissionGranted = failureMode !== "revoked permission";
    const partial = await harness.send({ type: "RETRY_TRANSLATION", key: "run" });
    assert.equal(partial.entry.translationStatus, "ready");
    assert.deepEqual(clone(partial.entry.translationResults), [
      { source: "manual", text: "人工释义" },
      { source: "mymemory", text: "奔跑" },
      { source: "google", text: "运行" }
    ]);

    permissionGranted = true;
    googleMode = "recovered";
    const recovered = await harness.send({ type: "RETRY_TRANSLATION", key: "run" });
    assert.deepEqual(clone(recovered.entry.translationResults), [
      { source: "manual", text: "人工释义" },
      { source: "mymemory", text: "奔跑" },
      { source: "google", text: "运转" }
    ]);

    await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: false });
    const disabled = await harness.send({ type: "RETRY_TRANSLATION", key: "run" });
    assert.deepEqual(clone(disabled.entry.translationResults), [
      { source: "manual", text: "人工释义" },
      { source: "mymemory", text: "奔跑" }
    ]);
  });
}

test("a delayed Google result cannot resurrect a removed word", async () => {
  let releaseFetch;
  let notifyFetchStarted;
  const fetchStarted = new Promise((resolveStarted) => { notifyFetchStarted = resolveStarted; });
  const harness = createBackgroundHarness({
    fetchImpl() {
      notifyFetchStarted();
      return new Promise((resolveFetch) => { releaseFetch = resolveFetch; });
    }
  });
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "mymemory", enabled: false });
  await harness.send({ type: "SET_GOOGLE_PROXY_URL", url: "https://proxy.example/google" });
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "google", enabled: true });
  await harness.send({ type: "ADD_WORD", word: "Run", translation: "人工释义" });
  const retry = harness.send({ type: "RETRY_TRANSLATION", key: "run" });
  await fetchStarted;
  await harness.send({ type: "REMOVE_WORD", key: "run" });
  releaseFetch(jsonResponse({ sentences: [{ trans: "迟到的译文" }] }));
  await retry;
  assert.equal(harness.local.vocabEntries.run, undefined);
});

test("background history restores entries and settings through undo and redo", async () => {
  const harness = createBackgroundHarness();

  const added = await harness.send({
    type: "ADD_WORD",
    word: "Serendipity",
    translation: "意外发现"
  });
  assert.equal(added.ok, true);
  assert.equal(added.history.canUndo, true);

  const removed = await harness.send({ type: "REMOVE_WORD", key: "serendipity" });
  assert.equal(removed.ok, true);
  assert.equal(Object.keys(harness.local.vocabEntries).length, 0);

  const undone = await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(undone.changed, true);
  assert.equal(harness.local.vocabEntries.serendipity.translation, "意外发现");
  assert.equal(undone.history.canRedo, true);

  const redone = await harness.send({ type: "REDO_LAST_ACTION" });
  assert.equal(redone.changed, true);
  assert.equal(Object.keys(harness.local.vocabEntries).length, 0);

  await harness.send({ type: "SET_HIGHLIGHT_COLOR", highlightColor: "#123456" });
  assert.equal(harness.local.vocabSettings.highlightColor, "#123456");
  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabSettings.highlightColor, "#ffdd57");
});

test("global toggle command uses the same reversible action history", async () => {
  const harness = createBackgroundHarness();
  await harness.command("toggle-highlighting");
  assert.equal(harness.local.vocabSettings.enabled, false);

  const state = await harness.send({ type: "GET_STATE" });
  assert.equal(state.history.canUndo, true);
  assert.match(state.history.undoLabel, /暂停网页高亮/);

  await harness.command("undo-last-action");
  assert.equal(harness.local.vocabSettings.enabled, true);
});

test("batch import skips existing words, stays local, and undoes as one action", async () => {
  const harness = createBackgroundHarness();
  await harness.send({
    type: "ADD_WORD",
    word: "Serendipity",
    translation: "原有释义"
  });

  const imported = await harness.send({
    type: "IMPORT_WORDS",
    items: [
      { word: "serendipity", translation: "不应覆盖" },
      { word: "Curious", translation: "好奇的" },
      { word: "Insight", translation: "" }
    ]
  });

  assert.equal(imported.ok, true);
  assert.equal(imported.importedCount, 2);
  assert.equal(imported.skippedExistingCount, 1);
  assert.equal(imported.untranslatedCount, 1);
  assert.equal(imported.history.undoLabel, "批量导入 2 个生词");
  assert.equal(harness.local.vocabEntries.serendipity.translation, "原有释义");
  assert.equal(harness.local.vocabEntries.curious.translation, "好奇的");
  assert.equal(harness.local.vocabEntries.insight.translationStatus, "error");
  assert.equal(harness.fetchCalls, 0);

  const undone = await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(undone.changed, true);
  assert.deepEqual(Object.keys(harness.local.vocabEntries), ["serendipity"]);

  const redone = await harness.send({ type: "REDO_LAST_ACTION" });
  assert.equal(redone.changed, true);
  assert.deepEqual(Object.keys(harness.local.vocabEntries).sort(), ["curious", "insight", "serendipity"]);
  assert.equal(harness.fetchCalls, 0);
});

test("categories control word colors and deletion moves words without deleting them", async () => {
  const harness = createBackgroundHarness();
  const created = await harness.send({
    type: "CREATE_CATEGORY",
    name: "考试重点",
    color: "#7dd3fc"
  });
  assert.equal(created.ok, true);
  const categoryId = created.category.id;
  assert.equal(harness.local.vocabSettings.categories[categoryId].color, "#7dd3fc");

  await harness.send({
    type: "ADD_WORD",
    word: "Epiphany",
    translation: "顿悟",
    categoryId
  });
  assert.equal(harness.local.vocabEntries.epiphany.categoryId, categoryId);

  const recolored = await harness.send({
    type: "UPDATE_CATEGORY",
    categoryId,
    color: "#c4b5fd"
  });
  assert.equal(recolored.category.color, "#c4b5fd");

  const deleted = await harness.send({ type: "DELETE_CATEGORY", categoryId });
  assert.equal(deleted.movedCount, 1);
  assert.equal(harness.local.vocabEntries.epiphany.categoryId, "default");
  assert.equal(harness.local.vocabSettings.categories[categoryId], undefined);

  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabEntries.epiphany.categoryId, categoryId);
  assert.equal(harness.local.vocabSettings.categories[categoryId].color, "#c4b5fd");

  await harness.send({ type: "REDO_LAST_ACTION" });
  assert.equal(harness.local.vocabEntries.epiphany.categoryId, "default");
  assert.equal(harness.local.vocabEntries.epiphany.word, "Epiphany");

  const rejected = await harness.send({ type: "DELETE_CATEGORY", categoryId: "default" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /默认分类不能删除/);
});

test("word moves and categorized imports are reversible", async () => {
  const harness = createBackgroundHarness();
  const created = await harness.send({ type: "CREATE_CATEGORY", name: "阅读", color: "#86efac" });
  const categoryId = created.category.id;

  const imported = await harness.send({
    type: "IMPORT_WORDS",
    categoryId,
    items: [{ word: "Curious", translation: "好奇的" }]
  });
  assert.equal(imported.ok, true);
  assert.equal(harness.local.vocabEntries.curious.categoryId, categoryId);

  const moved = await harness.send({ type: "MOVE_WORD", key: "curious", categoryId: "default" });
  assert.equal(moved.entry.categoryId, "default");
  assert.match(moved.history.undoLabel, /移到“默认分类”/);

  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabEntries.curious.categoryId, categoryId);
  assert.equal(harness.fetchCalls, 0);
});
