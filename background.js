importScripts("shared.js");

const {
  STORAGE_KEYS,
  cleanWord,
  isValidWord,
  normalizeKey,
  sanitizeEntries,
  isValidHighlightColor,
  normalizeHighlightColor,
  normalizeCategoryId,
  cleanCategoryName,
  resolveCategoryId,
  sanitizeSettings,
  summarizeHistory,
  DEFAULT_CATEGORY_ID,
  MAX_CATEGORIES,
  MAX_IMPORT_WORDS,
  cleanTranslationText,
  sanitizeTranslationResults,
  getTranslationSourceLabel,
  normalizeGoogleProxyUrl,
  getGoogleProxyOriginPattern,
  extractGoogleTranslations,
  extractWiktionaryTranslations,
  decodeHtmlEntities,
  hasChineseText
} = globalThis.VocabGlowUtils;

const CONTEXT_MENU_ID = "vocab-glow-save-selection";
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
const WIKTIONARY_ENDPOINT = "https://zh.wiktionary.org/w/api.php";
const AUTOMATIC_TRANSLATION_SOURCES = new Set(["mymemory", "wiktionary", "google"]);
const HISTORY_LIMIT = 20;

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage();
  rebuildContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenu();
});

chrome.commands.onCommand.addListener((command) => {
  void handleCommand(command).catch((error) => {
    console.warn("[拾词] 快捷键操作失败：", error);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.selectionText) {
    return;
  }

  const displayWord = cleanWord(info.selectionText);
  void runWithHistory(`添加 ${displayWord}`, async () => ({
    entry: await saveWord({
      word: displayWord,
      sourceUrl: info.pageUrl || tab?.url || ""
    })
  }))
    .then(({ entry }) => notifyTab(tab?.id, { type: "WORD_SAVED", entry }))
    .catch((error) => notifyTab(tab?.id, {
      type: "WORD_SAVE_ERROR",
      message: error instanceof Error ? error.message : "保存失败"
    }));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "操作失败"
    }));

  return true;
});

async function initializeStorage() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.entries, STORAGE_KEYS.settings]);
  const updates = {};
  const settings = sanitizeSettings(stored[STORAGE_KEYS.settings]);
  const entries = sanitizeEntries(stored[STORAGE_KEYS.entries], settings.categories);

  if (JSON.stringify(stored[STORAGE_KEYS.settings]) !== JSON.stringify(settings)) {
    updates[STORAGE_KEYS.settings] = settings;
  }
  if (JSON.stringify(stored[STORAGE_KEYS.entries]) !== JSON.stringify(entries)) {
    updates[STORAGE_KEYS.entries] = entries;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

function rebuildContextMenu() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "保存“%s”并高亮",
      contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    }, () => {
      void chrome.runtime.lastError;
    });
  });
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    throw new Error("无效请求");
  }

  switch (message.type) {
    case "GET_STATE":
      return getClientState();
    case "ADD_WORD":
      return runWithHistory(`添加 ${cleanWord(message.word)}`, async () => ({
        entry: await saveWord({
          word: message.word,
          translation: message.translation,
          categoryId: message.categoryId,
          sourceUrl: message.sourceUrl || sender.tab?.url || ""
        })
      }));
    case "IMPORT_WORDS":
      return importWordsWithHistory(message.items, message.categoryId);
    case "REMOVE_WORD":
      return runWithHistory(
        (before) => `删除 ${before.entries[normalizeKey(message.key)]?.word || cleanWord(message.key)}`,
        () => removeWord(message.key)
      );
    case "UPDATE_TRANSLATION":
      return runWithHistory(
        (before) => `修改 ${before.entries[normalizeKey(message.key)]?.word || cleanWord(message.key)} 的翻译`,
        async () => ({ entry: await updateTranslation(message.key, message.translation) })
      );
    case "RETRY_TRANSLATION":
      return runWithHistory(
        (before) => `重新翻译 ${before.entries[normalizeKey(message.key)]?.word || cleanWord(message.key)}`,
        async () => ({ entry: await retryTranslation(message.key) })
      );
    case "SET_ENABLED":
      return runWithHistory(message.enabled ? "开启网页高亮" : "暂停网页高亮", () => setEnabled(message.enabled));
    case "SET_HIGHLIGHT_COLOR":
      return runWithHistory("修改高亮颜色", () => setHighlightColor(message.highlightColor));
    case "SET_TRANSLATION_SOURCE":
      return runWithHistory(
        `${message.enabled ? "开启" : "关闭"}${getTranslationSourceLabel(message.source)}翻译`,
        () => setTranslationSource(message.source, message.enabled)
      );
    case "SET_GOOGLE_PROXY_URL":
      return runWithHistory("修改 Google 反代地址", () => setGoogleProxyUrl(message.url));
    case "CREATE_CATEGORY":
      return runWithHistory(
        (_before, _after, result) => `新建分类 ${result.category.name}`,
        () => createCategory(message.name, message.color)
      );
    case "UPDATE_CATEGORY":
      return runWithHistory(
        (before, _after, result) => `更新分类 ${before.settings.categories[normalizeCategoryId(message.categoryId)]?.name || result.category.name}`,
        () => updateCategory(message.categoryId, { name: message.name, color: message.color })
      );
    case "DELETE_CATEGORY":
      return runWithHistory(
        (before) => `删除分类 ${before.settings.categories[normalizeCategoryId(message.categoryId)]?.name || ""}`,
        () => deleteCategory(message.categoryId)
      );
    case "MOVE_WORD":
      return runWithHistory(
        (before, after) => {
          const key = normalizeKey(message.key);
          const word = before.entries[key]?.word || cleanWord(message.key);
          const categoryId = after.entries[key]?.categoryId || DEFAULT_CATEGORY_ID;
          return `将 ${word} 移到“${after.settings.categories[categoryId]?.name || "默认分类"}”`;
        },
        () => moveWord(message.key, message.categoryId)
      );
    case "CLEAR_WORDS":
      return runWithHistory("清空词库", clearWords);
    case "UNDO_LAST_ACTION":
      return undoLastAction();
    case "REDO_LAST_ACTION":
      return redoLastAction();
    default:
      throw new Error("未知操作");
  }
}

