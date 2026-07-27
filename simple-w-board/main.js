"use strict";

const {
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  moment,
  normalizePath,
  setIcon,
  setTooltip,
} = require("obsidian");

const SWATCHES = [
  "#111111",
  "#ffffff",
  "#e5484d",
  "#f5a623",
  "#ffd600",
  "#30a46c",
  "#0091ff",
  "#8e4ec6",
];

const BRUSHES = [
  { label: "S", size: 2, text: 16 },
  { label: "M", size: 4, text: 22 },
  { label: "L", size: 9, text: 32 },
  { label: "XL", size: 18, text: 48 },
];

// Cycle order for the background toggle.
const BG_ORDER = ["white", "black", "transparent"];
const BG_LABEL = { white: "BG: white", black: "BG: black", transparent: "BG: clear" };
const BG_FILL = { white: "#ffffff", black: "#000000", transparent: null };

const FONT_STACK = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif";
const UNDO_LIMIT = 60;
const MOVE_THRESHOLD = 3;
const HIT_PAD = 5;
const SEL_OUTSET = 3;
const HANDLE_SIZE = 8;
const HANDLE_HIT = 9;
const MIN_SCALE = 0.05;

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                   */
/* ------------------------------------------------------------------ */

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

let _measureCtx = null;
function measureText(text, size) {
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  _measureCtx.font = `${size}px ${FONT_STACK}`;
  return _measureCtx.measureText(text).width;
}

/* ------------------------------------------------------------------ */
/* Attachment path helper                                             */
/* ------------------------------------------------------------------ */

async function resolveAttachmentPath(app, filename, sourcePath, fallbackFolder) {
  const fm = app.fileManager;
  if (fm && typeof fm.getAvailablePathForAttachment === "function") {
    try {
      return await fm.getAvailablePathForAttachment(filename, sourcePath);
    } catch (e) {
      /* fall through */
    }
  }
  let folder = (fallbackFolder || "").trim().replace(/^\/+|\/+$/g, "");
  if (folder && !app.vault.getAbstractFileByPath(folder)) {
    try {
      await app.vault.createFolder(folder);
    } catch (e) {
      /* ignore */
    }
  }
  const base = folder ? folder + "/" : "";
  const dot = filename.lastIndexOf(".");
  const stem = filename.slice(0, dot);
  const ext = filename.slice(dot);
  let path = normalizePath(base + filename);
  let i = 1;
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(base + `${stem}-${i}${ext}`);
    i++;
  }
  return path;
}

function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* Whiteboard modal                                                   */
/* ------------------------------------------------------------------ */

class WhiteboardModal extends Modal {
  constructor(app, plugin, ctx) {
    super(app);
    this.plugin = plugin;
    this.ctx = ctx; // { editor, cursor, sourcePath }

    this.tool = "pen"; // select | pen | text | eraser
    this.color = plugin.settings.color;
    this.brushIndex = Math.max(
      0,
      BRUSHES.findIndex((b) => b.size === plugin.settings.brush)
    );
    if (this.brushIndex < 0) this.brushIndex = 1;
    this.background = plugin.settings.background;
    this.title = "";

    this.objects = [];
    this.undoStack = [];
    this.redoStack = [];

    this.selected = null;
    this.active = null; // in-progress path
    this.pointerState = null;
  }

  get brush() {
    return BRUSHES[this.brushIndex];
  }

  onOpen() {
    this.modalEl.addClass("qs-modal");
    const root = this.contentEl;
    root.empty();
    root.addClass("qs-root");

    this.buildTitle(root);
    this.buildToolbar(root);

    this.wrap = root.createDiv({ cls: "qs-canvas-wrap" });
    this.applyBackgroundClass();
    this.canvas = this.wrap.createEl("canvas", { cls: "qs-canvas" });
    this.cx = this.canvas.getContext("2d");

    this.bindPointer();
    this.bindContextMenu();
    this.bindKeys();

    window.requestAnimationFrame(() => this.sizeCanvas());
  }

  onClose() {
    if (this.keyHandler) document.removeEventListener("keydown", this.keyHandler, true);
    this.contentEl.empty();
  }

  /* ---------------- title ---------------- */

