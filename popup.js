(function startPopup() {
  "use strict";

  const {
    STORAGE_KEYS,
    DEFAULT_HIGHLIGHT_COLOR,
    DEFAULT_CATEGORY_ID,
    DEFAULT_SETTINGS,
    MAX_CATEGORIES,
    MAX_IMPORT_WORDS,
    MAX_IMPORT_FILE_BYTES,
    cleanWord,
    isValidWord,
    normalizeKey,
    sanitizeEntries,
    normalizeHighlightColor,
    sanitizeSettings,
    getCategory,
    getCategoryColor,
    getHighlightRgb,
    getTranslationSourceLabel,
    normalizeGoogleProxyUrl,
    getGoogleProxyOriginPattern,
    summarizeHistory,
    parseWordImportText
  } = globalThis.VocabGlowUtils;

  let entries = {};
  let settings = { ...DEFAULT_SETTINGS };
  let managedCategoryId = DEFAULT_CATEGORY_ID;
  let history = summarizeHistory(null);
  let pendingImport = null;
  let noticeTimer = 0;

  const elements = {
    enabledToggle: document.getElementById("enabledToggle"),
    highlightColorInput: document.getElementById("highlightColorInput"),
    highlightColorValue: document.getElementById("highlightColorValue"),
    highlightPreview: document.getElementById("highlightPreview"),
    resetColorButton: document.getElementById("resetColorButton"),
    categoryManagerSelect: document.getElementById("categoryManagerSelect"),
    categoryNameInput: document.getElementById("categoryNameInput"),
    saveCategoryNameButton: document.getElementById("saveCategoryNameButton"),
    newCategoryButton: document.getElementById("newCategoryButton"),
    deleteCategoryButton: document.getElementById("deleteCategoryButton"),
    myMemorySourceToggle: document.getElementById("myMemorySourceToggle"),
    wiktionarySourceToggle: document.getElementById("wiktionarySourceToggle"),
    googleSourceToggle: document.getElementById("googleSourceToggle"),
    googleProxyUrlInput: document.getElementById("googleProxyUrlInput"),
    saveGoogleProxyButton: document.getElementById("saveGoogleProxyButton"),
    translationSourceCount: document.getElementById("translationSourceCount"),
    addForm: document.getElementById("addForm"),
    addButton: document.getElementById("addButton"),
    wordInput: document.getElementById("wordInput"),
    translationInput: document.getElementById("translationInput"),
    addCategorySelect: document.getElementById("addCategorySelect"),
    importFileButton: document.getElementById("importFileButton"),
    importFileInput: document.getElementById("importFileInput"),
    importDialog: document.getElementById("importDialog"),
    importCloseButton: document.getElementById("importCloseButton"),
    importCancelButton: document.getElementById("importCancelButton"),
    importConfirmButton: document.getElementById("importConfirmButton"),
    importFileName: document.getElementById("importFileName"),
    importReadyCount: document.getElementById("importReadyCount"),
    importExistingCount: document.getElementById("importExistingCount"),
    importIssueCount: document.getElementById("importIssueCount"),
    importDetail: document.getElementById("importDetail"),
    importPreviewList: document.getElementById("importPreviewList"),
    importCategorySelect: document.getElementById("importCategorySelect"),
    searchInput: document.getElementById("searchInput"),
    categoryFilterSelect: document.getElementById("categoryFilterSelect"),
    wordCount: document.getElementById("wordCount"),
    wordList: document.getElementById("wordList"),
    emptyState: document.getElementById("emptyState"),
    noResultState: document.getElementById("noResultState"),
    highlightStatus: document.getElementById("highlightStatus"),
    undoButton: document.getElementById("undoButton"),
    redoButton: document.getElementById("redoButton"),
    shortcutHelpButton: document.getElementById("shortcutHelpButton"),
    shortcutDialog: document.getElementById("shortcutDialog"),
    shortcutCloseButton: document.getElementById("shortcutCloseButton"),
    clearButton: document.getElementById("clearButton"),
    notice: document.getElementById("notice")
  };

  elements.addForm.addEventListener("submit", (event) => void handleAdd(event));
  elements.enabledToggle.addEventListener("change", () => void handleToggle());
  elements.highlightColorInput.addEventListener("input", handleColorPreview);
  elements.highlightColorInput.addEventListener("change", () => void handleColorChange());
  elements.resetColorButton.addEventListener("click", () => void handleColorReset());
  elements.categoryManagerSelect.addEventListener("change", handleManagedCategoryChange);
  elements.categoryNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleCategoryRename();
    }
  });
  elements.saveCategoryNameButton.addEventListener("click", () => void handleCategoryRename());
  elements.newCategoryButton.addEventListener("click", () => void handleCategoryCreate());
  elements.deleteCategoryButton.addEventListener("click", () => void handleCategoryDelete());
  elements.myMemorySourceToggle.addEventListener("change", () => void handleTranslationSourceChange("mymemory", elements.myMemorySourceToggle));
  elements.wiktionarySourceToggle.addEventListener("change", () => void handleTranslationSourceChange("wiktionary", elements.wiktionarySourceToggle));
  elements.googleSourceToggle.addEventListener("change", () => void handleTranslationSourceChange("google", elements.googleSourceToggle));
  elements.saveGoogleProxyButton.addEventListener("click", () => void handleGoogleProxySave());
  elements.googleProxyUrlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleGoogleProxySave();
    }
  });
  elements.importFileButton.addEventListener("click", () => {
    elements.importFileInput.value = "";
    elements.importFileInput.click();
  });
  elements.importFileInput.addEventListener("change", (event) => void handleImportFile(event));
  elements.importCloseButton.addEventListener("click", closeImportDialog);
  elements.importCancelButton.addEventListener("click", closeImportDialog);
  elements.importConfirmButton.addEventListener("click", () => void handleImportConfirm());
  elements.importDialog.addEventListener("close", resetImportDialog);
  elements.searchInput.addEventListener("input", render);
  elements.categoryFilterSelect.addEventListener("change", render);
  elements.wordList.addEventListener("click", (event) => void handleListClick(event));
  elements.wordList.addEventListener("change", (event) => void handleWordCategoryChange(event));
  elements.undoButton.addEventListener("click", () => void handleHistoryAction("UNDO_LAST_ACTION"));
  elements.redoButton.addEventListener("click", () => void handleHistoryAction("REDO_LAST_ACTION"));
  elements.shortcutHelpButton.addEventListener("click", showShortcutDialog);
  elements.shortcutCloseButton.addEventListener("click", () => elements.shortcutDialog.close());
  elements.clearButton.addEventListener("click", () => void handleClear());
  document.addEventListener("keydown", handleKeyboardShortcut);
  chrome.storage.onChanged.addListener(handleStorageChange);

  void loadState();
  loadCommandShortcuts();

  async function loadState() {
    try {
      const response = await sendMessage({ type: "GET_STATE" });
      if (!response.ok) {
        throw new Error(response.error || "读取词库失败");
      }
      settings = sanitizeSettings(response.settings);
      entries = sanitizeEntries(response.entries, settings.categories);
      history = summarizeHistory(response.history);
      render();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "读取词库失败", "error");
    }
  }

  async function handleAdd(event) {
    event.preventDefault();
    const word = cleanWord(elements.wordInput.value);
    const translation = elements.translationInput.value.trim();
    const categoryId = elements.addCategorySelect.value || DEFAULT_CATEGORY_ID;
    if (!isValidWord(word)) {
      showNotice("请输入一个完整的英文单词", "error");
      elements.wordInput.focus();
      return;
    }

    elements.addButton.disabled = true;
    try {
      const response = await sendMessage({ type: "ADD_WORD", word, translation, categoryId });
      if (!response.ok) {
        throw new Error(response.error || "添加失败");
      }
      applyHistoryResponse(response);
      elements.wordInput.value = "";
      elements.translationInput.value = "";
      elements.wordInput.focus();
      const detail = response.entry?.translation ? `已保存：${response.entry.translation}` : "已保存，可稍后补充翻译";
      showNotice(`${word} ${detail} · 可撤回`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "添加失败", "error");
    } finally {
      elements.addButton.disabled = false;
    }
  }

  async function handleTranslationSourceChange(source, toggle) {
    const enabled = toggle.checked;
    toggle.disabled = true;
    try {
      if (source === "google" && enabled) {
        if (!settings.googleProxyUrl) {
          throw new Error("请先保存 Google 反代接口地址");
        }
        if (!await requestGoogleProxyPermission(settings.googleProxyUrl)) {
          throw new Error("未授予反代地址访问权限，Google 保持关闭");
        }
      }
      const response = await sendMessage({ type: "SET_TRANSLATION_SOURCE", source, enabled });
      if (!response.ok) {
        throw new Error(response.error || "更新翻译来源失败");
      }
      settings = sanitizeSettings(response.settings);
      applyHistoryResponse(response);
      renderTranslationSources();
      const name = source === "wiktionary" ? "中文维基词典" : getTranslationSourceLabel(source);
      showNotice(`${name}已${enabled ? "开启" : "关闭"} · 可撤回`);
    } catch (error) {
      toggle.checked = !enabled;
      showNotice(error instanceof Error ? error.message : "更新翻译来源失败", "error");
    } finally {
      toggle.disabled = false;
    }
  }

  function requestGoogleProxyPermission(url) {
    const origin = getGoogleProxyOriginPattern(url);
    if (!origin || !chrome.permissions?.request) {
      throw new Error("无法申请反代地址访问权限，请重新加载扩展");
    }
    // Request immediately in the user gesture, before messaging the background.
    return chrome.permissions.request({ origins: [origin] });
  }

  async function handleGoogleProxySave() {
    const rawUrl = elements.googleProxyUrlInput.value.trim();
    const url = normalizeGoogleProxyUrl(rawUrl);
    elements.saveGoogleProxyButton.disabled = true;
    try {
      if (rawUrl && !url) {
        throw new Error("请输入 HTTPS 或本机 HTTP 完整接口地址，不带账号、查询参数或片段");
      }
      if (url && !await requestGoogleProxyPermission(url)) {
        throw new Error("未授予反代地址访问权限，原配置未改变");
      }
      const response = await sendMessage({ type: "SET_GOOGLE_PROXY_URL", url });
      if (!response.ok) {
        throw new Error(response.error || "保存反代地址失败");
      }
      settings = sanitizeSettings(response.settings);
      applyHistoryResponse(response);
      elements.googleProxyUrlInput.value = settings.googleProxyUrl;
      renderTranslationSources();
      showNotice(url ? "反代地址已保存，请开启 Google 或刷新单个词条 · 可撤回" : "反代地址已清除，Google 已关闭 · 可撤回");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "保存反代地址失败", "error");
    } finally {
      elements.saveGoogleProxyButton.disabled = false;
    }
  }

  async function handleImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!/\.(?:txt|md)$/i.test(file.name)) {
      showNotice("请选择 .txt 或 .md 文件", "error");
      return;
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      showNotice("文件不能超过 1 MiB", "error");
      return;
    }

    elements.importFileButton.disabled = true;
    try {
      const parsed = parseWordImportText(await file.text());
      if (parsed.items.length === 0) {
        throw new Error("文件中没有可识别的英文单词");
      }
      const newItems = parsed.items.filter((item) => !entries[normalizeKey(item.word)]);
      pendingImport = {
        fileName: file.name,
        items: parsed.items,
        newItems,
        existingCount: parsed.items.length - newItems.length,
        ...parsed
      };
      renderImportPreview();
      elements.importDialog.showModal();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "读取文件失败", "error");
    } finally {
      elements.importFileButton.disabled = false;
    }
  }

  function renderImportPreview() {
    if (!pendingImport) {
      return;
    }

    const issueCount = pendingImport.invalidCount
      + pendingImport.duplicateCount
      + pendingImport.overLimitCount;
    const details = [];
    if (pendingImport.duplicateCount) {
      details.push(`文件内重复 ${pendingImport.duplicateCount} 条`);
    }
    if (pendingImport.invalidCount) {
      const lineHint = pendingImport.invalidLineNumbers.length
        ? `（第 ${pendingImport.invalidLineNumbers.join("、")} 行）`
        : "";
      details.push(`无效 ${pendingImport.invalidCount} 条${lineHint}`);
    }
    if (pendingImport.overLimitCount) {
      details.push(`超过 ${MAX_IMPORT_WORDS} 条上限 ${pendingImport.overLimitCount} 条`);
    }
    if (pendingImport.ignoredCount) {
      details.push(`忽略空行/标题等 ${pendingImport.ignoredCount} 行`);
    }

    elements.importFileName.textContent = pendingImport.fileName;
    elements.importReadyCount.textContent = String(pendingImport.newItems.length);
    elements.importExistingCount.textContent = String(pendingImport.existingCount);
    elements.importIssueCount.textContent = String(issueCount);
    elements.importDetail.textContent = details.join("；") || "所有内容均可识别。";
    elements.importPreviewList.replaceChildren(
      ...pendingImport.newItems.slice(0, 10).map(createImportPreviewItem)
    );
    if (pendingImport.newItems.length === 0) {
      const empty = document.createElement("li");
      empty.className = "import-preview-empty";
      empty.textContent = "没有需要新增的单词";
      elements.importPreviewList.append(empty);
    }
    elements.importConfirmButton.disabled = pendingImport.newItems.length === 0;
    elements.importConfirmButton.textContent = pendingImport.newItems.length
      ? `导入 ${pendingImport.newItems.length} 个`
      : "无需导入";
  }

  function createImportPreviewItem(item) {
    const row = document.createElement("li");
    const word = document.createElement("span");
    const translation = document.createElement("span");
    word.className = "import-preview-word";
    translation.className = "import-preview-translation";
    word.textContent = item.word;
    translation.textContent = item.translation || "待补充 / 可主动翻译";
    row.append(word, translation);
    return row;
  }

  async function handleImportConfirm() {
    if (!pendingImport || pendingImport.newItems.length === 0) {
      return;
    }

    const requestedCount = pendingImport.newItems.length;
    setImportDialogBusy(true);
    try {
      const response = await sendMessage({
        type: "IMPORT_WORDS",
        items: pendingImport.items,
        categoryId: elements.importCategorySelect.value || DEFAULT_CATEGORY_ID
      });
      if (!response.ok) {
        throw new Error(response.error || "批量导入失败");
      }
      applyHistoryResponse(response);
      elements.importDialog.close();
      const untranslated = response.untranslatedCount
        ? `，${response.untranslatedCount} 个待补充释义`
        : "";
      const skipped = response.skippedExistingCount
        ? `，跳过 ${response.skippedExistingCount} 个已有词`
        : "";
      showNotice(`已导入 ${response.importedCount} 个生词${untranslated}${skipped} · 可撤回`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "批量导入失败", "error");
      setImportDialogBusy(false, requestedCount);
    }
  }

  function setImportDialogBusy(busy, count = pendingImport?.newItems.length || 0) {
    elements.importCloseButton.disabled = busy;
    elements.importCancelButton.disabled = busy;
    elements.importConfirmButton.disabled = busy || count === 0;
    elements.importConfirmButton.textContent = busy ? "正在导入…" : count ? `导入 ${count} 个` : "无需导入";
  }

  function closeImportDialog() {
    if (!elements.importConfirmButton.disabled || pendingImport?.newItems.length === 0) {
      elements.importDialog.close();
    }
  }

  function resetImportDialog() {
    pendingImport = null;
    elements.importPreviewList.replaceChildren();
    setImportDialogBusy(false, 0);
  }

  async function handleToggle() {
    const enabled = elements.enabledToggle.checked;
    elements.enabledToggle.disabled = true;
    try {
      const response = await sendMessage({ type: "SET_ENABLED", enabled });
      if (!response.ok) {
        throw new Error(response.error || "设置失败");
      }
      settings = sanitizeSettings(response.settings);
      applyHistoryResponse(response);
      renderStatus();
      showNotice(enabled ? "网页高亮已开启" : "网页高亮已暂停");
    } catch (error) {
      elements.enabledToggle.checked = !enabled;
      showNotice(error instanceof Error ? error.message : "设置失败", "error");
    } finally {
      elements.enabledToggle.disabled = false;
    }
  }

  function handleColorPreview() {
    renderColorPreview(elements.highlightColorInput.value);
  }

  async function handleColorChange() {
    await saveCategoryColor(elements.highlightColorInput.value, "分类颜色已更新");
  }

  async function handleColorReset() {
    await saveCategoryColor(DEFAULT_HIGHLIGHT_COLOR, "已恢复默认分类颜色");
  }

  async function saveCategoryColor(color, successMessage) {
    const category = getManagedCategory();
    if (!category) {
      return;
    }
    elements.highlightColorInput.disabled = true;
    elements.resetColorButton.disabled = true;
    try {
      const response = await sendMessage({
        type: "UPDATE_CATEGORY",
        categoryId: category.id,
        color
      });
      if (!response.ok) {
        throw new Error(response.error || "颜色设置失败");
      }
      settings = sanitizeSettings(response.settings);
      applyHistoryResponse(response);
      renderCategoryControls();
      renderColorSetting();
      showNotice(successMessage);
    } catch (error) {
      renderColorSetting();
      showNotice(error instanceof Error ? error.message : "颜色设置失败", "error");
    } finally {
      elements.highlightColorInput.disabled = false;
      elements.resetColorButton.disabled = getManagedCategory()?.color === DEFAULT_HIGHLIGHT_COLOR;
    }
  }

  function handleManagedCategoryChange() {
    managedCategoryId = elements.categoryManagerSelect.value || DEFAULT_CATEGORY_ID;
    renderCategoryEditor();
    renderColorSetting();
  }

  async function handleCategoryCreate() {
    if (Object.keys(settings.categories).length >= MAX_CATEGORIES) {
      showNotice(`最多创建 ${MAX_CATEGORIES} 个分类`, "error");
      return;
    }
    const name = window.prompt("输入新分类名称：");
    if (name === null) {
      return;
    }
    elements.newCategoryButton.disabled = true;
    try {
      const response = await sendMessage({
        type: "CREATE_CATEGORY",
        name,
        color: getSuggestedCategoryColor()
      });
      if (!response.ok) {
        throw new Error(response.error || "新建分类失败");
      }
      settings = sanitizeSettings(response.settings);
      managedCategoryId = response.category.id;
      applyHistoryResponse(response);
      render();
      showNotice(`已新建分类：${response.category.name} · 可撤回`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "新建分类失败", "error");
    } finally {
      elements.newCategoryButton.disabled = Object.keys(settings.categories).length >= MAX_CATEGORIES;
    }
  }

  async function handleCategoryRename() {
    const category = getManagedCategory();
    if (!category) {
      return;
    }
    const name = elements.categoryNameInput.value.trim();
    if (name === category.name) {
      showNotice("分类名称没有变化");
      return;
    }
    elements.saveCategoryNameButton.disabled = true;
    try {
      const response = await sendMessage({
        type: "UPDATE_CATEGORY",
        categoryId: category.id,
        name
      });
      if (!response.ok) {
        throw new Error(response.error || "分类改名失败");
      }
      settings = sanitizeSettings(response.settings);
      applyHistoryResponse(response);
      render();
      showNotice(`分类已改名为：${response.category.name} · 可撤回`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "分类改名失败", "error");
    } finally {
      elements.saveCategoryNameButton.disabled = false;
    }
  }

  async function handleCategoryDelete() {
    const category = getManagedCategory();
    if (!category || category.id === DEFAULT_CATEGORY_ID) {
      return;
    }
    const count = Object.values(entries).filter((entry) => entry.categoryId === category.id).length;
    if (!window.confirm(`删除分类“${category.name}”吗？其中 ${count} 个生词会移到默认分类。`)) {
      return;
    }
    elements.deleteCategoryButton.disabled = true;
    try {
      const response = await sendMessage({ type: "DELETE_CATEGORY", categoryId: category.id });
      if (!response.ok) {
        throw new Error(response.error || "删除分类失败");
      }
      settings = sanitizeSettings(response.settings);
      managedCategoryId = DEFAULT_CATEGORY_ID;
      applyHistoryResponse(response);
      render();
      showNotice(`分类已删除，${response.movedCount} 个生词移到默认分类 · 可撤回`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "删除分类失败", "error");
    } finally {
      elements.deleteCategoryButton.disabled = managedCategoryId === DEFAULT_CATEGORY_ID;
    }
  }

  async function handleWordCategoryChange(event) {
    const select = event.target.closest("select.word-category-select");
    if (!select) {
      return;
    }
    const item = select.closest(".word-item");
    const key = item?.dataset.key || "";
    const entry = entries[key];
    if (!entry) {
      return;
    }
    const previousCategoryId = entry.categoryId;
    select.disabled = true;
    try {
      const response = await sendMessage({ type: "MOVE_WORD", key, categoryId: select.value });
      if (!response.ok) {
        throw new Error(response.error || "移动分类失败");
      }
      entries[key] = response.entry;
      applyHistoryResponse(response);
      render();
      showNotice(`${entry.word} 已移到“${response.category.name}” · 可撤回`);
    } catch (error) {
      select.value = previousCategoryId;
      select.disabled = false;
      showNotice(error instanceof Error ? error.message : "移动分类失败", "error");
    }
  }

  function getSuggestedCategoryColor() {
    const palette = ["#7dd3fc", "#c4b5fd", "#86efac", "#fda4af", "#fdba74", "#67e8f9", "#f0abfc"];
    return palette[(Object.keys(settings.categories).length - 1) % palette.length];
  }

  async function handleListClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const item = button.closest(".word-item");
    const key = item?.dataset.key || "";
    const entry = entries[key];
    if (!entry) {
      return;
    }

    const action = button.dataset.action;
    if (action === "edit") {
      item.querySelector(".edit-panel")?.classList.remove("hidden");
      const input = item.querySelector(".edit-input");
      input?.focus();
      input?.select();
      return;
    }

    if (action === "cancel") {
      item.querySelector(".edit-panel")?.classList.add("hidden");
      return;
    }

    button.disabled = true;
    try {
      if (action === "delete") {
        const response = await sendMessage({ type: "REMOVE_WORD", key });
        if (!response.ok) {
          throw new Error(response.error || "删除失败");
        }
        applyHistoryResponse(response);
        showNotice(`${entry.word} 已移出词库 · 可撤回`);
      } else if (action === "retry") {
        const response = await sendMessage({ type: "RETRY_TRANSLATION", key });
        if (!response.ok) {
          throw new Error(response.error || "翻译失败");
        }
        applyHistoryResponse(response);
        showNotice(response.entry?.translation ? `翻译完成：${response.entry.translation}` : "仍未找到合适的翻译");
      } else if (action === "save") {
        const translation = item.querySelector(".edit-input")?.value.trim() || "";
        const response = await sendMessage({ type: "UPDATE_TRANSLATION", key, translation });
        if (!response.ok) {
          throw new Error(response.error || "保存失败");
        }
        applyHistoryResponse(response);
        showNotice(`${entry.word} 的翻译已更新`);
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "操作失败", "error");
      button.disabled = false;
    }
  }

  async function handleClear() {
    const count = Object.keys(entries).length;
    if (count === 0 || !window.confirm(`确定清空全部 ${count} 个生词吗？`)) {
      return;
    }

    elements.clearButton.disabled = true;
    try {
      const response = await sendMessage({ type: "CLEAR_WORDS" });
      if (!response.ok) {
        throw new Error(response.error || "清空失败");
      }
      applyHistoryResponse(response);
      showNotice("词库已清空 · 可撤回");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "清空失败", "error");
    } finally {
      elements.clearButton.disabled = Object.keys(entries).length === 0;
    }
  }

  function handleStorageChange(changes, areaName) {
    if (areaName === "session" && changes[STORAGE_KEYS.history]) {
      history = summarizeHistory(changes[STORAGE_KEYS.history].newValue);
      renderHistoryActions();
      return;
    }
    if (areaName !== "local") {
      return;
    }
    if (changes[STORAGE_KEYS.settings]) {
      settings = sanitizeSettings(changes[STORAGE_KEYS.settings].newValue);
    }
    if (changes[STORAGE_KEYS.entries]) {
      entries = sanitizeEntries(changes[STORAGE_KEYS.entries].newValue, settings.categories);
    } else if (changes[STORAGE_KEYS.settings]) {
      entries = sanitizeEntries(entries, settings.categories);
    }
    render();
  }

  function render() {
    renderCategoryControls();
    const allEntries = Object.values(entries).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const query = elements.searchInput.value.trim().toLocaleLowerCase("zh-CN");
    const categoryFilter = elements.categoryFilterSelect.value;
    const visibleEntries = allEntries.filter((entry) => {
      if (categoryFilter && entry.categoryId !== categoryFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      const categoryName = getCategory(settings, entry.categoryId).name;
      const translations = entry.translationResults.map((result) => result.text).join(" ");
      return `${entry.word} ${translations} ${categoryName}`.toLocaleLowerCase("zh-CN").includes(query);
    });

    elements.wordCount.textContent = String(allEntries.length);
    elements.wordList.replaceChildren(...visibleEntries.map(createWordItem));
    elements.emptyState.classList.toggle("hidden", allEntries.length !== 0);
    elements.noResultState.classList.toggle("hidden", allEntries.length === 0 || visibleEntries.length !== 0);
    elements.wordList.classList.toggle("hidden", visibleEntries.length === 0);
    elements.clearButton.disabled = allEntries.length === 0;
    renderStatus();
    renderTranslationSources();
    renderColorSetting();
    renderHistoryActions();
  }

  function renderCategoryControls() {
    const categoryIds = Object.keys(settings.categories);
    if (!settings.categories[managedCategoryId]) {
      managedCategoryId = DEFAULT_CATEGORY_ID;
    }
    replaceCategoryOptions(elements.categoryManagerSelect, managedCategoryId);
    managedCategoryId = elements.categoryManagerSelect.value || DEFAULT_CATEGORY_ID;
    replaceCategoryOptions(elements.addCategorySelect, elements.addCategorySelect.value || DEFAULT_CATEGORY_ID);
    replaceCategoryOptions(elements.importCategorySelect, elements.importCategorySelect.value || elements.addCategorySelect.value || DEFAULT_CATEGORY_ID);
    replaceCategoryOptions(elements.categoryFilterSelect, elements.categoryFilterSelect.value, true);
    elements.newCategoryButton.disabled = categoryIds.length >= MAX_CATEGORIES;
    renderCategoryEditor();
  }

  function replaceCategoryOptions(select, preferredValue, includeAll = false) {
    const options = [];
    if (includeAll) {
      const all = document.createElement("option");
      all.value = "";
      all.textContent = "全部分类";
      options.push(all);
    }
    for (const category of Object.values(settings.categories)) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      options.push(option);
    }
    select.replaceChildren(...options);
    const fallback = includeAll ? "" : DEFAULT_CATEGORY_ID;
    select.value = (settings.categories[preferredValue] || (includeAll && preferredValue === ""))
      ? preferredValue
      : fallback;
  }

  function renderCategoryEditor() {
    const category = getManagedCategory();
    if (!category) {
      return;
    }
    elements.categoryNameInput.value = category.name;
    elements.deleteCategoryButton.disabled = category.id === DEFAULT_CATEGORY_ID;
  }

  function getManagedCategory() {
    return settings.categories[managedCategoryId] || settings.categories[DEFAULT_CATEGORY_ID];
  }

  function renderStatus() {
    elements.enabledToggle.checked = Boolean(settings.enabled);
    elements.highlightStatus.textContent = settings.enabled ? "网页高亮已开启" : "网页高亮已暂停";
  }

  function renderTranslationSources() {
    elements.myMemorySourceToggle.checked = Boolean(settings.translationSources.mymemory);
    elements.wiktionarySourceToggle.checked = Boolean(settings.translationSources.wiktionary);
    elements.googleSourceToggle.checked = Boolean(settings.translationSources.google);
    if (document.activeElement !== elements.googleProxyUrlInput) {
      elements.googleProxyUrlInput.value = settings.googleProxyUrl;
    }
    const enabledCount = Object.values(settings.translationSources).filter(Boolean).length;
    elements.translationSourceCount.textContent = `${enabledCount} 个已启用`;
  }

  function renderColorSetting() {
    const highlightColor = normalizeHighlightColor(getManagedCategory()?.color || DEFAULT_HIGHLIGHT_COLOR);
    elements.highlightColorInput.value = highlightColor;
    elements.resetColorButton.disabled = highlightColor === DEFAULT_HIGHLIGHT_COLOR;
    renderColorPreview(highlightColor);
  }

  function renderColorPreview(highlightColor) {
    const color = normalizeHighlightColor(highlightColor);
    const { red, green, blue } = getHighlightRgb(color);
    elements.highlightColorValue.textContent = color.toLocaleUpperCase("en-US");
    elements.highlightPreview.style.setProperty("--preview-rgb", `${red} ${green} ${blue}`);
  }

  function renderHistoryActions() {
    elements.undoButton.disabled = !history.canUndo;
    elements.redoButton.disabled = !history.canRedo;
    elements.undoButton.title = history.canUndo
      ? `撤回：${history.undoLabel}（Ctrl/Command + Z）`
      : "没有可撤回的操作";
    elements.redoButton.title = history.canRedo
      ? `重做：${history.redoLabel}（Ctrl + Y 或 Command + Shift + Z）`
      : "没有可重做的操作";
  }

  function applyHistoryResponse(response) {
    if (!response?.history) {
      return;
    }
    history = summarizeHistory(response.history);
    renderHistoryActions();
  }

  async function handleHistoryAction(type) {
    elements.undoButton.disabled = true;
    elements.redoButton.disabled = true;
    try {
      const response = await sendMessage({ type });
      if (!response.ok) {
        throw new Error(response.error || "历史操作失败");
      }
      applyHistoryResponse(response);
      showNotice(response.message || "操作完成");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "历史操作失败", "error");
      renderHistoryActions();
    }
  }

  function handleKeyboardShortcut(event) {
    if (event.defaultPrevented || elements.shortcutDialog.open || elements.importDialog.open) {
      return;
    }

    const key = event.key.toLocaleLowerCase("en-US");
    const editingTarget = isEditingTarget(event.target);
    if (editingTarget && event.key !== "Escape") {
      return;
    }

    const primaryModifier = event.ctrlKey || event.metaKey;
    if (primaryModifier && key === "z" && !event.altKey) {
      event.preventDefault();
      void handleHistoryAction(event.shiftKey ? "REDO_LAST_ACTION" : "UNDO_LAST_ACTION");
      return;
    }

    if (primaryModifier && key === "y" && !event.altKey) {
      event.preventDefault();
      void handleHistoryAction("REDO_LAST_ACTION");
      return;
    }

    if (key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      elements.searchInput.focus();
      return;
    }

    if (event.key === "Escape") {
      let handled = false;
      const editPanels = elements.wordList.querySelectorAll(".edit-panel:not(.hidden)");
      for (const panel of editPanels) {
        panel.classList.add("hidden");
        handled = true;
      }
      if (elements.searchInput.value) {
        elements.searchInput.value = "";
        render();
        handled = true;
      }
      if (handled) {
        event.preventDefault();
      }
    }
  }

  function isEditingTarget(target) {
    return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  }

  function showShortcutDialog() {
    if (!elements.shortcutDialog.open) {
      elements.shortcutDialog.showModal();
    }
  }

  function loadCommandShortcuts() {
    chrome.commands.getAll((commands) => {
      if (chrome.runtime.lastError) {
        return;
      }
      for (const command of commands) {
        const element = elements.shortcutDialog.querySelector(`[data-command="${command.name}"]`);
        if (element) {
          element.textContent = command.shortcut || "未设置";
        }
      }
    });
  }

  function createWordItem(entry) {
    const item = document.createElement("article");
    item.className = "word-item";
    item.dataset.key = entry.key;
    item.innerHTML = `
      <div class="word-top">
        <div class="word-copy">
          <h3 class="word-name"></h3>
          <div class="word-translations"></div>
        </div>
        <div class="word-actions">
          <button class="icon-button retry-button hidden" data-action="retry" type="button" title="刷新多来源翻译" aria-label="刷新多来源翻译">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8 8 0 1 0-2.34 5.66"></path><path d="M20 4v7h-7"></path></svg>
          </button>
          <button class="icon-button" data-action="edit" type="button" title="修改翻译" aria-label="修改翻译">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
          </button>
          <button class="icon-button danger" data-action="delete" type="button" title="移出词库" aria-label="移出词库">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 15H6L5 6"></path></svg>
          </button>
        </div>
      </div>
      <div class="word-meta-row">
        <label class="category-select-wrap">
          <span class="category-dot" aria-hidden="true"></span>
          <span class="sr-only">所属分类</span>
          <select class="word-category-select" aria-label="移动到分类"></select>
        </label>
        <p class="word-meta"></p>
      </div>
      <div class="edit-panel hidden">
        <input class="edit-input" type="text" maxlength="240" aria-label="中文翻译">
        <button class="mini-button" data-action="save" type="button">保存</button>
        <button class="mini-button secondary" data-action="cancel" type="button">取消</button>
      </div>
    `;

    item.querySelector(".word-name").textContent = entry.word;
    const translationElement = item.querySelector(".word-translations");
    const retryButton = item.querySelector(".retry-button");
    renderWordTranslations(translationElement, entry);
    if (entry.translationStatus !== "loading") {
      retryButton.classList.remove("hidden");
    }
    const categorySelect = item.querySelector(".word-category-select");
    replaceCategoryOptions(categorySelect, entry.categoryId);
    const { red, green, blue } = getHighlightRgb(getCategoryColor(settings, entry.categoryId));
    item.querySelector(".category-dot").style.setProperty("--category-rgb", `${red} ${green} ${blue}`);
    item.querySelector(".word-meta").textContent = `更新于 ${formatDate(entry.updatedAt)}`;
    item.querySelector(".edit-input").value = entry.translation;
    return item;
  }

  function renderWordTranslations(container, entry) {
    const nodes = entry.translationResults.map((result) => {
      const row = document.createElement("div");
      row.className = "translation-result";
      const source = document.createElement("span");
      source.className = "translation-source";
      source.textContent = `${getTranslationSourceLabel(result.source)}${result.partOfSpeech ? ` · ${result.partOfSpeech}` : ""}`;
      const text = document.createElement("span");
      text.className = "translation-text";
      text.textContent = result.text;
      row.append(source, text);
      return row;
    });

    if (entry.translationStatus === "loading") {
      const state = document.createElement("p");
      state.className = "translation-state";
      state.textContent = entry.translationResults.length > 0 ? "正在刷新其他来源…" : "正在获取中文翻译…";
      nodes.push(state);
    } else if (entry.translationResults.length === 0) {
      const state = document.createElement("p");
      state.className = "translation-state error";
      state.textContent = "未获取到翻译，可手工补充或刷新";
      nodes.push(state);
    }
    container.replaceChildren(...nodes);
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "刚刚";
    }
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function showNotice(message, variant = "default") {
    window.clearTimeout(noticeTimer);
    elements.notice.textContent = message;
    elements.notice.className = `notice ${variant === "error" ? "error" : ""}`.trim();
    elements.notice.classList.remove("hidden");
    noticeTimer = window.setTimeout(() => elements.notice.classList.add("hidden"), 2300);
  }

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }
})();