async function getClientState() {
  const [state, history] = await Promise.all([getState(), getHistory()]);
  return { ...state, history: summarizeHistory(history) };
}

async function getState() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.entries, STORAGE_KEYS.settings]);
  const settings = sanitizeSettings(stored[STORAGE_KEYS.settings]);
  const entries = sanitizeEntries(stored[STORAGE_KEYS.entries], settings.categories);
  const staleBefore = Date.now() - 30000;
  let recoveredStaleRequest = false;

  for (const entry of Object.values(entries)) {
    const updatedAt = Date.parse(entry.updatedAt);
    if (entry.translationStatus === "loading" && (!Number.isFinite(updatedAt) || updatedAt < staleBefore)) {
      entry.translationStatus = "error";
      entry.translationRequestId = "";
      recoveredStaleRequest = true;
    }
  }

  if (recoveredStaleRequest) {
    await chrome.storage.local.set({ [STORAGE_KEYS.entries]: entries });
  }

  return {
    entries,
    settings
  };
}

async function setEntries(entries) {
  await chrome.storage.local.set({ [STORAGE_KEYS.entries]: entries });
}

async function saveWord({ word, translation = "", sourceUrl = "", categoryId }) {
  const displayWord = cleanWord(word);
  const key = normalizeKey(displayWord);

  if (!isValidWord(displayWord) || !key) {
    throw new Error("请选择一个完整的英文单词");
  }

  const manualTranslation = cleanTranslationText(translation);
  const { entries, settings } = await getState();
  const now = new Date().toISOString();
  const existing = entries[key];
  const targetCategoryId = categoryId === undefined || categoryId === null || categoryId === ""
    ? resolveCategoryId(existing?.categoryId, settings.categories)
    : requireCategoryId(categoryId, settings.categories);
  const existingResults = sanitizeTranslationResults(existing?.translationResults, existing?.translation);
  const translationResults = manualTranslation
    ? sanitizeTranslationResults([
      { source: "manual", text: manualTranslation },
      ...existingResults.filter((result) => result.source !== "manual")
    ])
    : existingResults;
  const shouldTranslate = !manualTranslation && translationResults.length === 0;
  const requestId = shouldTranslate ? createRequestId() : "";

  const entry = {
    key,
    word: existing?.word || displayWord,
    translation: translationResults[0]?.text || "",
    translationResults,
    translationStatus: translationResults.length > 0 ? "ready" : "loading",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    sourceUrl: sanitizeSourceUrl(sourceUrl || existing?.sourceUrl || ""),
    translationRequestId: requestId,
    categoryId: targetCategoryId
  };

  entries[key] = entry;
  await setEntries(entries);

  if (!shouldTranslate) {
    return entry;
  }

  return finishTranslation(key, requestId, settings);
}