  buildTitle(root) {
    const bar = root.createDiv({ cls: "qs-titlebar" });
    bar.createSpan({ cls: "qs-title-label", text: "sketch" });
    const input = bar.createEl("input", { cls: "qs-title-input" });
    input.type = "text";
    input.placeholder = "Untitled";
    input.value = this.title;
    input.addEventListener("input", (e) => {
      this.title = e.target.value;
    });
    this.titleInput = input;
  }

  /* ---------------- toolbar ---------------- */

  buildToolbar(root) {
    const bar = root.createDiv({ cls: "qs-toolbar" });

    // colours
    const colors = bar.createDiv({ cls: "qs-group qs-colors" });
    this.swatchEls = [];
    SWATCHES.forEach((hex) => {
      const sw = colors.createDiv({ cls: "qs-swatch" });
      sw.style.background = hex;
      if (hex.toLowerCase() === "#ffffff") sw.addClass("qs-swatch-light");
      if (hex === this.color) sw.addClass("qs-swatch-on");
      sw.addEventListener("click", () => this.setColor(hex));
      this.swatchEls.push({ hex, el: sw });
    });
    const custom = colors.createEl("input", { cls: "qs-color-input" });
    custom.type = "color";
    custom.value = /^#[0-9a-f]{6}$/i.test(this.color) ? this.color : "#111111";
    custom.setAttr("aria-label", "Custom colour");
    setTooltip(custom, "Custom colour");
    custom.addEventListener("input", (e) => this.setColor(e.target.value, true));
    this.customInput = custom;

    this.divider(bar);

    // brush sizes — graduated dots
    const brushes = bar.createDiv({ cls: "qs-group" });
    this.brushEls = [];
    BRUSHES.forEach((b, idx) => {
      const btn = brushes.createEl("button", { cls: "qs-icon-btn qs-brush" });
      const dot = btn.createSpan({ cls: "qs-dot" });
      const d = 4 + idx * 4;
      dot.style.width = `${d}px`;
      dot.style.height = `${d}px`;
      setTooltip(btn, `${b.label} brush`);
      if (idx === this.brushIndex) btn.addClass("qs-on");
      btn.addEventListener("click", () => this.setBrush(idx));
      this.brushEls.push(btn);
    });

    this.divider(bar);

    // tools
    const tools = bar.createDiv({ cls: "qs-group" });
    this.toolEls = {};
    [
      ["select", "mouse-pointer-2", "Select & move"],
      ["pen", "pencil", "Pen"],
      ["text", "type", "Text"],
      ["eraser", "eraser", "Eraser (removes whole strokes)"],
    ].forEach(([id, icon, tip]) => {
      const btn = this.iconBtn(tools, icon, tip, () => this.setTool(id), id === this.tool ? "qs-on" : "");
      this.toolEls[id] = btn;
    });

    this.divider(bar);

    // history
    const hist = bar.createDiv({ cls: "qs-group" });
    this.undoBtn = this.iconBtn(hist, "undo-2", "Undo", () => this.undo());
    this.redoBtn = this.iconBtn(hist, "redo-2", "Redo", () => this.redo());
    this.iconBtn(hist, "trash-2", "Clear board", () => this.clearBoard(), "qs-icon-danger");

    this.divider(bar);

    // background cycle with live preview
    const bgGroup = bar.createDiv({ cls: "qs-group" });
    this.bgBtn = bgGroup.createEl("button", { cls: "qs-icon-btn qs-bg-btn" });
    this.bgPreview = this.bgBtn.createSpan({ cls: "qs-bg-preview" });
    this.bgBtn.addEventListener("click", () => this.cycleBackground());
    this.updateBgButton();

    // primary actions
    const actions = root.createDiv({ cls: "qs-actions" });
    const insertBtn = actions.createEl("button", { cls: "qs-btn qs-btn-primary" });
    setIcon(insertBtn.createSpan({ cls: "qs-btn-icon" }), "image-plus");
    insertBtn.createSpan({ text: "Insert" });
    insertBtn.addEventListener("click", () => this.insert());

    const copyBtn = actions.createEl("button", { cls: "qs-btn" });
    setIcon(copyBtn.createSpan({ cls: "qs-btn-icon" }), "copy");
    copyBtn.createSpan({ text: "Copy" });
    copyBtn.addEventListener("click", () => this.copy());

    this.iconBtn(actions, "x", "Close", () => this.close());

    this.updateHistoryButtons();
  }

  iconBtn(parent, icon, tip, onClick, extraCls) {
    const btn = parent.createEl("button", { cls: "qs-icon-btn" + (extraCls ? " " + extraCls : "") });
    setIcon(btn, icon);
    setTooltip(btn, tip);
    btn.addEventListener("click", onClick);
    return btn;
  }

