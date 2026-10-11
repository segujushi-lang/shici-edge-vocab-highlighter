(() => {
  const now = new Date().toISOString();
  const state = {
    entries: {
      serendipity: {
        key: "serendipity",
        word: "Serendipity",
        translation: "意外发现",
        translationResults: [
          { source: "mymemory", text: "意外发现" },
          { source: "mymemory", text: "机缘" },
          { source: "wiktionary", text: "机缘巧合", partOfSpeech: "名词" }
        ],
        translationStatus: "ready",
        createdAt: now,
        updatedAt: now,
        sourceUrl: "",
        translationRequestId: "",
        categoryId: "study"
      }
    },
    settings: {
      enabled: true,
      highlightColor: "#ffdd57",
      categories: {
        default: { id: "default", name: "默认分类", color: "#ffdd57" },
        study: { id: "study", name: "考试重点", color: "#7dd3fc" }
      },
      translationSources: { mymemory: true, wiktionary: true, google: false },
      googleProxyUrl: ""
    },
    history: { canUndo: true, canRedo: false, undoLabel: "添加 Serendipity", redoLabel: "" }
  };
  const storageListeners = [];
  let categorySequence = 0;

  function emitLocal(changes) {
    for (const listener of storageListeners) {
      listener(changes, "local");
    }
  }

  globalThis.__popupMessages = [];
  globalThis.__popupPermissionRequests = [];
  globalThis.chrome = {
    permissions: {
      async request(permission) {
        globalThis.__popupPermissionRequests.push(permission);
        return globalThis.__popupPermissionGranted !== false;
      }
    },
    commands: {
      getAll(callback) {
        callback([
          { name: "_execute_action", shortcut: "Alt+Shift+S" },
          { name: "toggle-highlighting", shortcut: "Alt+Shift+H" },
          { name: "undo-last-action", shortcut: "Alt+Shift+Z" },
          { name: "redo-last-action", shortcut: "Alt+Shift+Y" }
        ]);
      }
    },
    runtime: {
      lastError: null,
      async sendMessage(message) {
        globalThis.__popupMessages.push(message);
        if (message.type === "GET_STATE") {
          return { ok: true, ...state };
        }
        if (message.type === "UNDO_LAST_ACTION") {
          state.history = { canUndo: false, canRedo: true, undoLabel: "", redoLabel: "添加 Serendipity" };
          return { ok: true, changed: true, message: "已撤回：添加 Serendipity", history: state.history };
        }
        if (message.type === "REDO_LAST_ACTION") {
          state.history = { canUndo: true, canRedo: false, undoLabel: "添加 Serendipity", redoLabel: "" };
          return { ok: true, changed: true, message: "已重做：添加 Serendipity", history: state.history };
        }
        if (message.type === "CREATE_CATEGORY") {
          categorySequence += 1;
          const id = `cat-mock-${categorySequence}`;
          const category = { id, name: String(message.name || "新分类").trim(), color: message.color || "#86efac" };
          state.settings.categories[id] = category;
          state.history = { canUndo: true, canRedo: false, undoLabel: `新建分类 ${category.name}`, redoLabel: "" };
          emitLocal({ vocabSettings: { newValue: state.settings } });
          return { ok: true, category, settings: state.settings, history: state.history };
        }
        if (message.type === "UPDATE_CATEGORY") {
          const category = state.settings.categories[message.categoryId];
          if (!category) {
            return { ok: false, error: "所选分类不存在" };
          }
          if (message.name !== undefined) {
            category.name = String(message.name).trim();
          }
          if (message.color !== undefined) {
            category.color = message.color;
            if (category.id === "default") {
              state.settings.highlightColor = message.color;
            }
          }
          state.history = { canUndo: true, canRedo: false, undoLabel: `更新分类 ${category.name}`, redoLabel: "" };
          emitLocal({ vocabSettings: { newValue: state.settings } });
          return { ok: true, category, settings: state.settings, history: state.history };
        }
        if (message.type === "SET_GOOGLE_PROXY_URL") {
          state.settings.googleProxyUrl = message.url;
          if (!message.url) state.settings.translationSources.google = false;
          state.history = { canUndo: true, canRedo: false, undoLabel: "修改反代地址", redoLabel: "" };
          emitLocal({ vocabSettings: { newValue: state.settings } });
          return { ok: true, settings: state.settings, history: state.history };
        }
        if (message.type === "SET_TRANSLATION_SOURCE") {
          state.settings.translationSources[message.source] = Boolean(message.enabled);
          state.history = { canUndo: true, canRedo: false, undoLabel: "修改翻译来源", redoLabel: "" };
          emitLocal({ vocabSettings: { newValue: state.settings } });
          return { ok: true, settings: state.settings, history: state.history };
        }
        if (message.type === "DELETE_CATEGORY") {
          const category = state.settings.categories[message.categoryId];
          let movedCount = 0;
          for (const entry of Object.values(state.entries)) {
            if (entry.categoryId === message.categoryId) {
              entry.categoryId = "default";
              movedCount += 1;
            }
          }
          delete state.settings.categories[message.categoryId];
          emitLocal({
            vocabEntries: { newValue: state.entries },
            vocabSettings: { newValue: state.settings }
          });
          return { ok: true, categoryName: category?.name || "", movedCount, settings: state.settings, history: state.history };
        }
        if (message.type === "MOVE_WORD") {
          const key = String(message.key || "").toLocaleLowerCase("en-US");
          const entry = state.entries[key];
          const category = state.settings.categories[message.categoryId];
          if (!entry || !category) {
            return { ok: false, error: "移动失败" };
          }
          entry.categoryId = category.id;
          emitLocal({ vocabEntries: { newValue: state.entries } });
          return { ok: true, entry, category, history: state.history };
        }
        if (message.type === "IMPORT_WORDS") {
          let importedCount = 0;
          let skippedExistingCount = 0;
          let untranslatedCount = 0;
          for (const item of message.items || []) {
            const key = String(item.word || "").toLocaleLowerCase("en-US");
            if (!key || state.entries[key]) {
              skippedExistingCount += 1;
              continue;
            }
            state.entries[key] = {
              key,
              word: item.word,
              translation: item.translation || "",
              translationResults: item.translation ? [{ source: "import", text: item.translation }] : [],
              translationStatus: item.translation ? "ready" : "error",
              createdAt: now,
              updatedAt: now,
              sourceUrl: "",
              translationRequestId: "",
              categoryId: message.categoryId || "default"
            };
            importedCount += 1;
            if (!item.translation) {
              untranslatedCount += 1;
            }
          }
          state.history = {
            canUndo: importedCount > 0,
            canRedo: false,
            undoLabel: `批量导入 ${importedCount} 个生词`,
            redoLabel: ""
          };
          emitLocal({ vocabEntries: { newValue: state.entries } });
          return {
            ok: true,
            importedCount,
            skippedExistingCount,
            untranslatedCount,
            history: state.history
          };
        }
        return { ok: true, ...state };
      }
    },
    storage: {
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    }
  };
})();