async function importWordsWithHistory(value, categoryId) {
  const items = sanitizeImportItems(value);
  if (items.length === 0) {
    throw new Error("文件中没有可导入的英文单词");
  }

  return runWithHistory(
    (_before, _after, result) => `批量导入 ${result.importedCount} 个生词`,
    () => insertImportedWords(items, categoryId)
  );
}

function sanitizeImportItems(value) {
  if (!Array.isArray(value)) {
    throw new Error("导入内容格式无效");
  }
  if (value.length > MAX_IMPORT_WORDS) {
    throw new Error(`单次最多导入 ${MAX_IMPORT_WORDS} 个单词`);
  }

  const itemsByKey = new Map();
  for (const item of value) {
    const word = cleanWord(item?.word);
    const key = normalizeKey(word);
    if (!isValidWord(word) || !key || itemsByKey.has(key)) {
      continue;
    }
    const translation = cleanTranslationText(item.translation);
    itemsByKey.set(key, { key, word, translation });
  }
  return Array.from(itemsByKey.values());
}

async function insertImportedWords(items, categoryId) {
  const { entries, settings } = await getState();
  const targetCategoryId = categoryId === undefined || categoryId === null || categoryId === ""
    ? DEFAULT_CATEGORY_ID
    : requireCategoryId(categoryId, settings.categories);
  const now = new Date().toISOString();
  let importedCount = 0;
  let skippedExistingCount = 0;
  let untranslatedCount = 0;

  for (const item of items) {
    if (entries[item.key]) {
      skippedExistingCount += 1;
      continue;
    }

    entries[item.key] = {
      key: item.key,
      word: item.word,
      translation: item.translation,
      translationResults: item.translation
        ? [{ source: "import", text: item.translation }]
        : [],
      translationStatus: item.translation ? "ready" : "error",
      createdAt: now,
      updatedAt: now,
      sourceUrl: "",
      translationRequestId: "",
      categoryId: targetCategoryId
    };
    importedCount += 1;
    if (!item.translation) {
      untranslatedCount += 1;
    }
  }

  if (importedCount > 0) {
    await setEntries(entries);
  }
  return { importedCount, skippedExistingCount, untranslatedCount };
}

async function finishTranslation(key, requestId, settings) {
  try {
    const { results: automaticResults, failedSources } = await translateWord(key, settings);
    const { entries } = await getState();
    const current = entries[key];

    if (!current || current.translationRequestId !== requestId) {
      return current || null;
    }

    const retainedResults = current.translationResults.filter(
      (result) => !AUTOMATIC_TRANSLATION_SOURCES.has(result.source) || failedSources.has(result.source)
    );
    const translationResults = sanitizeTranslationResults([...retainedResults, ...automaticResults]);
    const updated = {
      ...current,
      translation: translationResults[0]?.text || "",
      translationResults,
      translationStatus: "ready",
      translationRequestId: "",
      updatedAt: new Date().toISOString()
    };
    entries[key] = updated;
    await setEntries(entries);
    return updated;
  } catch (error) {
    const { entries } = await getState();
    const current = entries[key];

    if (!current || current.translationRequestId !== requestId) {
      return current || null;
    }

    const updated = {
      ...current,
      translationStatus: current.translationResults.length > 0 ? "ready" : "error",
      translationRequestId: "",
      updatedAt: new Date().toISOString()
    };
    entries[key] = updated;
    await setEntries(entries);
    console.warn("[拾词] 翻译失败：", error);
    return updated;
  }
}

async function translateWord(word, settings) {
  const translationSources = settings.translationSources;
  const providers = [];
  if (translationSources?.mymemory) {
    providers.push({ source: "mymemory", promise: translateWithMyMemory(word) });
  }
  if (translationSources?.wiktionary) {
    providers.push({ source: "wiktionary", promise: translateWithWiktionary(word) });
  }
  if (translationSources?.google) {
    providers.push({ source: "google", promise: translateWithGoogleProxy(word, settings.googleProxyUrl) });
  }
  if (providers.length === 0) {
    throw new Error("没有启用自动翻译来源");
  }

  const settled = await Promise.allSettled(providers.map((provider) => provider.promise));
  const results = [];
  const failedSources = new Set();
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index];
    if (outcome.status === "fulfilled" && outcome.value.length > 0) {
      results.push(...outcome.value);
    } else {
      failedSources.add(providers[index].source);
      if (outcome.status === "rejected") {
        console.warn("[拾词] 单个翻译来源失败：", outcome.reason);
      }
    }
  }

  const sanitized = sanitizeTranslationResults(results);
  if (sanitized.length === 0) {
    throw new Error("已启用的翻译来源均未返回合适的中文释义");
  }
  return { results: sanitized, failedSources };
}