  divider(parent) {
    parent.createDiv({ cls: "qs-divider" });
  }

  /* ---------------- state setters ---------------- */

  setColor(hex, fromInput) {
    this.color = hex;
    this.plugin.settings.color = hex;
    this.plugin.saveSettings();
    this.swatchEls.forEach(({ hex: h, el }) => el.toggleClass("qs-swatch-on", h === hex));
    if (!fromInput && this.customInput && /^#[0-9a-f]{6}$/i.test(hex)) {
      this.customInput.value = hex;
    }
    // recolour a selected object
    if (this.selected) {
      this.pushUndo();
      this.selected.color = hex;
      this.redraw();
    }
  }

  setBrush(idx) {
    this.brushIndex = idx;
    this.plugin.settings.brush = BRUSHES[idx].size;
    this.plugin.saveSettings();
    this.brushEls.forEach((el, i) => el.toggleClass("qs-on", i === idx));
  }

  setTool(tool) {
    this.tool = tool;
    Object.entries(this.toolEls).forEach(([id, el]) => el.toggleClass("qs-on", id === tool));
    if (tool !== "select") this.setSelected(null);
    this.canvas.dataset.tool = tool;
  }

  applyBackgroundClass() {
    BG_ORDER.forEach((bg) => this.wrap.toggleClass(`qs-bg-${bg}`, this.background === bg));
  }

  updateBgButton() {
    if (!this.bgPreview) return;
    BG_ORDER.forEach((bg) => this.bgPreview.toggleClass(`qs-bg-prev-${bg}`, this.background === bg));
    setTooltip(this.bgBtn, `${BG_LABEL[this.background]} — click to cycle`);
  }

  cycleBackground() {
    const i = BG_ORDER.indexOf(this.background);
    this.background = BG_ORDER[(i + 1) % BG_ORDER.length];
    this.plugin.settings.background = this.background;
    this.plugin.saveSettings();
    this.applyBackgroundClass();
    this.updateBgButton();
  }

  /* ---------------- canvas sizing ---------------- */

  sizeCanvas() {
    this.dpr = window.devicePixelRatio || 1;
    const cssW = this.wrap.clientWidth;
    const cssH = this.wrap.clientHeight;
    if (!cssW || !cssH) {
      window.requestAnimationFrame(() => this.sizeCanvas());
      return;
    }
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    this.redraw();
  }

  /* ---------------- rendering ---------------- */

