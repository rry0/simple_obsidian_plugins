"use strict";

const { ItemView, Notice, Plugin, PluginSettingTab, Setting, normalizePath } = require("obsidian");

const VIEW_TYPE_SCRATCHPAD = "scratchpad-view";
const MAX_PADS = 8;

const DEFAULT_SETTINGS = {
  pads: [],
  activePad: 0,
  wipeOnStartup: false,
  monospace: true,
  fontSize: 14,
  exportFolder: "",
  appendSeparator: "blank", // "blank" | "rule" | "none"
  timestampAppends: false,
  revealOnAppend: false,
};

const isDefaultName = (name) => /^pad \d+$/i.test(name);

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

class ScratchpadView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.saveTimer = null;
    this.clearArmed = false;
    this.armTimer = null;
    this.closeArmedIndex = -1;
  }

  getViewType() {
    return VIEW_TYPE_SCRATCHPAD;
  }

  getDisplayText() {
    return "Scratchpad";
  }

  getIcon() {
    return "sticky-note";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("sp-root");

    this.tabsEl = root.createDiv({ cls: "sp-tabs" });

    const bar = root.createDiv({ cls: "sp-bar" });

    const copyBtn = bar.createEl("button", { cls: "sp-btn", text: "Copy" });
    copyBtn.addEventListener("click", () => this.copyAll());

    const keepBtn = bar.createEl("button", { cls: "sp-btn", text: "Keep as note" });
    keepBtn.addEventListener("click", () => this.keepAsNote());

    this.clearBtn = bar.createEl("button", { cls: "sp-btn sp-btn-danger", text: "Clear" });
    this.clearBtn.addEventListener("click", () => this.handleClear());

    this.textarea = root.createEl("textarea", { cls: "sp-textarea" });
    this.textarea.placeholder = "Dump anything here. It stays until you clear it.";
    this.textarea.spellcheck = false;

    this.textarea.addEventListener("input", () => {
      this.updateStats();
      this.queueSave();
    });

    // Tab indents instead of leaving the field.
    this.textarea.addEventListener("keydown", (evt) => {
      if (evt.key !== "Tab" || evt.altKey || evt.ctrlKey || evt.metaKey) return;
      evt.preventDefault();
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;
      const value = this.textarea.value;
      this.textarea.value = value.slice(0, start) + "  " + value.slice(end);
      this.textarea.selectionStart = this.textarea.selectionEnd = start + 2;
      this.updateStats();
      this.queueSave();
    });

    const footer = root.createDiv({ cls: "sp-footer" });
    this.statsEl = footer.createSpan({ cls: "sp-stats" });

    this.render();
    window.setTimeout(() => this.textarea.focus(), 0);
  }

  async onClose() {
    this.flushSave();
  }

  /* ---------------- rendering ---------------- */

  render() {
    this.renderTabs();
    this.textarea.value = this.plugin.getActivePad().content;
    this.applyStyle();
    this.updateStats();
    this.disarmClear();
  }

  renderTabs() {
    const { pads, activePad } = this.plugin.settings;
    this.tabsEl.empty();

    pads.forEach((pad, index) => {
      const tab = this.tabsEl.createDiv({
        cls: index === activePad ? "sp-tab sp-tab-active" : "sp-tab",
      });

      const label = tab.createSpan({ cls: "sp-tab-name", text: pad.name });
      if (pad.content.trim()) tab.createSpan({ cls: "sp-tab-dot", text: "•" });

      tab.addEventListener("click", (evt) => {
        if (evt.target.hasClass && evt.target.hasClass("sp-tab-close")) return;
        this.switchTo(index);
      });

      tab.addEventListener("dblclick", (evt) => {
        evt.preventDefault();
        this.beginRename(index, label);
      });

      if (pads.length > 1) {
        const close = tab.createSpan({ cls: "sp-tab-close", text: "×" });
        if (this.closeArmedIndex === index) close.addClass("sp-tab-close-armed");
        close.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.handleClose(index);
        });
      }
    });

    if (pads.length < MAX_PADS) {
      const add = this.tabsEl.createDiv({ cls: "sp-tab sp-tab-add", text: "+" });
      add.setAttr("aria-label", "New pad");
      add.addEventListener("click", () => this.plugin.newPad());
    }
  }

  beginRename(index, labelEl) {
    const pad = this.plugin.settings.pads[index];
    const input = document.createElement("input");
    input.className = "sp-tab-input";
    input.value = pad.name;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const name = input.value.trim();
      pad.name = name || pad.name;
      await this.plugin.saveSettings();
      this.renderTabs();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        input.blur();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        input.value = pad.name;
        input.blur();
      }
    });
  }

  applyStyle() {
    const s = this.plugin.settings;
    this.textarea.style.fontSize = `${s.fontSize}px`;
    this.textarea.style.fontFamily = s.monospace ? "var(--font-monospace)" : "var(--font-text)";
  }

  updateStats() {
    const text = this.textarea.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const lines = text ? text.split("\n").length : 0;
    this.statsEl.setText(`${lines}L · ${words}w · ${text.length}c`);
  }

  scrollToBottom() {
    this.textarea.scrollTop = this.textarea.scrollHeight;
    this.textarea.selectionStart = this.textarea.selectionEnd = this.textarea.value.length;
  }

  /* ---------------- pad actions ---------------- */

  async switchTo(index) {
    this.flushSave();
    this.plugin.settings.activePad = index;
    await this.plugin.saveSettings();
    this.render();
    this.textarea.focus();
  }

  handleClose(index) {
    const pad = this.plugin.settings.pads[index];
    if (pad.content.trim() && this.closeArmedIndex !== index) {
      this.closeArmedIndex = index;
      this.renderTabs();
      window.setTimeout(() => {
        if (this.closeArmedIndex !== index) return;
        this.closeArmedIndex = -1;
        this.renderTabs();
      }, 3000);
      new Notice(`"${pad.name}" has content. Click × again to discard it.`);
      return;
    }
    this.closeArmedIndex = -1;
    this.plugin.closePad(index);
  }

  queueSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 400);
  }

  flushSave() {
    window.clearTimeout(this.saveTimer);
    if (!this.textarea) return;
    this.plugin.getActivePad().content = this.textarea.value;
    this.plugin.saveSettings();
    if (this.tabsEl) this.renderTabs();
  }

  async copyAll() {
    const text = this.textarea.value;
    if (!text) {
      new Notice("Scratchpad is empty.");
      return;
    }
    await navigator.clipboard.writeText(text);
    new Notice("Copied to clipboard.");
  }

  async keepAsNote() {
    this.flushSave();
    await this.plugin.keepAsNote(this.plugin.settings.activePad);
  }

  handleClear() {
    if (!this.textarea.value) {
      new Notice("Already empty.");
      return;
    }
    if (!this.clearArmed) {
      this.clearArmed = true;
      this.clearBtn.setText("Clear it?");
      this.clearBtn.addClass("sp-btn-armed");
      this.armTimer = window.setTimeout(() => this.disarmClear(), 3000);
      return;
    }
    this.textarea.value = "";
    this.updateStats();
    this.flushSave();
    this.disarmClear();
    this.textarea.focus();
  }

  disarmClear() {
    window.clearTimeout(this.armTimer);
    this.clearArmed = false;
    if (this.clearBtn) {
      this.clearBtn.setText("Clear");
      this.clearBtn.removeClass("sp-btn-armed");
    }
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class ScratchpadPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_SCRATCHPAD, (leaf) => new ScratchpadView(leaf, this));

    this.addRibbonIcon("sticky-note", "Toggle scratchpad", () => this.toggleView());

    this.addCommand({
      id: "toggle-scratchpad",
      name: "Toggle scratchpad",
      callback: () => this.toggleView(),
    });

    this.addCommand({
      id: "append-selection",
      name: "Append selection to active pad",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        if (!selection) {
          new Notice("Nothing selected.");
          return;
        }
        this.appendText(selection);
      },
    });

    this.addCommand({
      id: "append-clipboard",
      name: "Append clipboard to active pad",
      callback: async () => {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) {
          new Notice("Clipboard is empty.");
          return;
        }
        this.appendText(text);
      },
    });

    this.addCommand({
      id: "new-pad",
      name: "New pad",
      callback: () => this.newPad(),
    });

    this.addCommand({
      id: "next-pad",
      name: "Next pad",
      callback: () => this.cyclePad(1),
    });

    this.addCommand({
      id: "prev-pad",
      name: "Previous pad",
      callback: () => this.cyclePad(-1),
    });

    this.addCommand({
      id: "keep-as-note",
      name: "Keep active pad as note",
      callback: () => {
        const view = this.getView();
        if (view) view.flushSave();
        this.keepAsNote(this.settings.activePad);
      },
    });

    this.addCommand({
      id: "clear-active-pad",
      name: "Clear active pad",
      callback: async () => {
        this.getActivePad().content = "";
        await this.saveSettings();
        const view = this.getView();
        if (view) view.render();
        new Notice("Pad cleared.");
      },
    });

    this.addSettingTab(new ScratchpadSettingTab(this.app, this));

    if (this.settings.wipeOnStartup) {
      this.settings.pads = [{ name: "pad 1", content: "" }];
      this.settings.activePad = 0;
      await this.saveSettings();
    }
  }

  /* ---------------- pads ---------------- */

  getActivePad() {
    const { pads, activePad } = this.settings;
    return pads[activePad] || pads[0];
  }

  async newPad() {
    if (this.settings.pads.length >= MAX_PADS) {
      new Notice(`Pad limit is ${MAX_PADS}.`);
      return;
    }
    const view = this.getView();
    if (view) view.flushSave();

    let n = this.settings.pads.length + 1;
    const names = new Set(this.settings.pads.map((p) => p.name));
    while (names.has(`pad ${n}`)) n++;

    this.settings.pads.push({ name: `pad ${n}`, content: "" });
    this.settings.activePad = this.settings.pads.length - 1;
    await this.saveSettings();

    await this.openView();
    const v = this.getView();
    if (v) {
      v.render();
      v.textarea.focus();
    }
  }

  async closePad(index) {
    if (this.settings.pads.length <= 1) return;
    this.settings.pads.splice(index, 1);
    if (this.settings.activePad >= this.settings.pads.length) {
      this.settings.activePad = this.settings.pads.length - 1;
    } else if (this.settings.activePad > index) {
      this.settings.activePad -= 1;
    }
    await this.saveSettings();
    const view = this.getView();
    if (view) view.render();
  }

  async cyclePad(step) {
    const view = this.getView();
    if (view) view.flushSave();
    const count = this.settings.pads.length;
    this.settings.activePad = (this.settings.activePad + step + count) % count;
    await this.saveSettings();
    await this.openView();
    const v = this.getView();
    if (v) v.render();
  }

  /* ---------------- append ---------------- */

  buildAppend(existing, text) {
    const s = this.settings;
    const stamp = s.timestampAppends ? `// ${window.moment().format("HH:mm:ss")}\n` : "";

    let separator = "";
    if (existing.trim()) {
      if (s.appendSeparator === "rule") separator = "\n\n---\n\n";
      else if (s.appendSeparator === "blank") separator = "\n\n";
      else separator = "\n";
    }
    return existing + separator + stamp + text;
  }

  async appendText(text) {
    const view = this.getView();
    if (view) view.flushSave();

    const pad = this.getActivePad();
    pad.content = this.buildAppend(pad.content, text);
    await this.saveSettings();

    if (this.settings.revealOnAppend) await this.openView();

    const v = this.getView();
    if (v) {
      v.render();
      v.scrollToBottom();
    }

    const lines = text.split("\n").length;
    new Notice(`Appended ${lines} line${lines === 1 ? "" : "s"} to ${pad.name}.`);
  }

  /* ---------------- export ---------------- */

  async keepAsNote(index) {
    const pad = this.settings.pads[index];
    if (!pad || !pad.content.trim()) {
      new Notice("Nothing to keep.");
      return;
    }

    const folder = this.settings.exportFolder.trim().replace(/^\/+|\/+$/g, "");
    const stamp = window.moment().format("YYYY-MM-DD HHmmss");
    const base = isDefaultName(pad.name)
      ? "Scratch"
      : pad.name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "Scratch";
    const path = normalizePath(`${folder ? folder + "/" : ""}${base} ${stamp}.md`);

    try {
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      const file = await this.app.vault.create(path, pad.content);
      new Notice(`Saved to ${file.path}`);
      this.app.workspace.getLeaf(true).openFile(file);
    } catch (err) {
      new Notice(`Could not save note: ${err.message}`);
    }
  }

  /* ---------------- view plumbing ---------------- */

  getView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCRATCHPAD);
    return leaves.length ? leaves[0].view : null;
  }

  async openView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCRATCHPAD);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_SCRATCHPAD, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async toggleView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCRATCHPAD);
    if (existing.length) {
      existing.forEach((leaf) => leaf.detach());
      return;
    }
    await this.openView();
  }

  refreshStyle() {
    const view = this.getView();
    if (view) view.applyStyle();
  }

  /* ---------------- settings ---------------- */

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // Migrate the single-pad format from v1.0.
    if (!Array.isArray(this.settings.pads) || this.settings.pads.length === 0) {
      this.settings.pads = [
        { name: "pad 1", content: typeof data.content === "string" ? data.content : "" },
      ];
    }
    delete this.settings.content;

    this.settings.pads = this.settings.pads.slice(0, MAX_PADS).map((p, i) => ({
      name: typeof p.name === "string" && p.name ? p.name : `pad ${i + 1}`,
      content: typeof p.content === "string" ? p.content : "",
    }));

    const max = this.settings.pads.length - 1;
    this.settings.activePad = Math.min(Math.max(this.settings.activePad | 0, 0), max);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

class ScratchpadSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Appending").setHeading();

    new Setting(containerEl)
      .setName("Separator between appends")
      .setDesc("What goes between the existing text and the new chunk.")
      .addDropdown((dd) =>
        dd
          .addOption("blank", "Blank line")
          .addOption("rule", "Horizontal rule")
          .addOption("none", "New line only")
          .setValue(this.plugin.settings.appendSeparator)
          .onChange(async (value) => {
            this.plugin.settings.appendSeparator = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Timestamp each append")
      .setDesc("Prefix every appended chunk with a // HH:mm:ss line.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.timestampAppends).onChange(async (value) => {
          this.plugin.settings.timestampAppends = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Open the panel when appending")
      .setDesc("Off means text is shoved into the pad in the background without stealing focus.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.revealOnAppend).onChange(async (value) => {
          this.plugin.settings.revealOnAppend = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Pad").setHeading();

    new Setting(containerEl)
      .setName("Wipe on startup")
      .setDesc("Start every Obsidian session with one empty pad. Off keeps whatever you left behind.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.wipeOnStartup).onChange(async (value) => {
          this.plugin.settings.wipeOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Monospace font")
      .setDesc("Use your monospace font instead of the reading font.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.monospace).onChange(async (value) => {
          this.plugin.settings.monospace = value;
          await this.plugin.saveSettings();
          this.plugin.refreshStyle();
        })
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Text size inside the pad, in pixels.")
      .addSlider((sl) =>
        sl
          .setLimits(10, 22, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fontSize = value;
            await this.plugin.saveSettings();
            this.plugin.refreshStyle();
          })
      );

    new Setting(containerEl)
      .setName("Folder for kept notes")
      .setDesc('Where "Keep as note" writes to. Leave empty for the vault root.')
      .addText((t) =>
        t
          .setPlaceholder("Scratch")
          .setValue(this.plugin.settings.exportFolder)
          .onChange(async (value) => {
            this.plugin.settings.exportFolder = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = ScratchpadPlugin;