async function translateWithMyMemory(word) {
  const url = new URL(MYMEMORY_ENDPOINT);
  url.searchParams.set("q", word);
  url.searchParams.set("langpair", "en|zh-CN");
  url.searchParams.set("mt", "1");

  const data = await fetchJson(url, "MyMemory");
  if (Number(data.responseStatus) !== 200) {
    throw new Error(data.responseDetails || "MyMemory 暂时不可用");
  }

  const candidates = [
    data.responseData?.translatedText,
    ...(Array.isArray(data.matches) ? data.matches.map((match) => match?.translation) : [])
  ];
  return sanitizeTranslationResults(candidates.flatMap((candidate) => {
    const decoded = cleanTranslationText(decodeHtmlEntities(candidate));
    return decoded && hasChineseText(decoded) ? [{ source: "mymemory", text: decoded }] : [];
  })).slice(0, 3);
}

async function translateWithWiktionary(word) {
  const url = new URL(WIKTIONARY_ENDPOINT);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", word);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("origin", "*");

  const data = await fetchJson(url, "维基词典");
  const page = Array.isArray(data.query?.pages) ? data.query.pages[0] : null;
  if (!page || page.missing) {
    return [];
  }
  return extractWiktionaryTranslations(page.extract, word);
}

async function requireGoogleProxyAccess(value) {
  const endpoint = normalizeGoogleProxyUrl(value);
  if (!endpoint) {
    throw new Error("请先保存有效的 Google 反代地址");
  }
  const origin = getGoogleProxyOriginPattern(endpoint);
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    throw new Error("Google 反代域名尚未授权，请在弹窗中重新授权");
  }
  return endpoint;
}

async function translateWithGoogleProxy(word, proxyUrl) {
  const url = new URL(await requireGoogleProxyAccess(proxyUrl));
  url.searchParams.set("q", word);

  const data = await fetchJson(url, "Google 反代");
  return extractGoogleTranslations(data);
}