  paintObjects(cx, withSelection) {
    cx.lineCap = "round";
    cx.lineJoin = "round";
    for (const obj of this.objects) {
      if (obj.type === "path") {
        cx.strokeStyle = obj.color;
        cx.lineWidth = obj.width;
        const pts = obj.points;
        if (pts.length === 1) {
          cx.fillStyle = obj.color;
          cx.beginPath();
          cx.arc(pts[0].x, pts[0].y, obj.width / 2, 0, Math.PI * 2);
          cx.fill();
        } else {
          cx.beginPath();
          cx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) cx.lineTo(pts[i].x, pts[i].y);
          cx.stroke();
        }
      } else if (obj.type === "text") {
        cx.fillStyle = obj.color;
        cx.font = `${obj.size}px ${FONT_STACK}`;
        cx.textBaseline = "top";
        cx.fillText(obj.text, obj.x, obj.y);
      }
    }
    if (withSelection && this.selected) {
      const b = this.objectBBox(this.selected);
      if (b) {
        cx.save();
        cx.strokeStyle = "#4c8dff";
        cx.lineWidth = 1;
        cx.setLineDash([6, 4]);
        cx.strokeRect(b.x - SEL_OUTSET, b.y - SEL_OUTSET, b.w + SEL_OUTSET * 2, b.h + SEL_OUTSET * 2);
        cx.setLineDash([]);
        const handles = this.selectionHandles(b);
        const hs = HANDLE_SIZE;
        for (const key in handles) {
          const h = handles[key];
          cx.fillStyle = "#ffffff";
          cx.strokeStyle = "#4c8dff";
          cx.lineWidth = 1.5;
          cx.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
          cx.strokeRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
        }
        cx.restore();
      }
    }
  }

  // Corner points of the selection rectangle (outset from the bbox).
  selectionHandles(b) {
    const x0 = b.x - SEL_OUTSET;
    const y0 = b.y - SEL_OUTSET;
    const x1 = b.x + b.w + SEL_OUTSET;
    const y1 = b.y + b.h + SEL_OUTSET;
    return {
      nw: { x: x0, y: y0 },
      ne: { x: x1, y: y0 },
      sw: { x: x0, y: y1 },
      se: { x: x1, y: y1 },
    };
  }

  handleAt(x, y) {
    if (!this.selected) return null;
    const b = this.objectBBox(this.selected);
    if (!b) return null;
    const handles = this.selectionHandles(b);
    for (const key in handles) {
      const h = handles[key];
      if (Math.abs(x - h.x) <= HANDLE_HIT && Math.abs(y - h.y) <= HANDLE_HIT) return key;
    }
    return null;
  }

  redraw() {
    if (!this.cx) return;
    const cx = this.cx;
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintObjects(cx, true);
  }

  objectBBox(obj) {
    if (obj.type === "path") {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of obj.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const r = obj.width / 2;
      return { x: minX - r, y: minY - r, w: maxX - minX + obj.width, h: maxY - minY + obj.width };
    }
    if (obj.type === "text") {
      const w = measureText(obj.text, obj.size);
      return { x: obj.x, y: obj.y, w, h: obj.size * 1.2 };
    }
    return null;
  }

  hitTest(x, y) {
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const obj = this.objects[i];
      if (obj.type === "path") {
        const tol = obj.width / 2 + HIT_PAD;
        const pts = obj.points;
        if (pts.length === 1) {
          if (Math.hypot(x - pts[0].x, y - pts[0].y) <= tol) return obj;
        } else {
          for (let j = 1; j < pts.length; j++) {
            if (pointSegDist(x, y, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y) <= tol) return obj;
          }
        }
      } else if (obj.type === "text") {
        const b = this.objectBBox(obj);
        if (x >= b.x - HIT_PAD && x <= b.x + b.w + HIT_PAD && y >= b.y - HIT_PAD && y <= b.y + b.h + HIT_PAD) {
          return obj;
        }
      }
    }
    return null;
  }

  setSelected(obj) {
    this.selected = obj;
    this.redraw();
  }

  /* ---------------- pointer ---------------- */

  bindPointer() {
    const pos = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const p = pos(e);

      if (this.tool === "text") {
        this.openTextEditor(p.x, p.y);
        return;
      }

      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);

      if (this.tool === "pen") {
        this.pushUndo();
        this.active = { type: "path", color: this.color, width: this.brush.size, points: [p] };
        this.objects.push(this.active);
        this.redraw();
      } else if (this.tool === "eraser") {
        this.pushUndo();
        this.eraseAt(p.x, p.y);
        this.pointerState = { mode: "erase" };
      } else if (this.tool === "select") {
        // A handle on the current selection takes priority over hit-testing.
        const handle = this.handleAt(p.x, p.y);
        if (handle && this.selected) {
          this.pushUndo();
          const b0 = this.objectBBox(this.selected);
          this.pointerState = {
            mode: "resize",
            handle,
            obj: this.selected,
            anchor: this.resizeAnchor(b0, handle),
            grab: p,
            orig: this.cloneObject(this.selected),
          };
          return;
        }
        const hit = this.hitTest(p.x, p.y);
        this.setSelected(hit);
        if (hit) {
          this.pointerState = { mode: "maybe-move", start: p, moved: false, obj: hit };
        } else {
          this.pointerState = null;
        }
      }
    });

    this.canvas.addEventListener("pointermove", (e) => {
      const p = pos(e);

      if (this.active) {
        this.active.points.push(p);
        this.redraw();
        return;
      }

      // Hover cursor over handles when idle in select mode.
      if (!this.pointerState && this.tool === "select") {
        const handle = this.handleAt(p.x, p.y);
        this.canvas.style.cursor = handle
          ? handle === "nw" || handle === "se"
            ? "nwse-resize"
            : "nesw-resize"
          : "";
      }

      if (!this.pointerState) return;

      if (this.pointerState.mode === "erase") {
        this.eraseAt(p.x, p.y);
      } else if (this.pointerState.mode === "resize") {
        this.resizeTo(p);
      } else if (this.pointerState.mode === "maybe-move" || this.pointerState.mode === "move") {
        const s = this.pointerState;
        if (s.mode === "maybe-move") {
          if (Math.hypot(p.x - s.start.x, p.y - s.start.y) < MOVE_THRESHOLD) return;
          this.pushUndo();
          s.mode = "move";
          s.last = s.start;
        }
        const dx = p.x - s.last.x;
        const dy = p.y - s.last.y;
        this.translateObject(s.obj, dx, dy);
        s.last = p;
        this.redraw();
      }
    });

    const end = (e) => {
      if (this.active) this.active = null;
      this.pointerState = null;
      if (this.tool === "select") this.canvas.style.cursor = "";
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
  }

  translateObject(obj, dx, dy) {
    if (obj.type === "path") {
      for (const p of obj.points) {
        p.x += dx;
        p.y += dy;
      }
    } else if (obj.type === "text") {
      obj.x += dx;
      obj.y += dy;
    }
  }

  cloneObject(obj) {
    return obj.type === "path"
      ? { type: "path", color: obj.color, width: obj.width, points: obj.points.map((p) => ({ x: p.x, y: p.y })) }
      : { type: "text", color: obj.color, size: obj.size, x: obj.x, y: obj.y, text: obj.text };
  }

  // The corner that stays put is the one opposite the grabbed handle.
  resizeAnchor(b, handle) {
    const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    const map = {
      nw: { x: x1, y: y1 },
      ne: { x: x0, y: y1 },
      sw: { x: x1, y: y0 },
      se: { x: x0, y: y0 },
    };
    return map[handle];
  }

  resizeTo(p) {
    const s = this.pointerState;
    const { obj, orig, anchor, grab } = s;

    const dx0 = grab.x - anchor.x;
    const dy0 = grab.y - anchor.y;
    let sx = Math.abs(dx0) < 1 ? null : (p.x - anchor.x) / dx0;
    let sy = Math.abs(dy0) < 1 ? null : (p.y - anchor.y) / dy0;
    if (sx === null) sx = sy;
    if (sy === null) sy = sx;
    if (sx === null) sx = sy = 1;
    sx = Math.max(Math.abs(sx), MIN_SCALE);
    sy = Math.max(Math.abs(sy), MIN_SCALE);

    if (obj.type === "path") {
      obj.points = orig.points.map((pt) => ({
        x: anchor.x + (pt.x - anchor.x) * sx,
        y: anchor.y + (pt.y - anchor.y) * sy,
      }));
      obj.width = Math.max(0.5, orig.width * ((sx + sy) / 2));
    } else if (obj.type === "text") {
      // Text scales uniformly; drive size by the larger axis for a responsive feel.
      const scale = Math.max(sx, sy);
      obj.size = Math.min(400, Math.max(6, orig.size * scale));
      const newW = measureText(obj.text, obj.size);
      const newH = obj.size * 1.2;
      // Keep the anchored corner fixed.
      obj.x = s.handle === "ne" || s.handle === "se" ? anchor.x : anchor.x - newW;
      obj.y = s.handle === "sw" || s.handle === "se" ? anchor.y : anchor.y - newH;
    }
    this.redraw();
  }

  eraseAt(x, y) {
    const hit = this.hitTest(x, y);
    if (hit) {
      const i = this.objects.indexOf(hit);
      if (i >= 0) {
        this.objects.splice(i, 1);
        if (this.selected === hit) this.selected = null;
        this.redraw();
      }
    }
  }

  /* ---------------- text tool ---------------- */

  openTextEditor(x, y) {
    const size = this.brush.text;
    const input = this.wrap.createEl("input", { cls: "qs-text-input" });
    input.type = "text";
    input.style.left = `${x}px`;
    input.style.top = `${y}px`;
    input.style.color = this.color;
    input.style.fontSize = `${size}px`;
    input.style.fontFamily = FONT_STACK;
    window.setTimeout(() => input.focus(), 0);

    let done = false;
    const commit = (keep) => {
      if (done) return;
      done = true;
      const value = input.value;
      input.remove();
      if (keep && value.trim()) {
        this.pushUndo();
        const obj = { type: "text", color: this.color, size, x, y, text: value };
        this.objects.push(obj);
        this.setSelected(obj);
        this.setTool("select");
      }
    };

    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
      e.stopPropagation();
    });
  }

  /* ---------------- history ---------------- */

  cloneObjects() {
    return this.objects.map((o) =>
      o.type === "path"
        ? { type: "path", color: o.color, width: o.width, points: o.points.map((p) => ({ x: p.x, y: p.y })) }
        : { type: "text", color: o.color, size: o.size, x: o.x, y: o.y, text: o.text }
    );
  }

  pushUndo() {
    this.undoStack.push(this.cloneObjects());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateHistoryButtons();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.cloneObjects());
    this.objects = this.undoStack.pop();
    this.selected = null;
    this.redraw();
    this.updateHistoryButtons();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.cloneObjects());
    this.objects = this.redoStack.pop();
    this.selected = null;
    this.redraw();
    this.updateHistoryButtons();
  }

  clearBoard() {
    if (!this.objects.length) return;
    this.pushUndo();
    this.objects = [];
    this.selected = null;
    this.redraw();
  }

  deleteSelected() {
    if (!this.selected) return;
    const i = this.objects.indexOf(this.selected);
    if (i < 0) return;
    this.pushUndo();
    this.objects.splice(i, 1);
    this.selected = null;
    this.redraw();
  }

  updateHistoryButtons() {
    if (this.undoBtn) this.undoBtn.toggleClass("qs-disabled", this.undoStack.length === 0);
    if (this.redoBtn) this.redoBtn.toggleClass("qs-disabled", this.redoStack.length === 0);
  }

  /* ---------------- keys ---------------- */

  bindKeys() {
    this.keyHandler = (e) => {
      const t = e.target;
      const typing =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        this.redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && this.selected) {
        e.preventDefault();
        this.deleteSelected();
      }
    };
    document.addEventListener("keydown", this.keyHandler, true);
  }

  /* ---------------- export ---------------- */

  exportRender() {
    const off = document.createElement("canvas");
    off.width = this.canvas.width;
    off.height = this.canvas.height;
    const octx = off.getContext("2d");
    octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintObjects(octx, false);
    return off;
  }

  composeTrimmed() {
    const src = this.exportRender();
    const w = src.width;
    const h = src.height;
    const sctx = src.getContext("2d");
    const data = sctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;

    const pad = Math.round(10 * this.dpr);
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad);
    maxY = Math.min(h - 1, maxY + pad);
    const sw = maxX - minX + 1;
    const sh = maxY - minY + 1;

    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    const octx = out.getContext("2d");
    const fill = BG_FILL[this.background];
    if (fill) {
      octx.fillStyle = fill;
      octx.fillRect(0, 0, sw, sh);
    }
    octx.drawImage(src, minX, minY, sw, sh, 0, 0, sw, sh);
    return out;
  }

  toBlob() {
    return new Promise((resolve) => {
      const out = this.composeTrimmed();
      if (!out) {
        resolve(null);
        return;
      }
      out.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  /* ---------------- actions ---------------- */

  baseFilename() {
    const clean = sanitizeName(this.title || "");
    const stamp = moment().format("YYYYMMDD-HHmmss");
    return clean ? `${clean} ${stamp}` : `sketch-${stamp}`;
  }

  async insert() {
    const { editor, cursor, sourcePath } = this.ctx;
    if (!editor) {
      new Notice("Open a note in editing view to insert. Use Copy instead.");
      return;
    }
    const blob = await this.toBlob();
    if (!blob) {
      new Notice("Nothing on the board yet.");
      return;
    }
    try {
      const buf = await blob.arrayBuffer();
      const filename = `${this.baseFilename()}.png`;
      const path = await resolveAttachmentPath(
        this.app,
        filename,
        sourcePath,
        this.plugin.settings.fallbackFolder
      );
      const file = await this.app.vault.createBinary(path, buf);
      const alias = sanitizeName(this.title || "");
      let link = this.app.fileManager.generateMarkdownLink(file, sourcePath || "", "", alias || undefined);
      if (!link.startsWith("!")) link = "!" + link;
      editor.replaceRange(link, cursor);
      editor.setCursor({ line: cursor.line, ch: cursor.ch + link.length });
      new Notice("Inserted sketch.");
      if (this.plugin.settings.closeAfterInsert) this.close();
    } catch (err) {
      new Notice(`Insert failed: ${err.message}`);
    }
  }

  async copy() {
    const blob = await this.toBlob();
    if (!blob) {
      new Notice("Nothing on the board yet.");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      new Notice("Copied sketch to clipboard.");
    } catch (err) {
      new Notice("Clipboard copy not available here. Use Insert instead.");
    }
  }

  /* ---------------- right-click menu ---------------- */

  bindContextMenu() {
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      const p = (() => {
        const r = this.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      })();
      const under = this.hitTest(p.x, p.y);

      menu.addItem((i) =>
        i.setTitle("Insert into note").setIcon("image-plus").onClick(() => this.insert())
      );
      menu.addItem((i) =>
        i.setTitle("Copy to clipboard").setIcon("copy").onClick(() => this.copy())
      );
      if (under) {
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle("Delete this item").setIcon("trash").onClick(() => {
            this.setSelected(under);
            this.deleteSelected();
          })
        );
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Undo").setIcon("undo").onClick(() => this.undo()));
      menu.addItem((i) => i.setTitle("Clear board").setIcon("eraser").onClick(() => this.clearBoard()));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Discard & close").setIcon("x").onClick(() => this.close()));
      menu.showAtMouseEvent(e);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

class SimpleWBoardPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.decorated = new WeakSet();
    this.actionEls = [];

    this.addRibbonIcon("pencil", "Simple W-Board", () => this.openBoard());

    this.addCommand({
      id: "open-whiteboard",
      name: "Open whiteboard",
      callback: () => this.openBoard(),
    });

    // Put a button in the note's top-right action bar (next to the view actions).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => this.decorateLeaf(leaf))
    );
    this.app.workspace.onLayoutReady(() => this.decorateLeaf(this.app.workspace.activeLeaf));

    // Editor right-click menu entry.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        menu.addItem((item) =>
          item
            .setTitle("New sketch here")
            .setIcon("pencil")
            .onClick(() => {
              const ctx = {
                editor,
                cursor: editor.getCursor(),
                sourcePath: info && info.file ? info.file.path : "",
              };
              new WhiteboardModal(this.app, this, ctx).open();
            })
        );
      })
    );

    this.addSettingTab(new SimpleWBoardSettingTab(this.app, this));
  }

  decorateLeaf(leaf) {
    const view = leaf && leaf.view;
    if (!(view instanceof MarkdownView)) return;
    if (this.decorated.has(view)) return;
    this.decorated.add(view);
    const el = view.addAction("pencil", "New sketch here", () => this.openBoardForView(view));
    if (el) this.actionEls.push(el);
  }

  openBoardForView(view) {
    let ctx = { editor: null, cursor: null, sourcePath: "" };
    if (view instanceof MarkdownView) {
      const editable = view.getMode() === "source";
      ctx = {
        editor: editable ? view.editor : null,
        cursor: editable ? view.editor.getCursor() : null,
        sourcePath: view.file ? view.file.path : "",
      };
      if (!editable) {
        new Notice("Note is in reading view — you can draw and Copy, but Insert needs editing view.");
      }
    }
    new WhiteboardModal(this.app, this, ctx).open();
  }

  openBoard() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("No note open — you can still draw and Copy the result.");
      new WhiteboardModal(this.app, this, { editor: null, cursor: null, sourcePath: "" }).open();
      return;
    }
    this.openBoardForView(view);
  }

  onunload() {
    if (this.actionEls) this.actionEls.forEach((el) => el.remove());
    this.actionEls = [];
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!BG_ORDER.includes(this.settings.background)) this.settings.background = "white";
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

const DEFAULT_SETTINGS = {
  color: "#111111",
  brush: 4,
  background: "white",
  fallbackFolder: "",
  closeAfterInsert: true,
};

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

class SimpleWBoardSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default background")
      .setDesc("White or black read on any note. Transparent blends in, but same-coloured strokes vanish against the note.")
      .addDropdown((dd) =>
        dd
          .addOption("white", "White")
          .addOption("black", "Black")
          .addOption("transparent", "Transparent")
          .setValue(this.plugin.settings.background)
          .onChange(async (value) => {
            this.plugin.settings.background = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Close after inserting")
      .setDesc("Dismiss the whiteboard once the sketch is dropped into the note.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.closeAfterInsert).onChange(async (value) => {
          this.plugin.settings.closeAfterInsert = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Fallback attachment folder")
      .setDesc("Only used if Obsidian's own attachment location can't be resolved. Leave empty for the vault root.")
      .addText((t) =>
        t
          .setPlaceholder("attachments")
          .setValue(this.plugin.settings.fallbackFolder)
          .onChange(async (value) => {
            this.plugin.settings.fallbackFolder = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = SimpleWBoardPlugin;