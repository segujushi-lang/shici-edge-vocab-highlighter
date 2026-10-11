(function initShared(global) {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    entries: "vocabEntries",
    settings: "vocabSettings",
    history: "vocabActionHistory"
  });

  const DEFAULT_HIGHLIGHT_COLOR = "#ffdd57";
  const DEFAULT_CATEGORY_ID = "default";
  const DEFAULT_CATEGORY_NAME = "默认分类";
  const MAX_CATEGORIES = 20;
  const MAX_CATEGORY_NAME_LENGTH = 24;
  const MAX_IMPORT_WORDS = 500;
  const MAX_IMPORT_FILE_BYTES = 1024 * 1024;
  const MAX_TRANSLATION_RESULTS = 8;
  const MAX_TRANSLATION_LENGTH = 240;
  const TRANSLATION_SOURCES = Object.freeze({
    manual: Object.freeze({ label: "手工释义", priority: 0 }),
    import: Object.freeze({ label: "导入释义", priority: 1 }),
    saved: Object.freeze({ label: "已有释义", priority: 2 }),
    mymemory: Object.freeze({ label: "MyMemory", priority: 3 }),
    wiktionary: Object.freeze({ label: "维基词典", priority: 4 }),
    google: Object.freeze({ label: "Google（实验）", priority: 5 })
  });
  const DEFAULT_TRANSLATION_SOURCES = Object.freeze({
    mymemory: true,
    wiktionary: false,
    google: false
  });

  const DEFAULT_CATEGORIES = Object.freeze({
    [DEFAULT_CATEGORY_ID]: Object.freeze({
      id: DEFAULT_CATEGORY_ID,
      name: DEFAULT_CATEGORY_NAME,
      color: DEFAULT_HIGHLIGHT_COLOR
    })
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    highlightColor: DEFAULT_HIGHLIGHT_COLOR,
    categories: DEFAULT_CATEGORIES,
    translationSources: DEFAULT_TRANSLATION_SOURCES,
    googleProxyUrl: ""
  });

  const WORD_PATTERN = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;
  const HAN_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
  const HEX_COLOR_PATTERN = /^#[\da-f]{6}$/i;
  const CATEGORY_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

  function cleanWord(value) {
    if (typeof value !== "string") {
      return "";
    }

    return value
      .normalize("NFKC")
      .replace(/[‘’]/g, "'")
      .replace(/[‐‑‒–—]/g, "-")
      .trim();
  }

  function isValidWord(value) {
    const word = cleanWord(value);
    return word.length > 0 && word.length <= 64 && WORD_PATTERN.test(word);
  }

  function normalizeKey(value) {
    const word = cleanWord(value);
    return isValidWord(word) ? word.toLocaleLowerCase("en-US") : "";
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildWordMatcher(keys) {
    const words = Array.from(new Set(keys.map(normalizeKey).filter(Boolean)))
      .sort((left, right) => right.length - left.length);

    if (words.length === 0) {
      return null;
    }

    const alternatives = words.map(escapeRegExp).join("|");
    return new RegExp(`(^|[^A-Za-z])(${alternatives})(?=$|[^A-Za-z])`, "gi");
  }

  function sanitizeEntries(value, categories) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    const sanitized = {};
    for (const entry of Object.values(value)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const key = normalizeKey(entry.key || entry.word);
      if (!key) {
        continue;
      }

      const translation = cleanTranslationText(entry.translation);
      const translationResults = sanitizeTranslationResults(entry.translationResults, translation);
      sanitized[key] = {
        key,
        word: cleanWord(entry.word) || key,
        translation: translationResults[0]?.text || translation,
        translationResults,
        translationStatus: ["loading", "ready", "error"].includes(entry.translationStatus)
          ? entry.translationStatus
          : translationResults.length > 0
            ? "ready"
            : "error",
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
        sourceUrl: typeof entry.sourceUrl === "string" ? entry.sourceUrl : "",
        translationRequestId: typeof entry.translationRequestId === "string"
          ? entry.translationRequestId
          : "",
        categoryId: resolveCategoryId(entry.categoryId, categories)
      };
    }

    return sanitized;
  }

  function cleanTranslationText(value) {
    return typeof value === "string"
      ? value.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, MAX_TRANSLATION_LENGTH)
      : "";
  }

  function sanitizeTranslationResults(value, fallbackTranslation = "") {
    const candidates = Array.isArray(value) ? value : [];
    const results = [];
    const seen = new Set();

    for (const [index, candidate] of candidates.entries()) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const text = cleanTranslationText(candidate.text);
      const dedupeKey = text.toLocaleLowerCase("zh-CN");
      if (!text || seen.has(dedupeKey)) {
        continue;
      }
      const source = Object.hasOwn(TRANSLATION_SOURCES, candidate.source)
        ? candidate.source
        : "saved";
      const partOfSpeech = cleanPartOfSpeech(candidate.partOfSpeech);
      results.push({ source, text, ...(partOfSpeech ? { partOfSpeech } : {}), index });
      seen.add(dedupeKey);
    }

    const fallback = cleanTranslationText(fallbackTranslation);
    const fallbackKey = fallback.toLocaleLowerCase("zh-CN");
    if (fallback && !seen.has(fallbackKey)) {
      results.push({ source: "saved", text: fallback, index: -1 });
    }

    return results
      .sort((left, right) => (
        TRANSLATION_SOURCES[left.source].priority - TRANSLATION_SOURCES[right.source].priority
        || left.index - right.index
      ))
      .slice(0, MAX_TRANSLATION_RESULTS)
      .map(({ index, ...result }) => result);
  }

  function cleanPartOfSpeech(value) {
    if (typeof value !== "string") {
      return "";
    }
    return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 16);
  }

  function getTranslationSourceLabel(source) {
    return TRANSLATION_SOURCES[source]?.label || TRANSLATION_SOURCES.saved.label;
  }

  function normalizeGoogleProxyUrl(value) {
    if (typeof value !== "string") {
      return "";
    }
    const input = value.trim();
    if (!input || input.length > 2048 || !/^https?:\/\//i.test(input)
        || /[\u0000-\u0020\u007f]/.test(input) || /^https?:\/\/[^/]*@/i.test(input)) {
      return "";
    }

    try {
      const url = new URL(input);
      const isLocalHttp = url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((!isLocalHttp && url.protocol !== "https:") || !url.hostname
          || url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function getGoogleProxyOriginPattern(value) {
    const endpoint = normalizeGoogleProxyUrl(value);
    return endpoint ? `${new URL(endpoint).origin}/*` : "";
  }

  function extractGoogleTranslations(value) {
    const segments = Array.isArray(value)
      ? (Array.isArray(value[0]) ? value[0].map((segment) => Array.isArray(segment) ? segment[0] : "") : [])
      : (Array.isArray(value?.sentences) ? value.sentences.map((sentence) => sentence?.trans) : []);
    const results = [];
    const mainTranslation = cleanTranslationText(segments.filter((segment) => typeof segment === "string").join(""));
    if (mainTranslation && hasChineseText(mainTranslation)) {
      results.push({ source: "google", text: mainTranslation });
    }

    const dictionary = Array.isArray(value)
      ? (Array.isArray(value[1]) ? value[1] : [])
      : (Array.isArray(value?.dict) ? value.dict : []);
    const partOfSpeechLabels = {
      noun: "名词",
      verb: "动词",
      adjective: "形容词",
      adverb: "副词",
      pronoun: "代词",
      preposition: "介词",
      conjunction: "连词",
      interjection: "感叹词",
      article: "冠词"
    };
    for (const group of dictionary) {
      const terms = Array.isArray(group) ? group[1] : group?.terms;
      if (!Array.isArray(terms)) {
        continue;
      }
      const cleanedTerms = Array.from(new Set(terms.map(cleanTranslationText).filter(hasChineseText))).slice(0, 5);
      if (cleanedTerms.length === 0) {
        continue;
      }
      const rawPartOfSpeech = cleanPartOfSpeech(Array.isArray(group) ? group[0] : group?.pos);
      const partOfSpeech = partOfSpeechLabels[rawPartOfSpeech.toLocaleLowerCase("en-US")] || rawPartOfSpeech;
      results.push({
        source: "google",
        text: cleanedTerms.join("；"),
        ...(partOfSpeech ? { partOfSpeech } : {})
      });
    }
    return sanitizeTranslationResults(results).slice(0, 4);
  }

  function extractWiktionaryTranslations(value, word) {
    if (typeof value !== "string") {
      return [];
    }

    const partOfSpeechAliases = new Map([
      ["名词", "名词"], ["名詞", "名词"], ["专有名词", "专有名词"], ["專有名詞", "专有名词"],
      ["动词", "动词"], ["動詞", "动词"], ["形容词", "形容词"], ["形容詞", "形容词"],
      ["副词", "副词"], ["副詞", "副词"], ["代词", "代词"], ["代詞", "代词"],
      ["介词", "介词"], ["介詞", "介词"], ["连词", "连词"], ["連詞", "连词"],
      ["感叹词", "感叹词"], ["感嘆詞", "感叹词"], ["数词", "数词"], ["數詞", "数词"],
      ["限定词", "限定词"], ["限定詞", "限定词"], ["短语", "短语"], ["短語", "短语"],
      ["习语", "习语"], ["習語", "习语"]
    ]);
    const results = [];
    const targetKey = normalizeKey(word);
    let inEnglishSection = false;
    let partOfSpeech = "";

    for (const rawLine of value.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim();
      const languageHeading = line.match(/^==\s*([^=]+?)\s*==$/);
      if (languageHeading) {
        inEnglishSection = /^(?:英语|英語)$/.test(languageHeading[1].trim());
        partOfSpeech = "";
        continue;
      }
      if (!inEnglishSection || !line) {
        continue;
      }

      const heading = line.match(/^===\s*([^=]+?)\s*===$/);
      if (heading) {
        partOfSpeech = partOfSpeechAliases.get(heading[1].trim()) || "";
        continue;
      }
      if (/^={3,}/.test(line)) {
        partOfSpeech = "";
        continue;
      }
      if (!partOfSpeech) {
        continue;
      }

      const text = cleanTranslationText(line.replace(/^(?:[-*#]+|\d+[.)、])\s*/, ""));
      const firstToken = text.split(/[\s（(]/, 1)[0];
      if (
        !text
        || !hasChineseText(text)
        || text.length > 120
        || (targetKey && normalizeKey(firstToken) === targetKey)
        || /^(?:近义词|近義詞|反义词|反義詞|同义词|同義詞|上位词|上位詞|下位词|下位詞|参见|參見|国际音标|國際音標|韵部|韻部|断字|斷字)[：:]/.test(text)
      ) {
        continue;
      }

      results.push({ source: "wiktionary", text, partOfSpeech });
      if (results.length >= 4) {
        break;
      }
    }

    return sanitizeTranslationResults(results);
  }

  function isValidHighlightColor(value) {
    return typeof value === "string" && HEX_COLOR_PATTERN.test(value.trim());
  }

  function normalizeHighlightColor(value) {
    return isValidHighlightColor(value)
      ? value.trim().toLocaleLowerCase("en-US")
      : DEFAULT_HIGHLIGHT_COLOR;
  }

  function normalizeCategoryId(value) {
    if (typeof value !== "string") {
      return "";
    }
    const id = value.trim().toLocaleLowerCase("en-US");
    return CATEGORY_ID_PATTERN.test(id) ? id : "";
  }

  function cleanCategoryName(value) {
    if (typeof value !== "string") {
      return "";
    }
    return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, MAX_CATEGORY_NAME_LENGTH);
  }

  function sanitizeCategories(value, legacyColor = DEFAULT_HIGHLIGHT_COLOR) {
    const stored = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const categories = {};
    const names = new Set();
    const storedDefault = stored[DEFAULT_CATEGORY_ID];
    const defaultName = cleanCategoryName(storedDefault?.name) || DEFAULT_CATEGORY_NAME;
    const defaultColor = normalizeHighlightColor(storedDefault?.color || legacyColor);
    categories[DEFAULT_CATEGORY_ID] = {
      id: DEFAULT_CATEGORY_ID,
      name: defaultName,
      color: defaultColor
    };
    names.add(defaultName.toLocaleLowerCase("zh-CN"));

    for (const category of Object.values(stored)) {
      if (Object.keys(categories).length >= MAX_CATEGORIES) {
        break;
      }
      if (!category || typeof category !== "object") {
        continue;
      }
      const id = normalizeCategoryId(category.id);
      const name = cleanCategoryName(category.name);
      const nameKey = name.toLocaleLowerCase("zh-CN");
      if (!id || id === DEFAULT_CATEGORY_ID || !name || names.has(nameKey) || categories[id]) {
        continue;
      }
      categories[id] = {
        id,
        name,
        color: normalizeHighlightColor(category.color)
      };
      names.add(nameKey);
    }
    return categories;
  }

  function resolveCategoryId(value, categories) {
    const id = normalizeCategoryId(value) || DEFAULT_CATEGORY_ID;
    if (!categories || typeof categories !== "object" || Array.isArray(categories)) {
      return id;
    }
    return categories[id] ? id : DEFAULT_CATEGORY_ID;
  }

  function getCategory(settings, categoryId) {
    const sanitizedSettings = settings?.categories?.[DEFAULT_CATEGORY_ID]
      ? settings
      : sanitizeSettings(settings);
    return sanitizedSettings.categories[resolveCategoryId(categoryId, sanitizedSettings.categories)]
      || sanitizedSettings.categories[DEFAULT_CATEGORY_ID];
  }

  function getCategoryColor(settings, categoryId) {
    return getCategory(settings, categoryId).color;
  }

  function sanitizeSettings(value) {
    const stored = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const categories = sanitizeCategories(stored.categories, stored.highlightColor);
    const storedSources = stored.translationSources && typeof stored.translationSources === "object"
      ? stored.translationSources
      : {};
    return {
      enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_SETTINGS.enabled,
      highlightColor: categories[DEFAULT_CATEGORY_ID].color,
      categories,
      translationSources: {
        mymemory: typeof storedSources.mymemory === "boolean"
          ? storedSources.mymemory
          : DEFAULT_TRANSLATION_SOURCES.mymemory,
        wiktionary: typeof storedSources.wiktionary === "boolean"
          ? storedSources.wiktionary
          : DEFAULT_TRANSLATION_SOURCES.wiktionary,
        google: typeof storedSources.google === "boolean"
          ? storedSources.google
          : DEFAULT_TRANSLATION_SOURCES.google
      },
      googleProxyUrl: normalizeGoogleProxyUrl(stored.googleProxyUrl)
    };
  }

  function getHighlightRgb(value) {
    const color = normalizeHighlightColor(value);
    return {
      red: Number.parseInt(color.slice(1, 3), 16),
      green: Number.parseInt(color.slice(3, 5), 16),
      blue: Number.parseInt(color.slice(5, 7), 16)
    };
  }

  function summarizeHistory(value) {
    if (value && typeof value === "object" && typeof value.canUndo === "boolean") {
      return {
        canUndo: value.canUndo,
        canRedo: Boolean(value.canRedo),
        undoLabel: typeof value.undoLabel === "string" ? value.undoLabel : "",
        redoLabel: typeof value.redoLabel === "string" ? value.redoLabel : ""
      };
    }

    const undo = value && Array.isArray(value.undo) ? value.undo : [];
    const redo = value && Array.isArray(value.redo) ? value.redo : [];
    const undoLabel = undo.at(-1)?.description;
    const redoLabel = redo.at(-1)?.description;
    return {
      canUndo: undo.length > 0,
      canRedo: redo.length > 0,
      undoLabel: typeof undoLabel === "string" ? undoLabel : "",
      redoLabel: typeof redoLabel === "string" ? redoLabel : ""
    };
  }

  function parseWordImportText(value, limit = MAX_IMPORT_WORDS) {
    const text = typeof value === "string" ? value.replace(/^\uFEFF/, "") : "";
    const maximum = Number.isInteger(limit) && limit > 0 ? limit : MAX_IMPORT_WORDS;
    const itemsByKey = new Map();
    const invalidLineNumbers = [];
    let invalidCount = 0;
    let duplicateCount = 0;
    let ignoredCount = 0;
    let overLimitCount = 0;
    let insideCodeFence = false;

    const lines = text.split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (/^(?:```|~~~)/.test(line)) {
        insideCodeFence = !insideCodeFence;
        ignoredCount += 1;
        continue;
      }
      if (
        !line
        || insideCodeFence
        || line.startsWith("#")
        || /^<!--.*-->$/.test(line)
        || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)
      ) {
        ignoredCount += 1;
        continue;
      }

      const parsed = parseImportLine(line);
      if (parsed.ignored) {
        ignoredCount += 1;
        continue;
      }

      const word = cleanWord(parsed.word);
      const translation = parsed.translation.trim().slice(0, 240);
      const key = normalizeKey(word);

      if (!key) {
        invalidCount += 1;
        if (invalidLineNumbers.length < 8) {
          invalidLineNumbers.push(index + 1);
        }
        continue;
      }

      const existing = itemsByKey.get(key);
      if (existing) {
        duplicateCount += 1;
        if (!existing.translation && translation) {
          existing.translation = translation;
        }
        continue;
      }

      if (itemsByKey.size >= maximum) {
        overLimitCount += 1;
        continue;
      }

      itemsByKey.set(key, { word, translation });
    }

    return {
      items: Array.from(itemsByKey.values()),
      invalidCount,
      invalidLineNumbers,
      duplicateCount,
      ignoredCount,
      overLimitCount
    };
  }

  function parseImportLine(value) {
    const tableCells = parseMarkdownTableCells(value);
    if (tableCells) {
      if (tableCells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
        return { ignored: true, word: "", translation: "" };
      }

      const word = unwrapMarkdownToken(tableCells[0]);
      if (/^(?:word|english|单词|英文)$/i.test(word)) {
        return { ignored: true, word: "", translation: "" };
      }
      return {
        ignored: false,
        word,
        translation: unwrapMarkdownToken(tableCells[1] || "")
      };
    }

    const line = value
      .replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, "")
      .trim();
    if (!line) {
      return { ignored: true, word: "", translation: "" };
    }

    const normalizedLine = line.replace(
      /^(\*\*|__|`|\*|_)([A-Za-z]+(?:['’\-][A-Za-z]+)*)\1/,
      "$2"
    );
    const matched = normalizedLine.match(
      /^([A-Za-z]+(?:['’\-][A-Za-z]+)*)(?:\t+|\s*[,，=:：]\s*|\s+(?:=>|->|[-–—])\s+)(.*)$/
    );
    if (matched) {
      return {
        ignored: false,
        word: unwrapMarkdownToken(matched[1]),
        translation: unwrapMarkdownToken(matched[2])
      };
    }

    return { ignored: false, word: unwrapMarkdownToken(normalizedLine), translation: "" };
  }

  function parseMarkdownTableCells(value) {
    if (!value.includes("|")) {
      return null;
    }

    const cells = value
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    return cells.length >= 2 ? cells : null;
  }

  function unwrapMarkdownToken(value) {
    let token = typeof value === "string" ? value.trim() : "";
    const wrappers = [["**", "**"], ["__", "__"], ["`", "`"], ["*", "*"], ["_", "_"]];
    for (const [start, end] of wrappers) {
      if (token.startsWith(start) && token.endsWith(end) && token.length > start.length + end.length) {
        token = token.slice(start.length, -end.length).trim();
        break;
      }
    }
    return token;
  }

  function decodeHtmlEntities(value) {
    if (typeof value !== "string") {
      return "";
    }

    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      quot: "\""
    };

    return value
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&(amp|apos|gt|lt|quot);/g, (_, name) => named[name]);
  }

  function hasChineseText(value) {
    return typeof value === "string" && HAN_PATTERN.test(value);
  }

  global.VocabGlowUtils = Object.freeze({
    STORAGE_KEYS,
    DEFAULT_HIGHLIGHT_COLOR,
    DEFAULT_CATEGORY_ID,
    DEFAULT_CATEGORY_NAME,
    DEFAULT_SETTINGS,
    MAX_CATEGORIES,
    MAX_CATEGORY_NAME_LENGTH,
    MAX_IMPORT_WORDS,
    MAX_IMPORT_FILE_BYTES,
    MAX_TRANSLATION_RESULTS,
    TRANSLATION_SOURCES,
    DEFAULT_TRANSLATION_SOURCES,
    cleanWord,
    isValidWord,
    normalizeKey,
    escapeRegExp,
    buildWordMatcher,
    sanitizeEntries,
    cleanTranslationText,
    sanitizeTranslationResults,
    getTranslationSourceLabel,
    normalizeGoogleProxyUrl,
    getGoogleProxyOriginPattern,
    extractGoogleTranslations,
    extractWiktionaryTranslations,
    isValidHighlightColor,
    normalizeHighlightColor,
    normalizeCategoryId,
    cleanCategoryName,
    sanitizeCategories,
    resolveCategoryId,
    getCategory,
    getCategoryColor,
    sanitizeSettings,
    getHighlightRgb,
    summarizeHistory,
    parseWordImportText,
    decodeHtmlEntities,
    hasChineseText
  });
})(globalThis);