async function fetchJson(url, sourceName) {

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error"
    });
    if (!response.ok) {
      throw new Error(`${sourceName} 返回 ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function removeWord(value) {
  const key = normalizeKey(value);
  if (!key) {
    throw new Error("无效单词");
  }

  const { entries } = await getState();
  const removed = Boolean(entries[key]);
  delete entries[key];
  await setEntries(entries);
  return { removed, key };
}

async function updateTranslation(value, translation) {
  const key = normalizeKey(value);
  const nextTranslation = cleanTranslationText(translation);
  if (!key || !nextTranslation) {
    throw new Error("中文翻译不能为空");
  }

  const { entries } = await getState();
  if (!entries[key]) {
    throw new Error("这个单词已不在词库中");
  }

  const translationResults = sanitizeTranslationResults([
    { source: "manual", text: nextTranslation },
    ...entries[key].translationResults.filter((result) => result.source !== "manual")
  ]);
  entries[key] = {
    ...entries[key],
    translation: translationResults[0].text,
    translationResults,
    translationStatus: "ready",
    translationRequestId: "",
    updatedAt: new Date().toISOString()
  };
  await setEntries(entries);
  return entries[key];
}

async function retryTranslation(value) {
  const key = normalizeKey(value);
  const { entries, settings } = await getState();
  if (!key || !entries[key]) {
    throw new Error("这个单词已不在词库中");
  }

  const requestId = createRequestId();
  entries[key] = {
    ...entries[key],
    translationStatus: "loading",
    translationRequestId: requestId,
    updatedAt: new Date().toISOString()
  };
  await setEntries(entries);
  return finishTranslation(key, requestId, settings);
}

async function createCategory(value, color) {
  const { settings } = await getState();
  const categories = { ...settings.categories };
  if (Object.keys(categories).length >= MAX_CATEGORIES) {
    throw new Error(`最多创建 ${MAX_CATEGORIES} 个分类`);
  }

  const name = requireUniqueCategoryName(value, categories);
  const id = createCategoryId(categories);
  categories[id] = {
    id,
    name,
    color: normalizeHighlightColor(color)
  };
  const nextSettings = sanitizeSettings({ ...settings, categories });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });
  return { category: nextSettings.categories[id], settings: nextSettings };
}

async function updateCategory(value, updates) {
  const { settings } = await getState();
  const categoryId = requireCategoryId(value, settings.categories);
  const categories = { ...settings.categories };
  const current = categories[categoryId];
  let changed = false;
  const next = { ...current };

  if (typeof updates?.name !== "undefined") {
    next.name = requireUniqueCategoryName(updates.name, categories, categoryId);
    changed = changed || next.name !== current.name;
  }
  if (typeof updates?.color !== "undefined") {
    if (!isValidHighlightColor(updates.color)) {
      throw new Error("无效的分类颜色");
    }
    next.color = normalizeHighlightColor(updates.color);
    changed = changed || next.color !== current.color;
  }
  if (!changed) {
    return { category: current, settings };
  }

  categories[categoryId] = next;
  const nextSettings = sanitizeSettings({ ...settings, categories });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });
  return { category: nextSettings.categories[categoryId], settings: nextSettings };
}

async function deleteCategory(value) {
  const { entries, settings } = await getState();
  const categoryId = requireCategoryId(value, settings.categories);
  if (categoryId === DEFAULT_CATEGORY_ID) {
    throw new Error("默认分类不能删除");
  }

  const categories = { ...settings.categories };
  const categoryName = categories[categoryId].name;
  delete categories[categoryId];
  const now = new Date().toISOString();
  let movedCount = 0;
  for (const entry of Object.values(entries)) {
    if (entry.categoryId === categoryId) {
      entry.categoryId = DEFAULT_CATEGORY_ID;
      entry.updatedAt = now;
      movedCount += 1;
    }
  }
  const nextSettings = sanitizeSettings({ ...settings, categories });
  await chrome.storage.local.set({
    [STORAGE_KEYS.entries]: entries,
    [STORAGE_KEYS.settings]: nextSettings
  });
  return { categoryId, categoryName, movedCount, settings: nextSettings };
}

async function moveWord(value, categoryValue) {
  const key = normalizeKey(value);
  const { entries, settings } = await getState();
  if (!key || !entries[key]) {
    throw new Error("这个单词已不在词库中");
  }
  const categoryId = requireCategoryId(categoryValue, settings.categories);
  if (entries[key].categoryId !== categoryId) {
    entries[key] = {
      ...entries[key],
      categoryId,
      updatedAt: new Date().toISOString()
    };
    await setEntries(entries);
  }
  return { entry: entries[key], category: settings.categories[categoryId] };
}

function requireCategoryId(value, categories) {
  const categoryId = normalizeCategoryId(value);
  if (!categoryId || !categories[categoryId]) {
    throw new Error("所选分类不存在");
  }
  return categoryId;
}

function requireUniqueCategoryName(value, categories, currentId = "") {
  const name = cleanCategoryName(value);
  if (!name) {
    throw new Error("分类名称不能为空");
  }
  const nameKey = name.toLocaleLowerCase("zh-CN");
  const duplicate = Object.values(categories).some((category) => (
    category.id !== currentId && category.name.toLocaleLowerCase("zh-CN") === nameKey
  ));
  if (duplicate) {
    throw new Error("分类名称不能重复");
  }
  return name;
}

function createCategoryId(categories) {
  let id = "";
  do {
    id = `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  } while (categories[id]);
  return id;
}

async function setEnabled(enabled) {
  const { settings } = await getState();
  const nextSettings = sanitizeSettings({ ...settings, enabled: Boolean(enabled) });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });
  return { settings: nextSettings };
}

async function setHighlightColor(highlightColor) {
  return updateCategory(DEFAULT_CATEGORY_ID, { color: highlightColor });
}

async function setTranslationSource(source, enabled) {
  if (!AUTOMATIC_TRANSLATION_SOURCES.has(source)) {
    throw new Error("未知翻译来源");
  }
  const { settings } = await getState();
  if (source === "google" && enabled) {
    await requireGoogleProxyAccess(settings.googleProxyUrl);
  }
  const nextSettings = sanitizeSettings({
    ...settings,
    translationSources: {
      ...settings.translationSources,
      [source]: Boolean(enabled)
    }
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });
  return { settings: nextSettings };
}

