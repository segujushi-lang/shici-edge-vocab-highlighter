const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const root = resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));

test("manifest is a loadable MV3 extension with the required APIs", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.ok(manifest.host_permissions.includes("https://api.mymemory.translated.net/*"));
  assert.ok(manifest.host_permissions.includes("https://zh.wiktionary.org/*"));
  assert.equal(manifest.background.service_worker, "background.js");
});

test("Google proxy access is optional and configured explicitly", () => {
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
  assert.ok(manifest.optional_host_permissions.includes("http://127.0.0.1/*"));
  assert.equal(manifest.host_permissions.includes("https://*/*"), false);
  const html = readFileSync(resolve(root, "popup.html"), "utf8");
  const script = readFileSync(resolve(root, "popup.js"), "utf8");
  assert.match(html, /id="googleSourceToggle"(?![^>]+checked)/);
  assert.match(html, /id="googleProxyUrlInput"/);
  assert.match(script, /chrome\.permissions\.request\(\{ origins: \[origin\] \}\)/);
  assert.match(script, /type: "SET_GOOGLE_PROXY_URL", url/);
});

test("every local file referenced by the manifest exists", () => {
  const paths = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((script) => [...script.js, ...script.css])
  ];
  for (const path of paths) {
    assert.equal(existsSync(resolve(root, path)), true, `Missing manifest file: ${path}`);
  }
});

test("content script runs on ordinary HTTP and HTTPS pages", () => {
  const matches = manifest.content_scripts[0].matches;
  assert.deepEqual(matches, ["http://*/*", "https://*/*"]);
});

test("color picker previews the highlight with dark and light page text", () => {
  const popupHtml = readFileSync(resolve(root, "popup.html"), "utf8");
  const popupCss = readFileSync(resolve(root, "popup.css"), "utf8");
  assert.match(popupHtml, /class="preview-surface preview-light"/);
  assert.match(popupHtml, /class="preview-surface preview-dark"/);
  assert.match(popupCss, /\.preview-dark\s*\{[^}]*color:\s*#f8fafc/s);
  assert.match(popupCss, /rgb\(var\(--preview-rgb\)\s*\/\s*82%\)/);
});

test("popup width follows available space when a vertical scrollbar is present", () => {
  const popupCss = readFileSync(resolve(root, "popup.css"), "utf8");
  assert.match(popupCss, /body\s*\{[^}]*max-width:\s*100%;/s);
});

test("extension commands use explicit modifier shortcuts and stay within the browser limit", () => {
  const commands = Object.values(manifest.commands || {});
  assert.equal(commands.length, 4);
  for (const command of commands) {
    assert.match(command.suggested_key.default, /^(Alt|Ctrl)\+/);
  }
  assert.ok(manifest.commands["undo-last-action"]);
  assert.ok(manifest.commands["redo-last-action"]);
  assert.ok(manifest.commands["toggle-highlighting"]);
});

test("content interaction preserves normal website clicks and requires Alt or Option", () => {
  const contentScript = readFileSync(resolve(root, "content.js"), "utf8");
  assert.match(contentScript, /return event\.altKey && !event\.ctrlKey && !event\.metaKey && !event\.shiftKey/);
  assert.match(contentScript, /event\.stopImmediatePropagation\(\)/);
  assert.match(contentScript, /按住 Alt（macOS 为 Option）点击查看中文翻译/);
});

test("popup exposes common undo, redo, search, and escape shortcuts", () => {
  const popupHtml = readFileSync(resolve(root, "popup.html"), "utf8");
  const popupScript = readFileSync(resolve(root, "popup.js"), "utf8");
  assert.match(popupHtml, /id="undoButton"/);
  assert.match(popupHtml, /id="redoButton"/);
  assert.match(popupHtml, /id="shortcutDialog"/);
  assert.match(popupScript, /UNDO_LAST_ACTION/);
  assert.match(popupScript, /REDO_LAST_ACTION/);
  assert.match(popupScript, /key === "\/"/);
  assert.match(popupScript, /event\.key === "Escape"/);
});

test("popup exposes a local TXT and Markdown import preview", () => {
  const popupHtml = readFileSync(resolve(root, "popup.html"), "utf8");
  const popupScript = readFileSync(resolve(root, "popup.js"), "utf8");
  assert.match(popupHtml, /id="importFileInput"[^>]+accept="\.txt,\.md,text\/plain,text\/markdown"/);
  assert.match(popupHtml, /id="importDialog"/);
  assert.match(popupHtml, /id="importPreviewList"/);
  assert.match(popupScript, /parseWordImportText/);
  assert.match(popupScript, /type: "IMPORT_WORDS"/);
  assert.match(popupHtml, /文件只在本机读取/);
});

test("categories expose management, filtering, assignment, and per-word colors", () => {
  const popupHtml = readFileSync(resolve(root, "popup.html"), "utf8");
  const popupScript = readFileSync(resolve(root, "popup.js"), "utf8");
  const contentScript = readFileSync(resolve(root, "content.js"), "utf8");
  for (const id of [
    "categoryManagerSelect",
    "categoryNameInput",
    "newCategoryButton",
    "deleteCategoryButton",
    "addCategorySelect",
    "importCategorySelect",
    "categoryFilterSelect"
  ]) {
    assert.match(popupHtml, new RegExp(`id="${id}"`));
  }
  assert.match(popupScript, /type: "UPDATE_CATEGORY"/);
  assert.match(popupScript, /type: "MOVE_WORD"/);
  assert.match(contentScript, /getCategoryColor\(settings, entry\?\.categoryId\)/);
  assert.doesNotMatch(contentScript, /getHighlightRgb\(settings\.highlightColor\)/);
});

test("translation sources are opt-in capable and both interfaces render attributed results", () => {
  const popupHtml = readFileSync(resolve(root, "popup.html"), "utf8");
  const popupScript = readFileSync(resolve(root, "popup.js"), "utf8");
  const contentScript = readFileSync(resolve(root, "content.js"), "utf8");
  assert.match(popupHtml, /id="myMemorySourceToggle"[^>]+checked/);
  assert.match(popupHtml, /id="wiktionarySourceToggle"(?![^>]+checked)/);
  assert.match(popupHtml, /会向该来源发送当前单个英文词/);
  assert.match(popupScript, /SET_TRANSLATION_SOURCE/);
  assert.match(popupScript, /getTranslationSourceLabel/);
  assert.match(contentScript, /getTranslationSourceLabel/);
  assert.match(contentScript, /class="translations" id="cardTranslations"/);
});