async function setGoogleProxyUrl(value) {
  if (typeof value !== "string") {
    throw new Error("Google 反代地址格式无效");
  }
  const googleProxyUrl = normalizeGoogleProxyUrl(value);
  if (value.trim() && !googleProxyUrl) {
    throw new Error("反代地址须为无账号密码、查询参数或片段的 HTTPS URL；仅本机可用 HTTP");
  }
  const { settings } = await getState();
  const nextSettings = sanitizeSettings({
    ...settings,
    googleProxyUrl,
    translationSources: {
      ...settings.translationSources,
      google: googleProxyUrl ? settings.translationSources.google : false
    }
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });
  return { settings: nextSettings };
}

async function clearWords() {
  await setEntries({});
  return { cleared: true };
}

async function runWithHistory(description, operation) {
  const before = await captureSnapshot();
  const result = await operation();
  const after = await captureSnapshot();
  let history = await getHistory();

  if (!snapshotsEqual(before, after)) {
    const resolvedDescription = typeof description === "function"
      ? description(before, after, result)
      : description;
    history.undo.push({
      ...before,
      description: String(resolvedDescription || "上一次操作")
    });
    history.undo = history.undo.slice(-HISTORY_LIMIT);
    history.redo = [];
    await setHistory(history);
  }

  return { ...(result || {}), history: summarizeHistory(history) };
}

async function undoLastAction() {
  const history = await getHistory();
  const checkpoint = history.undo.pop();
  if (!checkpoint) {
    return {
      changed: false,
      message: "没有可撤回的操作",
      history: summarizeHistory(history)
    };
  }

  const current = await captureSnapshot();
  await restoreSnapshot(checkpoint);
  history.redo.push({ ...current, description: checkpoint.description });
  history.redo = history.redo.slice(-HISTORY_LIMIT);
  await setHistory(history);
  return {
    changed: true,
    message: `已撤回：${checkpoint.description}`,
    history: summarizeHistory(history)
  };
}

async function redoLastAction() {
  const history = await getHistory();
  const checkpoint = history.redo.pop();
  if (!checkpoint) {
    return {
      changed: false,
      message: "没有可重做的操作",
      history: summarizeHistory(history)
    };
  }

  const current = await captureSnapshot();
  await restoreSnapshot(checkpoint);
  history.undo.push({ ...current, description: checkpoint.description });
  history.undo = history.undo.slice(-HISTORY_LIMIT);
  await setHistory(history);
  return {
    changed: true,
    message: `已重做：${checkpoint.description}`,
    history: summarizeHistory(history)
  };
}

async function captureSnapshot() {
  const { entries, settings } = await getState();
  return { entries, settings };
}

async function restoreSnapshot(snapshot) {
  const settings = sanitizeSettings(snapshot.settings);
  await chrome.storage.local.set({
    [STORAGE_KEYS.entries]: sanitizeEntries(snapshot.entries, settings.categories),
    [STORAGE_KEYS.settings]: settings
  });
}

async function getHistory() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.history);
  const raw = stored[STORAGE_KEYS.history];
  return {
    undo: sanitizeCheckpoints(raw?.undo),
    redo: sanitizeCheckpoints(raw?.redo)
  };
}

function sanitizeCheckpoints(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(-HISTORY_LIMIT).flatMap((checkpoint) => {
    if (!checkpoint || typeof checkpoint !== "object") {
      return [];
    }
    const settings = sanitizeSettings(checkpoint.settings);
    return [{
      entries: sanitizeEntries(checkpoint.entries, settings.categories),
      settings,
      description: typeof checkpoint.description === "string"
        ? checkpoint.description.slice(0, 120)
        : "上一次操作"
    }];
  });
}

async function setHistory(history) {
  await chrome.storage.session.set({ [STORAGE_KEYS.history]: history });
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function handleCommand(command) {
  let result;
  if (command === "undo-last-action") {
    result = await undoLastAction();
  } else if (command === "redo-last-action") {
    result = await redoLastAction();
  } else if (command === "toggle-highlighting") {
    const { settings } = await getState();
    result = await runWithHistory(
      settings.enabled ? "暂停网页高亮" : "开启网页高亮",
      () => setEnabled(!settings.enabled)
    );
    result.message = result.settings.enabled ? "网页高亮已开启" : "网页高亮已暂停";
  } else {
    return;
  }

  notifyAllTabs({ type: "HISTORY_NOTICE", message: result.message || "操作完成" });
}

function sanitizeSourceUrl(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.slice(0, 2048);
}

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function notifyTab(tabId, message) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  chrome.tabs.sendMessage(tabId, message, () => {
    void chrome.runtime.lastError;
  });
}

function notifyAllTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      notifyTab(tab.id, message);
    }
  });
}
