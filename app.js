// Pack-editor mini-app — vanilla JS.
// Связь с ботом: POST /api/build_pack с заголовком X-Telegram-Init-Data
// (HMAC по токену проверяет webapp_server). sendData больше не нужен —
// мини-аппа открывается одним тапом из inline-кнопки.

(() => {
  const tg = window.Telegram?.WebApp;
  tg?.ready?.();
  tg?.expand?.();
  function lockTelegramVerticalSwipes() {
    try { tg?.disableVerticalSwipes?.(); } catch (_) {}
    try { window.Telegram?.WebApp?.disableVerticalSwipes?.(); } catch (_) {}
  }
  lockTelegramVerticalSwipes();

  const DEFAULT_FONT_KEY = "seymour";
  const PUBLIC_PACK_BOT_USERNAME = "swexmakerbot";
  const DEFAULT_BRAND_TEXT = "Lean";
  const FALLBACK_FONTS = [
    { key: "seymour", label: "Seymour One", sample: "Lean", url: "/api/fonts/seymour" },
    { key: "rubik", label: "Rubik", sample: "Lean", url: "/api/fonts/rubik" },
    { key: "montserrat", label: "Montserrat", sample: "Lean", url: "/api/fonts/montserrat" },
    { key: "press", label: "Press Start 2P", sample: "Lean", url: "/api/fonts/press" },
    { key: "russo", label: "Russo One", sample: "Lean", url: "/api/fonts/russo" },
    { key: "pacifico", label: "Pacifico", sample: "Lean", url: "/api/fonts/pacifico" },
  ];
  const STYLE_TEMPLATE_KEY = "swex_editor_style_template_v1";
  const PACK_STYLE_PRESETS = [
    {
      key: "black-white", label: "Ч/Б", font: "russo",
      content: "#ffffff", gradient: null,
      primary: "#000000", light: "#ffffff",
      swatch: ["#0a0a0b", "#ffffff", "#35353a"], text: "#ffffff",
    },
    {
      key: "white-black", label: "Б/Ч", font: "russo",
      content: "#000000", gradient: null,
      primary: "#ffffff", light: "#000000",
      swatch: ["#ffffff", "#ececf0", "#050505"], text: "#050505",
    },
    {
      key: "chrome", label: "Chrome", font: "montserrat",
      content: "#f8fafc", gradient: { from: "#ffffff", to: "#9ca3af" },
      primary: "#111318", light: "#e8edf2",
      swatch: ["#ffffff", "#aeb6c2", "#171a20"], text: "#ffffff",
    },
    {
      key: "luxury", label: "Luxury", font: "seymour",
      content: "#ffe082", gradient: { from: "#fff6c7", to: "#d8a51d" },
      primary: "#101010", light: "#ffe7a3",
      swatch: ["#fff1a8", "#d6a21f", "#14100a"], text: "#171009",
    },
    {
      key: "ice", label: "Ice", font: "montserrat",
      content: "#ffffff", gradient: { from: "#ffffff", to: "#7dd3fc" },
      primary: "#0ea5e9", light: "#f8fbff",
      swatch: ["#f8fbff", "#7dd3fc", "#0f172a"], text: "#0b1220",
    },
    {
      key: "toxic", label: "Toxic", font: "rubik",
      content: "#d7ff3f", gradient: { from: "#ffffff", to: "#d7ff3f" },
      primary: "#101010", light: "#d7ff3f",
      swatch: ["#d7ff3f", "#30d158", "#07130b"], text: "#07130b",
    },
  ];

  // ── State ──────────────────────────────────
  // global: { kind, text, logo_svg_b64 }  — применяется ко всем 144
  // perEmoji[id] = { scale, offset_x, offset_y, rotation, content_color }  — настройки текущего тайла
  const state = {
    masterFiles: [],
    newFiles:    [],
    uploadFiles: [],
    currentIdx:  null,
    global:      { kind: "text", text: "", logo_svg_b64: "", logo_png_b64: "", content_rotation: 0, content_color: "#ffffff", font: DEFAULT_FONT_KEY },
    perEmoji:    {},
    cache:       {},
    anim:        null,
    mode:        "text",
    textScope:   "global",
    format:      "emoji",
    selected:    new Set(),   // tiles that go into the built pack
    pricing:     { star_per_sticker: 1, small_price_rub: 0, mid_price_rub: 0, full_price_rub: 0, passport_price_rub: 0, conversion_price_rub: 0, icon_pack_price_rub: 0, icon_addition_price_rub: 0, addition_price_rub: 0, small_threshold: 10, mid_threshold: 50, passport_ids: [] },
    fonts:       FALLBACK_FONTS.slice(),
    fontFallbacks: [],
    cacheInflight: {},
    cacheOrder: [],
    currentLottieSize: { w: 512, h: 512 },
    placementMode: false,
    // When selection contains *only* the passport, we hide the passport
    // editor by default — the user sees a regular editor view. A press
    // on ◁ / ▷ flips this to `true` and reveals the passport editor.
    passportRevealed: false,
  };
  let packBotState = { configured: false };
  const STICKER_LIMIT = 120;
  // Telegram custom-emoji set cap. We let users opt tiles in/out in emoji
  // mode too — same checkbox UX as sticker mode, just with a larger ceiling.
  const EMOJI_LIMIT = 200;
  const DEFAULT_EMOJI_SELECTION = 10;
  function currentLimit() {
    // Effective cap is min(TG hard limit, tiles actually available). With
    // ~181 master+new tiles, showing "/200" in emoji mode is misleading —
    // the user can never reach 200. Clamp to the real available count.
    const hard = state.format === "sticker" ? STICKER_LIMIT : EMOJI_LIMIT;
    const total = allFiles().length || hard;
    return Math.min(hard, total);
  }

  // ── DOM ────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const previewBox = $("preview");
  const counter    = $("counter");
  const statusEl   = $("status");
  const previewStyleBrush = $("preview-style-brush");
  const grid       = $("grid");
  const gridNew    = $("grid-new");
  const previewStrip = $("preview-strip");
  const previewStripDock = document.querySelector(".preview-strip-dock");
  const emojiPickerPanel = $("emoji-picker-panel");
  const emojiPickerGrid = $("emoji-picker-grid");
  const emojiPickerSearch = $("emoji-picker-search");
  const emojiPickerCount = $("emoji-picker-count");
  const addEmojiBtn = $("add-emoji");
  const uploadModal = $("upload-modal");
  const uploadStatus = $("upload-status");
  const uploadCancel = $("upload-cancel");
  const uploadClose = $("upload-close");
  const uploadHint = $("upload-hint");
  const uploadPlacePanel = $("upload-place-panel");
  const uploadPlaceBtn = $("upload-place-btn");
  const uploadReplaceBtn = $("upload-replace-btn");
  const uploadPlaceReset = $("upload-place-reset");
  const uploadReplaceClear = $("upload-replace-clear");
  const uploadPlaceStatus = $("upload-place-status");
  const packBotBtn = $("pack-bot-btn");
  const packBotDot = $("pack-bot-dot");
  const packBotSettingsBtn = $("pack-bot-settings-btn");
  const packBotHint = $("pack-bot-hint");
  const botAccountOpen = $("bot-account-open");
  const botAccountRecheck = $("bot-account-recheck");
  const selectBar  = $("select-bar");
  const selectCountNum = $("select-count-num");
  const selectCountMax = $("select-count-max");
  let emojiPickerOpen = false;
  let emojiPickerBuilt = false;
  let emojiPickerPreviewEpoch = 0;
  let emojiPickerWarmRaf = 0;
  let emojiPickerWarmIdle = null;
  let emojiPickerDisposeIdle = null;
  let emojiPickerPrebuildIdle = null;
  let buildInFlight = false;
  let botAccountPromptedOnBoot = false;
  const isCoarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  const LOTTIE_CACHE_LIMIT = isCoarsePointer ? 28 : 80;
  const PICKER_WARM_LIMIT = isCoarsePointer ? 3 : 8;
  const PICKER_SCROLL_WARM_LIMIT = isCoarsePointer ? 3 : 9;

  const splashEl = $("swex-splash");
  const splashBar = $("swex-splash-bar");
  const splashLabel = $("swex-splash-label");
  const splashPercent = $("swex-splash-percent");
  let splashProgress = 6;
  let splashTarget = 14;
  let splashDone = false;
  function paintSplashProgress(value) {
    if (!splashEl) return;
    splashProgress = Math.max(0, Math.min(100, value));
    const pct = splashProgress.toFixed(1) + "%";
    splashEl.style.setProperty("--swex-load", pct);
    if (splashBar) splashBar.style.width = pct;
    if (splashPercent) splashPercent.textContent = String(Math.round(splashProgress)).padStart(2, "0") + "%";
  }
  function setSplashProgress(value, label) {
    if (!splashEl || splashDone) return;
    splashTarget = Math.max(splashTarget, Math.max(0, Math.min(100, value)));
    if (label && splashLabel) splashLabel.textContent = label;
  }
  const splashTimer = splashEl ? setInterval(() => {
    if (splashDone) return;
    const gap = splashTarget - splashProgress;
    if (Math.abs(gap) < 0.2) return;
    paintSplashProgress(splashProgress + Math.max(0.25, gap * 0.1));
  }, 90) : null;
  function finishSplash() {
    if (!splashEl || splashDone) return;
    if (window.SWEX_SPLASH_HOLD) {
      window.SWEX_EDITOR_READY = true;
      splashEl.classList.add("editor-ready");
      if (splashLabel) splashLabel.textContent = "Редактор готов";
      paintSplashProgress(100);
      window.dispatchEvent(new CustomEvent("swex:editor-ready"));
      return;
    }
    splashDone = true;
    if (splashTimer) clearInterval(splashTimer);
    if (splashLabel) splashLabel.textContent = "Готово";
    paintSplashProgress(100);
    setTimeout(() => {
      splashEl.classList.add("done");
      document.body.classList.remove("splash-active");
      setTimeout(() => splashEl.remove(), 460);
    }, 240);
  }
  window.SWEX_RELEASE_SPLASH = () => {
    if (!window.SWEX_EDITOR_READY) {
      if (splashLabel) splashLabel.textContent = "Редактор еще поднимается";
      return;
    }
    window.SWEX_SPLASH_HOLD = false;
    finishSplash();
  };
  function failSplash(label) {
    if (!splashEl || splashDone) return;
    if (splashTimer) clearInterval(splashTimer);
    splashEl.classList.add("error");
    if (splashLabel) splashLabel.textContent = label || "Не удалось загрузить";
    paintSplashProgress(100);
  }

  // ── Helpers ────────────────────────────────
  function scheduleIdleWork(fn, timeout = 450) {
    if ("requestIdleCallback" in window) {
      return { type: "idle", id: window.requestIdleCallback(fn, { timeout }) };
    }
    return { type: "timer", id: window.setTimeout(fn, timeout) };
  }
  function cancelIdleWork(handle) {
    if (!handle) return;
    if (handle.type === "idle" && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(handle.id);
    } else {
      window.clearTimeout(handle.id);
    }
  }
  function dataAttrValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function defaultTransform() {
    return {
      scale: 1.0, offset_x: 0, offset_y: 0, rotation: 0,
      anchor_x: null, anchor_y: null,
      replace_part: false,
      content_color: "#ffffff", lines: null, photo_scale: 1.0,
      photo_color: "#ffffff",
      font: null,
      kind: null,
      logo_svg_b64: "",
      logo_png_b64: "",
      text: "",
      text_gradient: null,
      // Advanced colour editor:
      // { "#oldhex": "#newhex" | { mode:"gradient", from:"#...", to:"#...", target?:"stroke" } }
      // Each matching static fill/stroke is repainted on every preview render
      // and during pack build. `target` lets pack palette gradients touch only
      // outlines instead of every white fill.
      color_remap: null,
      pack_style: null,
    };
  }
  function normalizeLayerColorSpec(value, fallback) {
    const base = normalizeHexColor(fallback);
    const target = value && typeof value === "object"
      ? normalizeLayerColorTarget(value.target || value.apply_to || value.kind)
      : "";
    if (value && typeof value === "object") {
      const mode = value.mode === "gradient" || value.type === "gradient" || value.gradient === true;
      if (mode) {
        return {
          mode: "gradient",
          from: normalizeHexColor(value.from || value.color || base),
          to: normalizeHexColor(value.to || value.from || base),
          target,
        };
      }
      return { mode: "solid", color: normalizeHexColor(value.color || value.from || base), target };
    }
    return { mode: "solid", color: normalizeHexColor(value || base) };
  }
  function normalizeLayerColorTarget(value) {
    const v = String(value || "").trim().toLowerCase();
    if (v === "stroke" || v === "st" || v === "outline") return "stroke";
    if (v === "fill" || v === "fl") return "fill";
    return "";
  }
  function layerColorSpecChanged(spec, orig) {
    const base = normalizeHexColor(orig);
    if (!spec || typeof spec !== "object") return false;
    if (spec.mode === "gradient") {
      return normalizeHexColor(spec.from) !== base || normalizeHexColor(spec.to) !== base;
    }
    return normalizeHexColor(spec.color) !== base;
  }
  function layerColorSpecPayload(spec, orig) {
    if (!layerColorSpecChanged(spec, orig)) return null;
    if (spec.mode === "gradient") {
      const payload = {
        mode: "gradient",
        from: normalizeHexColor(spec.from),
        to: normalizeHexColor(spec.to),
      };
      const target = normalizeLayerColorTarget(spec.target);
      if (target) payload.target = target;
      return payload;
    }
    return normalizeHexColor(spec.color);
  }
  function layerColorSpecCss(spec) {
    if (spec && spec.mode === "gradient") {
      return `linear-gradient(135deg, ${normalizeHexColor(spec.from)}, ${normalizeHexColor(spec.to)})`;
    }
    return normalizeHexColor(spec && spec.color);
  }
  function layerColorSpecLabel(spec) {
    if (spec && spec.mode === "gradient") {
      return `${normalizeHexColor(spec.from).toUpperCase()} → ${normalizeHexColor(spec.to).toUpperCase()}`;
    }
    return normalizeHexColor(spec && spec.color).toUpperCase();
  }
  function hasColorRemap(remap) {
    if (!remap || typeof remap !== "object") return false;
    for (const k in remap) {
      if (!Object.prototype.hasOwnProperty.call(remap, k)) continue;
      const orig = normalizeHexColor(k);
      if (layerColorSpecChanged(normalizeLayerColorSpec(remap[k], orig), orig)) {
        return true;
      }
    }
    return false;
  }
  function clampPhotoScale(v) {
    return Math.max(0.3, Math.min(3.0, +v || 1.0));
  }
  function clampScale(v) {
    return Math.max(0.5, Math.min(5.0, +v || 1.0));
  }
  function hasFiniteAnchorValue(value) {
    return value !== null && value !== undefined && value !== ""
      && Number.isFinite(+value);
  }
  function getTransform(id) {
    if (!state.perEmoji[id]) state.perEmoji[id] = defaultTransform();
    return state.perEmoji[id];
  }
  function isTransformChanged(t) {
    if (!t) return false;
    return Math.abs((t.scale || 1) - 1) > 1e-6
        || Math.abs(t.offset_x || 0) > 1e-6
        || Math.abs(t.offset_y || 0) > 1e-6
        || hasFiniteAnchorValue(t.anchor_x)
        || hasFiniteAnchorValue(t.anchor_y)
        || !!t.replace_part
        || Math.abs(t.rotation || 0) > 1e-6
        || normalizeHexColor(t.content_color) !== "#ffffff"
        || (typeof t.text === "string" && t.text.trim() !== "")
        || !!t.logo_svg_b64
        || !!t.logo_png_b64
        || ((t.kind === "text" || t.kind === "logo") && (
             (typeof t.text === "string" && t.text.trim() !== "") || !!t.logo_svg_b64 || !!t.logo_png_b64
           ))
        || (!!t.font && effectiveFontKey(t.font) !== effectiveFontKey(state.global.font))
        || hasTextGradient(t.text_gradient)
        || hasLinesEdit(t.lines)
        || !!t.photo_svg_b64
        || !!t.photo_png_b64
        || ((!!t.photo_svg_b64 || !!t.photo_png_b64) && normalizeHexColor(t.photo_color) !== "#ffffff")
        || Math.abs((t.photo_scale || 1) - 1) > 1e-3
        || hasColorRemap(t.color_remap);
  }
  function hasLinesEdit(lines) {
    if (!Array.isArray(lines)) return false;
    return lines.some(l => l && (
      (typeof l.text === "string" && l.text.trim() !== "")
      || (typeof l.scale === "number" && Math.abs(l.scale - 1) > 1e-3)
      || (typeof l.color === "string" && l.color.toLowerCase() !== "#000000")
      || (typeof l.offset_x === "number" && Math.abs(l.offset_x) > 1e-6)
      || (typeof l.offset_y === "number" && Math.abs(l.offset_y) > 1e-6)
    ));
  }
  function normalizeHexColor(v) {
    const s = String(v || "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return "#" + s.slice(1).split("").map(ch => ch + ch).join("").toLowerCase();
    }
    return "#ffffff";
  }
  function recolorPassportSvg(svgText, color) {
    const c = normalizeHexColor(color || "#ffffff");
    let out = String(svgText || "");
    out = out.replace(/(<svg\b[^>]*)(>)/i, (m, start, end) => {
      let head = start;
      if (/\sfill\s*=/.test(head)) {
        head = head.replace(/\sfill\s*=\s*(['"])(?!none\b|transparent\b|url\()[^'"]*\1/i, ` fill="${c}"`);
      } else {
        head += ` fill="${c}"`;
      }
      if (/\scolor\s*=/.test(head)) {
        head = head.replace(/\scolor\s*=\s*(['"])[^'"]*\1/i, ` color="${c}"`);
      } else {
        head += ` color="${c}"`;
      }
      return head + end;
    });
    out = out.replace(/\s(fill|stroke)\s*=\s*(['"])(?!none\b|transparent\b|url\()[^'"]*\2/gi, (m, attr) => ` ${attr}="${c}"`);
    out = out.replace(/(fill|stroke)\s*:\s*(?!none\b|transparent\b|url\()[^;"'}]+/gi, `$1:${c}`);
    return out;
  }
  function defaultTextGradient() {
    return { enabled: false, from: "#ffffff", to: "#30d158" };
  }
  function normalizeTextGradient(v) {
    const g = defaultTextGradient();
    if (v && typeof v === "object") {
      g.enabled = !!v.enabled;
      g.from = normalizeHexColor(v.from || g.from);
      g.to = normalizeHexColor(v.to || g.to);
    }
    return g;
  }
  function hasTextGradient(v) {
    return normalizeTextGradient(v).enabled;
  }
  function activeTextGradient(v) {
    const g = normalizeTextGradient(v);
    return g.enabled ? g : null;
  }
  function effectiveOverride(id) {
    /** Что реально подставить в превью: глобал + per-emoji трансформ.
     *  На паспорте глобальный ник/лого ИГНОРИРУЕМ: текст/цвет/масштаб
     *  s/w/e/x-букв берётся из строки `__header__` (Строка 1). */
    const g = state.global;
    const t = state.perEmoji[id] || defaultTransform();
    const f = fileById(id);
    const isPassport = !!(f && Array.isArray(f.passport_lines) && f.passport_lines.length);
    let kind = g.kind;
    let text = g.text;
    let logo_b64 = g.logo_svg_b64;
    let png_b64 = g.logo_png_b64;
    const ownText = tileTextOverride(id);
    const ownLogo = tileLogoOverride(id);
    const ownPng = tilePngOverride(id);
    if (!isPassport) {
      if ((t.kind === "logo" || (!t.kind && (ownLogo || ownPng))) && (ownLogo || ownPng)) {
        kind = "logo";
        text = "";
        logo_b64 = ownLogo;
        png_b64 = ownPng;
      } else if ((t.kind === "text" || ownText) && ownText) {
        kind = "text";
        text = ownText;
        logo_b64 = "";
        png_b64 = "";
      }
    }
    const rawColor = normalizeHexColor(t.content_color);
    const textGradient = activeTextGradient(t.text_gradient);
    let color = rawColor;
    let scale = t.scale;
    let ox = t.offset_x;
    let oy = t.offset_y;
    let rot = +t.rotation || 0;
    if (isPassport) {
      const header = Array.isArray(t.lines)
        ? t.lines.find(l => l && l.name === "__header__")
        : null;
      const headerText = header && typeof header.text === "string" ? header.text : "";
      const headerColor = normalizeHexColor((header && header.color) || "#000000");
      // Passport: global nick/logo/color controls are ignored. The top
      // passport name is edited as line #1 (`__header__`); if it is empty
      // we delete the baked swex letters instead of recolouring them.
      kind = "text";
      text = headerText;
      logo_b64 = "";
      png_b64 = "";
      color = headerText.trim() ? headerColor : "";
      scale = (header && typeof header.scale === "number") ? header.scale : 1;
      ox = (header && typeof header.offset_x === "number") ? header.offset_x : 0;
      oy = (header && typeof header.offset_y === "number") ? header.offset_y : 0;
      rot = 0;
    }
    // Switching to the Logo tab does not mean a valid logo exists yet. Keep
    // the text replacement active until PNG/SVG validation succeeds; otherwise
    // the untouched template exposes its baked `swex` wordmark.
    if (!isPassport && kind === "logo" && !logo_b64 && !png_b64) {
      kind = "text";
      text = String(text || "").trim() || DEFAULT_BRAND_TEXT;
    }
    // New-tab tiles bake s/w/e/x letters at a smaller footprint than
    // master tiles. Pass an expand factor so the live-preview logo lands
    // at the same visual size as on master tiles.
    const isNewTile = typeof id === "string" && id.startsWith("new:");
    return {
      kind, text, logo_svg_b64: logo_b64, logo_png_b64: png_b64,
      content_color: color,
      scale, offset_x: ox, offset_y: oy, rotation: rot,
      anchor_x: hasFiniteAnchorValue(t.anchor_x) ? +t.anchor_x : null,
      anchor_y: hasFiniteAnchorValue(t.anchor_y) ? +t.anchor_y : null,
      replace_part: !!t.replace_part,
      lines:         Array.isArray(t.lines) ? t.lines : null,
      photo_svg_b64: t.photo_svg_b64 || "",
      photo_scale:   clampPhotoScale(t.photo_scale),
      photo_color:   normalizeHexColor(t.photo_color || "#ffffff"),
      letter_expand: isNewTile ? 2.5 : 1.0,
      allow_fallback: !isNewTile,
      font:          effectiveFontKey(t.font),
      color_remap:   (t.color_remap && typeof t.color_remap === "object")
                       ? t.color_remap : null,
      text_gradient: textGradient,
    };
  }
  function setStatus(msg) { statusEl.textContent = msg || ""; }
  function applyModeUI(mode, options = {}) {
    state.mode = mode;
    if (!options || options.writeGlobal !== false) state.global.kind = mode;
    document.querySelectorAll(".panel[data-panel='editor'] .seg-btn").forEach(b => {
      if (b.dataset.mode) b.classList.toggle("active", b.dataset.mode === mode);
    });
    document.body.classList.remove("mode-text", "mode-logo");
    document.body.classList.add("mode-" + mode);
  }

  // ── Master / New files load ────────────────
  async function loadMaster() {
    setStatus("Загружаю эмодзи…");
    const r = await fetch("/api/master/list");
    if (!r.ok) throw new Error("master list http " + r.status);
    state.masterFiles = await r.json();
    setStatus("");
  }
  async function loadNew() {
    try {
      const r = await fetch("/api/new/list?v=" + Date.now(), { cache: "no-store" });
      if (r.ok) state.newFiles = await r.json();
    } catch (_) { /* New tab optional */ }
  }
  async function loadUploads() {
    try {
      const r = await fetch("/api/uploads/list", { headers: apiHeaders() });
      if (r.ok) {
        const items = await r.json();
        if (Array.isArray(items)) state.uploadFiles = items;
      }
    } catch (_) { /* uploads are optional */ }
  }
  function allFiles() {
    const combined = state.masterFiles.concat(state.newFiles);
    const rest = [], passports = [];
    for (const f of combined) (isPassportId(f.id) ? passports : rest).push(f);
    return rest.concat(passports);
  }
  function editorFiles() {
    if (state.format !== "sticker" || state.selected.size === 0) return allFiles();
    return allFiles().filter(f => state.selected.has(f.id));
  }
  function fileById(id) { return allFiles().find(f => f.id === id) || null; }
  function isNewId(id) { return typeof id === "string" && id.startsWith("new:"); }
  function isUploadId(id) { return typeof id === "string" && id.startsWith("upload:"); }
  function tileBadge(id) {
    if (isUploadId(id)) return "★";
    if (isNewId(id)) return String(id).replace("new:", "✨");
    return id;
  }

  function fontCssName(key) {
    return "PackFont-" + String(key || DEFAULT_FONT_KEY).replace(/[^a-z0-9_-]/gi, "_");
  }
  function fontByKey(key) {
    const k = String(key || DEFAULT_FONT_KEY);
    return state.fonts.find(f => f.key === k) || state.fonts[0] || FALLBACK_FONTS[0];
  }
  function effectiveFontKey(key) {
    return (fontByKey(key || state.global.font || DEFAULT_FONT_KEY).key || DEFAULT_FONT_KEY);
  }
  function currentEmojiFontKey() {
    const t = state.currentIdx != null ? (state.perEmoji[state.currentIdx] || null) : null;
    return effectiveFontKey(t && t.font);
  }
  function tileTextOverride(id) {
    const t = id != null ? state.perEmoji[id] : null;
    return (t && typeof t.text === "string" && t.text.trim() !== "") ? t.text : "";
  }
  function currentTextValue() {
    if (state.textScope === "tile" && state.currentIdx != null) {
      const t = state.perEmoji[state.currentIdx] || null;
      if (t && typeof t.text === "string") return t.text;
      return state.global.text || "";
    }
    return state.global.text || "";
  }
  function tileLogoOverride(id) {
    const t = id != null ? state.perEmoji[id] : null;
    return (t && typeof t.logo_svg_b64 === "string" && t.logo_svg_b64) ? t.logo_svg_b64 : "";
  }
  function tilePngOverride(id) {
    const t = id != null ? state.perEmoji[id] : null;
    return (t && typeof t.logo_png_b64 === "string" && t.logo_png_b64) ? t.logo_png_b64 : "";
  }
  function tileHasOwnContent(id) {
    const t = id != null ? state.perEmoji[id] : null;
    return !!(tileTextOverride(id) || tileLogoOverride(id) || tilePngOverride(id)
      || (t && (t.kind === "text" || t.kind === "logo") && (tileTextOverride(id) || tileLogoOverride(id) || tilePngOverride(id))));
  }
  function currentContentKind() {
    if (state.textScope === "tile" && state.currentIdx != null) {
      const t = state.perEmoji[state.currentIdx] || null;
      if (t && (t.kind === "text" || t.kind === "logo")) return t.kind;
      if (tileLogoOverride(state.currentIdx)) return "logo";
      if (tileTextOverride(state.currentIdx)) return "text";
    }
    return state.global.kind === "logo" ? "logo" : "text";
  }
  function currentLogoB64() {
    if (state.textScope === "tile" && state.currentIdx != null) {
      const own = tileLogoOverride(state.currentIdx) || tilePngOverride(state.currentIdx);
      if (own) return own;
    }
    return state.global.logo_svg_b64 || state.global.logo_png_b64 || "";
  }
  function fontUrl(key) {
    const f = fontByKey(key);
    return f.url || ("/api/fonts/" + encodeURIComponent(f.key || DEFAULT_FONT_KEY));
  }
  function fallbackUrlsForText(text) {
    const s = String(text || "");
    if (!s || !state.fontFallbacks.length) return [];
    const urls = [];
    const seen = new Set();
    let hasNonAscii = false;
    for (const ch of Array.from(s)) {
      const cp = ch.codePointAt(0) || 0;
      if (cp > 0x7F) hasNonAscii = true;
      for (const f of state.fontFallbacks) {
        if (!f || !f.url || seen.has(f.url)) continue;
        const ranges = Array.isArray(f.ranges) ? f.ranges : [];
        if (ranges.some(r => Array.isArray(r) && r.length >= 2 && cp >= +r[0] && cp <= +r[1])) {
          urls.push(f.url);
          seen.add(f.url);
        }
      }
    }
    if (hasNonAscii) {
      for (const f of state.fontFallbacks) {
        if (f && f.default && f.url && !seen.has(f.url)) {
          urls.unshift(f.url);
          seen.add(f.url);
          break;
        }
      }
    }
    return urls;
  }
  function fontTextForOverride(ov) {
    if (!ov || typeof ov !== "object") return "";
    const parts = [];
    if (ov.kind !== "logo" && typeof ov.text === "string") parts.push(ov.text);
    if (Array.isArray(ov.lines)) {
      for (const line of ov.lines) {
        if (line && typeof line.text === "string") parts.push(line.text);
      }
    }
    return parts.join(" ");
  }
  function installFontFaces() {
    let style = document.getElementById("pack-font-faces");
    if (!style) {
      style = document.createElement("style");
      style.id = "pack-font-faces";
      document.head.appendChild(style);
    }
    style.textContent = state.fonts.map(f => {
      const url = fontUrl(f.key).replace(/"/g, "%22");
      return `@font-face{font-family:"${fontCssName(f.key)}";src:url("${url}") format("truetype");font-display:swap;}`;
    }).join("\n");
  }
  async function loadFonts() {
    try {
      const r = await fetch("/api/fonts/list");
      if (r.ok) {
        const items = await r.json();
        if (Array.isArray(items) && items.length) {
          state.fonts = items
            .filter(f => f && f.key && f.label)
            .map(f => ({
              key: String(f.key),
              label: String(f.label),
              sample: String(f.sample || "Lean"),
              url: String(f.url || ("/api/fonts/" + encodeURIComponent(f.key))),
            }));
        }
      }
    } catch (_) {
      state.fonts = FALLBACK_FONTS.slice();
    }
    try {
      const r = await fetch("/api/fonts/fallbacks");
      if (r.ok) {
        const items = await r.json();
        if (Array.isArray(items)) {
          state.fontFallbacks = items
            .filter(f => f && f.url)
            .map(f => ({
              key: String(f.key || ""),
              label: String(f.label || ""),
              url: String(f.url),
              ranges: Array.isArray(f.ranges) ? f.ranges : [],
              default: !!f.default,
            }));
        }
      }
    } catch (_) {
      state.fontFallbacks = [];
    }
    installFontFaces();
    renderFontMenu();
    renderPdeFontMenu();
  }
  async function loadFontKey(key, sampleText) {
    const selected = fontByKey(key || state.global.font);
    const fallbackUrls = fallbackUrlsForText(sampleText || "");
    try {
      await SwexReplacer.loadFont(fontUrl(selected.key), fallbackUrls);
      return selected.key || DEFAULT_FONT_KEY;
    } catch (e) {
      console.error("[editor] font load failed:", e);
      if (selected.key !== DEFAULT_FONT_KEY) {
        try { await SwexReplacer.loadFont(fontUrl(DEFAULT_FONT_KEY), fallbackUrls); }
        catch (_) {}
      }
      return DEFAULT_FONT_KEY;
    }
  }
  async function ensureFont(key, sampleText) {
    return await loadFontKey(key || state.global.font, sampleText);
  }

  function cloneLottieData(data) {
    return JSON.parse(JSON.stringify(data));
  }
  function touchLottieCache(id) {
    const key = String(id);
    const order = state.cacheOrder;
    const idx = order.indexOf(key);
    if (idx !== -1) order.splice(idx, 1);
    order.push(key);
  }
  function rememberLottieCache(id, json) {
    const key = String(id);
    state.cache[key] = json;
    touchLottieCache(key);
    while (state.cacheOrder.length > LOTTIE_CACHE_LIMIT) {
      const stale = state.cacheOrder.shift();
      if (stale && stale !== key) delete state.cache[stale];
    }
  }
  async function loadLottie(id) {
    const cacheKey = String(id);
    if (Object.prototype.hasOwnProperty.call(state.cache, cacheKey)) {
      touchLottieCache(cacheKey);
      return cloneLottieData(state.cache[cacheKey]);
    }
    if (state.cacheInflight[id]) return cloneLottieData(await state.cacheInflight[id]);
    const f = fileById(id);
    if (!f) throw new Error("no file for id " + id);
    const base = isUploadId(id) ? "/api/uploads/" : (isNewId(id) ? "/api/new/" : "/api/master/");
    // Cache-bust via `?v=<mtime>` returned by the listing endpoint. When a
    // .tgs file is regenerated on the server, mtime changes → URL changes →
    // browsers / Telegram WebView Service Worker / Cloudflare-style proxies
    // all fetch the new bytes instead of serving 24h-old cached copies.
    const ver = (f.v != null) ? ("?v=" + encodeURIComponent(f.v)) : "";
    state.cacheInflight[id] = (async () => {
      const r = await fetch(base + encodeURIComponent(f.file) + ver, {
        headers: isUploadId(id) ? { "X-Telegram-Init-Data": tg?.initData || "" } : undefined,
      });
      if (!r.ok) throw new Error("tgs http " + r.status);
      const buf = new Uint8Array(await r.arrayBuffer());
      return JSON.parse(pako.ungzip(buf, { to: "string" }));
    })();
    try {
      const json = await state.cacheInflight[id];
      rememberLottieCache(id, json);
      return cloneLottieData(json);
    } finally {
      delete state.cacheInflight[id];
    }
  }

  function previewUrlForNew(id) {
    const f = fileById(id);
    if (!f || !isNewId(id) || !f.preview) return "";
    const ver = (f.preview_v != null) ? ("?v=" + encodeURIComponent(f.preview_v)) : "";
    return "/api/new_preview/" + encodeURIComponent(f.preview) + ver;
  }

  function renderStaticPreview(container, id, fallback) {
    const url = previewUrlForNew(id);
    if (!url || !container) return false;
    container.innerHTML = "";
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.loading = "lazy";
    img.src = url;
    img.addEventListener("load", () => {
      if (fallback) fallback.style.display = "none";
    }, { once: true });
    img.addEventListener("error", () => {
      if (fallback) fallback.style.display = "";
    }, { once: true });
    container.appendChild(img);
    return true;
  }

  // ── Preview render ─────────────────────────
  let _previewToken = 0;
  function counterMarkup() {
    const title = emojiPickerOpen ? "Открыто" : "Каталог";
    return `<span class="pc-mark" aria-hidden="true"></span><span class="pc-title">${title}</span><span class="pc-chevron" aria-hidden="true"></span>`;
  }
  function refreshCounterOpenState() {
    if (!counter) return;
    counter.classList.toggle("is-open", emojiPickerOpen);
    counter.setAttribute("aria-expanded", String(emojiPickerOpen));
    if (previewStripDock) previewStripDock.classList.toggle("picker-open", emojiPickerOpen);
    const title = counter.querySelector(".pc-title");
    if (title) title.textContent = emojiPickerOpen ? "Открыто" : "Каталог";
  }
  // Live masked PNG-logo preview: renders the sticker twice (with the
  // original swex letters, and with them stripped — `data`, already
  // computed by the caller) into two canvases, diffs them every Lottie
  // frame tick to find which pixels some *other* layer draws in front of
  // the badge (see services/pack_builder.py:_compute_protect_mask for the
  // exact same idea, server-side), and paints the PNG into the visible
  // canvas only outside that protected region. Heavier than the old flat
  // <img> overlay (two Lottie canvas renders + a per-pixel diff on every
  // frame) — a deliberate trade the user asked for over the cheaper but
  // visually-wrong "always on top" approximation.
  const layeredPngPreviewCache = new Map();
  // Never return to the visually-wrong HTML <img> overlay.  When a legacy
  // template truly has no replaceable logo slot, show its untouched animation;
  // the final renderer also leaves that tile unchanged.
  const ENABLE_FLAT_PNG_PREVIEW_FALLBACK = false;
  async function loadLayeredPngPreview(id, eff) {
    const png = String(eff.logo_png_b64 || "");
    const fingerprint = png.length + ":" + png.slice(0, 24) + ":" + png.slice(-24);
    const key = [id, fingerprint, +eff.scale || 1, +eff.offset_x || 0, +eff.offset_y || 0].join("|");
    if (layeredPngPreviewCache.has(key)) return layeredPngPreviewCache.get(key);
    const pending = fetch("/api/png_preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        logo_png_b64: png,
        scale: +eff.scale || 1,
        offset_x: +eff.offset_x || 0,
        offset_y: +eff.offset_y || 0,
      }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.animation) {
        throw new Error(payload.error || ("PNG preview HTTP " + response.status));
      }
      return payload.animation;
    });
    layeredPngPreviewCache.set(key, pending);
    try {
      const animation = await pending;
      layeredPngPreviewCache.set(key, animation);
      while (layeredPngPreviewCache.size > 4) {
        layeredPngPreviewCache.delete(layeredPngPreviewCache.keys().next().value);
      }
      return animation;
    } catch (error) {
      layeredPngPreviewCache.delete(key);
      throw error;
    }
  }

  async function renderPreview(id) {
    const token = ++_previewToken;
    counter.classList.remove("is-new");
    counter.innerHTML = counterMarkup();
    refreshCounterOpenState();
    refreshEmojiPickerState(id);
    if (state.anim) { try { state.anim.destroy(); } catch (_) {} state.anim = null; }
    previewBox.innerHTML = "";
    try {
      const original = await loadLottie(id);
      if (token !== _previewToken) return;
      state.currentLottieSize = {
        w: Number(original.w) || 512,
        h: Number(original.h) || 512,
      };
      const eff = effectiveOverride(id);
      if (eff.kind === "text" && !String(eff.text || "").trim()) {
        eff.text = DEFAULT_BRAND_TEXT;
      }
      await ensureFont(eff.font, fontTextForOverride(eff));
      if (token !== _previewToken) return;
      // Всегда применяем applyToLottie: убирает VELORA, применяет цвет/позицию/масштаб
      let data;
      let layeredPngPreview = false;
      try {
        if (eff.kind === "logo" && eff.logo_png_b64 && !isUploadId(id)) {
          const layered = await loadLayeredPngPreview(id, eff);
          if (token !== _previewToken) return;
          // The server has already removed the wordmark and inserted the PNG
          // at its true depth.  Keep the rest of the override (notably palette
          // edits), but do not ask the vector replacer to process the PNG again.
          data = SwexReplacer.applyToLottie(layered, {
            ...eff,
            logo_png_b64: "",
            logo_svg_b64: "",
          });
          layeredPngPreview = true;
        } else {
          data = SwexReplacer.applyToLottie(original, eff);
        }
      } catch (e) {
        if (eff.kind === "logo" && eff.logo_png_b64) {
          console.info("[editor] no layered PNG slot for", id, e?.message || e);
        } else {
          console.error("[editor] applyToLottie failed:", e);
        }
        // Keep a usable preview for unsupported/uploaded templates.  The
        // fallback overlay is deliberately limited to this error path.
        data = SwexReplacer.applyToLottie(original, eff);
      }
      state.anim = lottie.loadAnimation({
        container: previewBox,
        renderer: "svg",
        loop: true,
        autoplay: true,
        animationData: data,
      });
      // PNG logos can't be inserted as vector shapes in the Lottie
      // preview (only the real pack build composites the raster onto
      // rendered frames) — overlay the raw image instead, and re-position
      // it on every Lottie frame tick using the sticker's OWN animated
      // transform (SwexReplacer.swexCanvasXformAtFrame — same walk as the
      // rest-state box, evaluated live) so it doesn't sit still while a
      // moving/scaling badge animates underneath it. `logo_box` (from
      // /api/master|new/list, the rest-state box computed server-side by
      // the same function the real build uses) is the static fallback for
      // tiles where the live per-frame walk can't find the badge.
      //
      // NOTE: an earlier attempt replaced this with a canvas + per-frame
      // pixel-diff protect-mask (matching the real build's z-order
      // handling exactly) — reverted because it could not be verified in
      // this environment (no browser) and made the logo disappear
      // entirely rather than just being visually imprecise. The real
      // built pack already applies that masking correctly server-side
      // (services/pack_builder.py:_compute_protect_mask); only this
      // preview approximation is flat/on-top.
      if (ENABLE_FLAT_PNG_PREVIEW_FALLBACK
          && eff.kind === "logo" && eff.logo_png_b64 && !layeredPngPreview) {
        const overlay = document.createElement("img");
        overlay.className = "preview-png-overlay";
        overlay.src = "data:image/png;base64," + eff.logo_png_b64;
        const f = fileById(id);
        const staticBox = f && Array.isArray(f.logo_box) && f.logo_box.length === 4
          ? f.logo_box : null;
        let liveLocalBBox = null;
        try {
          const containers = SwexReplacer.findSwexContainers(original);
          if (containers && containers.length) liveLocalBBox = containers[0].bbox;
        } catch (_) { liveLocalBBox = null; }

        const positionOverlay = (frameNum) => {
          let box = staticBox;
          if (liveLocalBBox) {
            const xform = SwexReplacer.swexCanvasXformAtFrame(original, frameNum);
            if (xform) {
              const [xsx, xsy, xox, xoy] = xform;
              const [lx0, ly0, lx1, ly1] = liveLocalBBox;
              const cx0 = xox + xsx * lx0, cx1 = xox + xsx * lx1;
              const cy0 = xoy + xsy * ly0, cy1 = xoy + xsy * ly1;
              box = [
                Math.min(cx0, cx1), Math.min(cy0, cy1),
                Math.max(cx0, cx1), Math.max(cy0, cy1),
              ];
            }
          }
          if (!box) return;
          const cw = state.currentLottieSize.w || 512;
          const ch = state.currentLottieSize.h || 512;
          const pw = previewBox.clientWidth || 220;
          const ph = previewBox.clientHeight || 220;
          // Mirror services/pack_builder.py:_scale_png_box (position/size)
          // and its hard 1.3x cap — a PNG composite always paints over
          // neighbouring artwork, so it's capped well below the general
          // text/SVG scale range.
          const bscale = Math.max(0.3, Math.min(1.3, +eff.scale || 1));
          const bx = +eff.offset_x || 0;
          const by = +eff.offset_y || 0;
          const bcx = (box[0] + box[2]) / 2 + bx;
          const bcy = (box[1] + box[3]) / 2 + by;
          const bhw = (box[2] - box[0]) / 2 * bscale;
          const bhh = (box[3] - box[1]) / 2 * bscale;
          const sx = pw / cw, sy = ph / ch;
          overlay.style.left = ((bcx - bhw) * sx) + "px";
          overlay.style.top = ((bcy - bhh) * sy) + "px";
          overlay.style.width = (bhw * 2 * sx) + "px";
          overlay.style.height = (bhh * 2 * sy) + "px";
          overlay.style.transform = "none";
          overlay.style.maxWidth = "none";
          overlay.style.maxHeight = "none";
        };
        positionOverlay(0);
        if (state.anim) {
          state.anim.addEventListener("enterFrame", () => {
            if (!overlay.isConnected) return;
            positionOverlay(state.anim.currentFrame);
          });
        }
        previewBox.appendChild(overlay);
      }
    } catch (e) {
      console.error("[editor] preview render failed:", e);
      previewBox.textContent = "✗ " + e.message;
    }
  }

  let _renderTimer = null;
  function rerenderPreviewSoon() {
    if (_renderTimer) clearTimeout(_renderTimer);
    const current = state.currentIdx != null ? effectiveOverride(state.currentIdx) : null;
    const delay = current && current.logo_png_b64 ? 280 : 90;
    _renderTimer = setTimeout(() => {
      _renderTimer = null;
      if (state.currentIdx != null) renderPreview(state.currentIdx);
    }, delay);
  }

  function currentIsUploadTile() {
    return isUploadId(state.currentIdx);
  }
  function updateUploadPlacementUi() {
    const on = currentIsUploadTile();
    if (uploadPlacePanel) uploadPlacePanel.classList.toggle("hidden", !on);
    const mode = on ? state.placementMode : false;
    document.body.classList.toggle("placement-mode", !!mode);
    document.body.classList.toggle("replace-part-mode", mode === "replace");
    if (uploadPlaceBtn) {
      uploadPlaceBtn.classList.toggle("active", mode === "attach");
      uploadPlaceBtn.textContent = mode === "attach" ? "Ткни слой" : "Выбрать слой";
    }
    if (uploadReplaceBtn) {
      uploadReplaceBtn.classList.toggle("active", mode === "replace");
      uploadReplaceBtn.textContent = mode === "replace" ? "Ткни часть" : "Заменить часть";
    }
    const t = state.currentIdx != null ? (state.perEmoji[state.currentIdx] || null) : null;
    const hasAnchor = t && hasFiniteAnchorValue(t.anchor_x) && hasFiniteAnchorValue(t.anchor_y);
    if (uploadPlaceStatus) {
      uploadPlaceStatus.textContent = !on
        ? ""
        : (mode === "replace"
          ? "Ткни часть, которую нужно удалить и заменить"
          : (mode === "attach"
            ? "Нажми на часть стикера, к которой привязать надпись"
            : (hasAnchor ? "Слой выбран, дальше двигай ползунками" : "Сначала ткни часть стикера")));
    }
  }
  function previewPointToLottie(clientX, clientY) {
    const rect = previewBox.getBoundingClientRect();
    const w = (state.currentLottieSize && state.currentLottieSize.w) || 512;
    const h = (state.currentLottieSize && state.currentLottieSize.h) || 512;
    const scale = Math.min(rect.width / w, rect.height / h);
    const drawW = w * scale;
    const drawH = h * scale;
    const left = rect.left + (rect.width - drawW) / 2;
    const top = rect.top + (rect.height - drawH) / 2;
    const x = Math.max(0, Math.min(w, ((clientX - left) / drawW) * w));
    const y = Math.max(0, Math.min(h, ((clientY - top) / drawH) * h));
    return { x: +x.toFixed(2), y: +y.toFixed(2) };
  }
  function setPlacementMode(mode) {
    state.placementMode = currentIsUploadTile() ? (mode || false) : false;
    updateUploadPlacementUi();
  }
  uploadPlaceBtn?.addEventListener("click", () => setPlacementMode(state.placementMode === "attach" ? false : "attach"));
  uploadReplaceBtn?.addEventListener("click", () => setPlacementMode(state.placementMode === "replace" ? false : "replace"));
  uploadPlaceReset?.addEventListener("click", () => {
    if (!currentIsUploadTile()) return;
    const t = getTransform(state.currentIdx);
    t.anchor_x = null;
    t.anchor_y = null;
    t.replace_part = false;
    t.offset_x = 0;
    t.offset_y = 0;
    loadEditorFromState();
    rerenderPreviewSoon();
  });
  previewBox?.addEventListener("pointerdown", (e) => {
    if (!state.placementMode || !currentIsUploadTile()) return;
    e.preventDefault();
    const p = previewPointToLottie(e.clientX, e.clientY);
    const t = getTransform(state.currentIdx);
    const replacePart = state.placementMode === "replace";
    t.anchor_x = p.x;
    t.anchor_y = p.y;
    t.replace_part = replacePart;
    t.offset_x = 0;
    t.offset_y = 0;
    setPlacementMode(false);
    loadEditorFromState();
    rerenderPreviewSoon();
  });

  // ── Tabs ───────────────────────────────────
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.tab;
      document.querySelectorAll(".panel").forEach(p => {
        p.classList.toggle("hidden", p.dataset.panel !== target);
      });
      if (target === "grid") rebuildGrid();
      if (target === "new")  rebuildGridNew();
    });
  });

  // ── Mode (text/logo) — глобальный режим ────
  document.querySelectorAll(".panel[data-panel='editor'] .seg-btn").forEach(btn => {
    if (!btn.dataset.mode) return;
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      if (state.textScope === "tile" && state.currentIdx != null) {
        const t = getTransform(state.currentIdx);
        t.kind = mode;
        if (mode === "text") t.logo_svg_b64 = "";
        clearPreviewStyleAffordance();
        applyModeUI(mode, { writeGlobal: false });
        syncTextScopeUi();
        rebuildGridCellState(state.currentIdx);
      } else {
        applyModeUI(mode);
      }
      rerenderPreviewSoon();
    });
  });

  // ── Текст (глобальный) ─────────────────────
  const textInput = $("text-input");
  const textScopeGlobalBtn = $("text-scope-global");
  const textScopeTileBtn = $("text-scope-tile");
  const textScopeResetBtn = $("text-scope-reset");
  const textScopeTitle = $("text-scope-title");
  const textScopeSub = $("text-scope-sub");
  const contentColorInput = $("content-color");
  const contentColorVal = $("content-color-val");
  const gradientToggle = $("gradient-toggle");
  const gradientControls = $("gradient-controls");
  const gradientFromInput = $("gradient-from");
  const gradientToInput = $("gradient-to");
  const packStyleRow = $("pack-style-row");
  const packStyleToggle = $("pack-style-toggle");
  const packStylePanel = $("pack-style-panel");
  const packStylePresets = $("pack-style-presets");
  const packStyleStatus = $("pack-style-status");
  const templateSaveBtn = $("template-save");
  const templateApplyBtn = $("template-apply");
  const templateStatus = $("template-status");
  const fontPicker = document.querySelector(".font-picker");
  const fontToggle = $("font-toggle");
  const fontMenu = $("font-menu");
  const fontCurrent = $("font-current");
  const fontApplyAll = $("font-apply-all");
  function renderFontMenu() {
    if (!fontMenu) return;
    const activeKey = currentEmojiFontKey();
    fontMenu.innerHTML = "";
    state.fonts.forEach(f => {
      const btn = document.createElement("button");
      btn.className = "font-option";
      btn.type = "button";
      btn.dataset.font = f.key;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", f.key === activeKey ? "true" : "false");
      btn.innerHTML = `
        <span class="font-sample">${escapeHtml(f.sample || "Lean")}</span>
        <span class="font-name">${escapeHtml(f.label)}</span>
      `;
      btn.style.fontFamily = `"${fontCssName(f.key)}", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      btn.classList.toggle("active", f.key === activeKey);
      btn.addEventListener("click", () => setCurrentEmojiFont(f.key));
      fontMenu.appendChild(btn);
    });
    updateFontUi();
  }
  function updateFontUi() {
    const f = fontByKey(currentEmojiFontKey());
    if (fontCurrent) {
      fontCurrent.textContent = f.label || "Seymour One";
      fontCurrent.style.fontFamily = `"${fontCssName(f.key)}", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    }
    if (fontMenu) {
      fontMenu.querySelectorAll(".font-option").forEach(btn => {
        const active = btn.dataset.font === f.key;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
  }
  function setFontMenuOpen(open) {
    if (!fontPicker || !fontMenu || !fontToggle) return;
    fontPicker.classList.toggle("open", open);
    fontMenu.classList.toggle("hidden", !open);
    fontToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  async function setCurrentEmojiFont(key) {
    if (state.currentIdx == null) return;
    const f = fontByKey(key);
    const t = getTransform(state.currentIdx);
    t.font = f.key || DEFAULT_FONT_KEY;
    clearPreviewStyleAffordance();
    updateFontUi();
    setFontMenuOpen(false);
    await ensureFont(t.font, fontTextForOverride(effectiveOverride(state.currentIdx)));
    updateFontUi();
    rebuildGridCellState(state.currentIdx);
    rerenderPreviewSoon();
  }
  fontToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    setFontMenuOpen(fontMenu.classList.contains("hidden"));
  });
  document.addEventListener("click", (e) => {
    if (fontPicker && !fontPicker.contains(e.target)) setFontMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setFontMenuOpen(false);
  });
  fontApplyAll?.addEventListener("click", () => {
    if (state.currentIdx == null) return;
    const src = effectiveFontKey(getTransform(state.currentIdx).font);
    applyAllWithAnimation("font-apply-all", (t) => {
      t.font = src;
    });
    clearPreviewStyleAffordance();
    updateFontUi();
  });
  function syncTextScopeUi() {
    const hasTileContent = tileHasOwnContent(state.currentIdx);
    const tileMode = state.textScope === "tile";
    const mode = currentContentKind();
    const value = currentTextValue().slice(0, 20);
    if (textInput && textInput.value !== value) textInput.value = value;
    const counter = $("text-counter");
    if (counter) counter.textContent = `${value.length}/20`;
    textScopeGlobalBtn?.classList.toggle("active", !tileMode);
    textScopeTileBtn?.classList.toggle("active", tileMode);
    textScopeGlobalBtn?.setAttribute("aria-pressed", !tileMode ? "true" : "false");
    textScopeTileBtn?.setAttribute("aria-pressed", tileMode ? "true" : "false");
    textScopeResetBtn?.classList.toggle("hidden", !hasTileContent);
    const isLogo = mode === "logo";
    if (textScopeTitle) {
      textScopeTitle.textContent = tileMode
        ? (isLogo ? "Лого этого эмодзи" : "Ник этого эмодзи")
        : (isLogo ? "Общий логотип" : "Общий ник");
    }
    if (textScopeSub) {
      if (tileMode) {
        textScopeSub.textContent = hasTileContent
          ? "только текущий эмодзи"
          : (isLogo ? "загрузи отдельный SVG для текущего" : "напиши отдельный ник для текущего");
      } else {
        textScopeSub.textContent = isLogo
          ? "применяется ко всем без своего лого"
          : "применяется ко всем без своего ника";
      }
    }
    const label = $("logo-label");
    if (label) label.textContent = currentLogoB64() ? "Лого загружено ✓" : "Загрузить SVG или фото";
    applyModeUI(mode, { writeGlobal: false });
  }
  function setTextScope(scope, focus = false) {
    state.textScope = scope === "tile" ? "tile" : "global";
    syncTextScopeUi();
    if (focus) {
      textInput?.focus();
      try {
        const n = textInput.value.length;
        textInput.setSelectionRange(n, n);
      } catch (_) {}
    }
  }
  textScopeGlobalBtn?.addEventListener("click", () => setTextScope("global", true));
  textScopeTileBtn?.addEventListener("click", () => setTextScope("tile", true));
  textScopeResetBtn?.addEventListener("click", () => {
    if (state.currentIdx == null) return;
    const t = state.perEmoji[state.currentIdx];
    if (t) {
      t.text = "";
      t.kind = null;
      t.logo_svg_b64 = "";
      if (!isTransformChanged(t)) delete state.perEmoji[state.currentIdx];
    }
    state.textScope = "global";
    syncTextScopeUi();
    rebuildGridCellState(state.currentIdx);
    rerenderPreviewSoon();
  });
  textInput.addEventListener("input", () => {
    const v = textInput.value.slice(0, 20);
    $("text-counter").textContent = `${v.length}/20`;
    if (state.textScope === "tile" && state.currentIdx != null) {
      const t = getTransform(state.currentIdx);
      t.kind = "text";
      t.text = v;
      t.logo_svg_b64 = "";
      if (!isTransformChanged(t)) delete state.perEmoji[state.currentIdx];
      rebuildGridCellState(state.currentIdx);
    } else {
      state.global.text = v;
    }
    syncTextScopeUi();
    rerenderPreviewSoon();
  });
  if (contentColorInput) {
    const onColor = () => {
      const color = normalizeHexColor(contentColorInput.value);
      const t = getTransform(state.currentIdx);
      t.content_color = color;
      contentColorInput.value = color;
      if (contentColorVal) contentColorVal.textContent = color.toUpperCase();
      clearPreviewStyleAffordance();
      rebuildGridCellState(state.currentIdx);
      rerenderPreviewSoon();
    };
    contentColorInput.addEventListener("input", onColor);
    contentColorInput.addEventListener("change", onColor);
  }
  function syncGradientUi(t) {
    const g = normalizeTextGradient(t && t.text_gradient);
    if (gradientToggle) {
      gradientToggle.classList.toggle("active", g.enabled);
      gradientToggle.setAttribute("aria-pressed", g.enabled ? "true" : "false");
    }
    if (gradientControls) gradientControls.classList.toggle("hidden", !g.enabled);
    if (gradientFromInput) gradientFromInput.value = g.from;
    if (gradientToInput) gradientToInput.value = g.to;
  }
  function updateTextGradient(partial) {
    const t = getTransform(state.currentIdx);
    const cur = normalizeTextGradient(t.text_gradient);
    t.text_gradient = {
      ...cur,
      ...partial,
      from: normalizeHexColor((partial && partial.from) || cur.from),
      to: normalizeHexColor((partial && partial.to) || cur.to),
    };
    clearPreviewStyleAffordance();
    syncGradientUi(t);
    rebuildGridCellState(state.currentIdx);
    rerenderPreviewSoon();
  }
  gradientToggle?.addEventListener("click", () => {
    const t = getTransform(state.currentIdx);
    const cur = normalizeTextGradient(t.text_gradient);
    const baseColor = normalizeHexColor(t.content_color);
    updateTextGradient({
      enabled: !cur.enabled,
      from: cur.from || baseColor,
      to: cur.to || "#30d158",
    });
  });
  gradientFromInput?.addEventListener("input", () => {
    updateTextGradient({ enabled: true, from: normalizeHexColor(gradientFromInput.value) });
  });
  gradientToInput?.addEventListener("input", () => {
    updateTextGradient({ enabled: true, to: normalizeHexColor(gradientToInput.value) });
  });

  // ── Advanced layer-colors modal ────────────────
  const lcmBackdrop = $("layer-colors-modal");
  const lcmList     = $("layer-colors-list");
  const lcmOpenBtn  = $("layer-colors-open");
  const pdeLcmOpenBtn = $("pde-layer-colors-open");
  const lcmCloseBtn = $("layer-colors-close");
  const lcmResetBtn = $("layer-colors-reset");
  const packPalettePrimaryInput = $("pack-palette-primary");
  const packPaletteLightInput = $("pack-palette-light");
  const packPaletteGradientBtn = $("pack-palette-gradient");
  const packPaletteApplyBtn = $("pack-palette-apply");
  const packPaletteResetBtn = $("pack-palette-reset");
  const packPaletteStatus = $("pack-palette-status");
  const packPaletteRow = document.querySelector(".pack-palette-row");
  let layerColorContext = "main"; // "main" | "pde"
  let packPaletteRunning = false;
  let packStyleRunning = false;
  let activeStyleKey = null;
  let previewStyleKey = null;
  let previewPaletteSpec = null;
  const styleBrushRunning = new Set();

  // Cache of unique colors per tile, computed on demand from the cached
  // lottie JSON. Keyed by tile id; value is an array of normalized hex
  // strings in the order they appear in the JSON (stable across opens).
  const _tileColorsCache = {};
  const _tileColorStatsCache = {};

  function rgbaToHex(rgba) {
    if (!Array.isArray(rgba)) return null;
    const r = Math.max(0, Math.min(255, Math.round((rgba[0] || 0) * 255)));
    const g = Math.max(0, Math.min(255, Math.round((rgba[1] || 0) * 255)));
    const b = Math.max(0, Math.min(255, Math.round((rgba[2] || 0) * 255)));
    return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
  }
  function hexToRgb(hex) {
    const h = normalizeHexColor(hex).slice(1);
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
    };
  }
  function colorLuma(hex) {
    const c = hexToRgb(hex);
    return (0.2126 * c.r) + (0.7152 * c.g) + (0.0722 * c.b);
  }
  function colorSaturation(hex) {
    const c = hexToRgb(hex);
    const max = Math.max(c.r, c.g, c.b);
    const min = Math.min(c.r, c.g, c.b);
    return max <= 0 ? 0 : (max - min) / max;
  }

  function collectTileColorStats(json) {
    // Walk every static fl/st node and remember its colour. Animated colours
    // and gradient fills are skipped — they're rare in our pack and would
    // require keyframe-aware remapping to look right.
    const seen = new Map();
    function visit(n) {
      if (n && typeof n === "object") {
        if (Array.isArray(n)) {
          for (const c of n) visit(c);
          return;
        }
        if (n.ty === "fl" || n.ty === "st") {
          const c = n.c;
          if (c && c.a === 0 && Array.isArray(c.k)) {
            const hex = rgbaToHex(c.k);
            if (hex) {
              const entry = seen.get(hex) || { hex, fill: false, stroke: false };
              if (n.ty === "fl") entry.fill = true;
              if (n.ty === "st") entry.stroke = true;
              seen.set(hex, entry);
            }
          }
        }
        for (const k of ["layers", "assets", "shapes", "it"]) {
          if (Array.isArray(n[k])) visit(n[k]);
        }
      }
    }
    visit(json);
    return Array.from(seen.values());
  }

  function collectTileColors(json) {
    return collectTileColorStats(json).map(entry => entry.hex);
  }

  async function getTileColors(id) {
    if (_tileColorsCache[id]) return _tileColorsCache[id];
    let json;
    try { json = await loadLottie(id); }
    catch (e) { console.error("[lcm] load failed:", e); return []; }
    const stats = collectTileColorStats(json);
    const colors = stats.map(entry => entry.hex);
    _tileColorStatsCache[id] = stats;
    _tileColorsCache[id] = colors;
    return colors;
  }

  async function getTileColorStats(id) {
    if (_tileColorStatsCache[id]) return _tileColorStatsCache[id];
    let json;
    try { json = await loadLottie(id); }
    catch (e) { console.error("[palette] load failed:", e); return []; }
    const stats = collectTileColorStats(json);
    _tileColorStatsCache[id] = stats;
    _tileColorsCache[id] = stats.map(entry => entry.hex);
    return stats;
  }

  function packPaletteUsesLight(hex) {
    const luma = colorLuma(hex);
    const sat = colorSaturation(hex);
    // Light/neutral fills become the light swatch; everything darker or
    // saturated becomes the main colour. This makes packs with different
    // layer counts converge into one two-colour style.
    return luma >= 0.74 || (luma >= 0.62 && sat < 0.18);
  }

  function packPaletteTargetColor(hex, primary, light) {
    return packPaletteUsesLight(hex) ? light : primary;
  }

  function packPaletteEntryHex(entry) {
    return normalizeHexColor(entry && typeof entry === "object" ? entry.hex : entry);
  }

  function packPaletteTargetSpec(entry, primary, light, gradient = false) {
    const hex = packPaletteEntryHex(entry);
    const isLight = packPaletteUsesLight(hex);
    const isStroke = !(entry && typeof entry === "object") || !!entry.stroke;
    if (gradient) {
      if (isLight && isStroke) {
        return { mode: "gradient", from: primary, to: light, target: "stroke" };
      }
      return null;
    }
    if (isLight) return { mode: "solid", color: light };
    return { mode: "solid", color: primary };
  }

  function buildPackPaletteRemap(colors, primary, light, options = {}) {
    const remap = {};
    const gradient = !!(options && options.gradient);
    for (const entry of colors || []) {
      const orig = packPaletteEntryHex(entry);
      const payload = layerColorSpecPayload(packPaletteTargetSpec(entry, primary, light, gradient), orig);
      if (payload) remap[orig] = payload;
    }
    return remap;
  }

  function packPaletteGradientEnabled() {
    return !!(packPaletteGradientBtn && packPaletteGradientBtn.classList.contains("active"));
  }

  function syncPackPaletteVisuals() {
    const primary = normalizeHexColor(packPalettePrimaryInput?.value || "#ff2d55");
    const light = normalizeHexColor(packPaletteLightInput?.value || "#ffffff");
    const enabled = packPaletteGradientEnabled();
    for (const el of [packPaletteRow, packPaletteApplyBtn, packPaletteGradientBtn]) {
      if (!el) continue;
      el.style.setProperty("--palette-a", primary);
      el.style.setProperty("--palette-b", light);
    }
    if (packPaletteGradientBtn) {
      packPaletteGradientBtn.classList.toggle("active", enabled);
      packPaletteGradientBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
    }
  }

  function setPackPaletteStatus(text, cls = "") {
    if (!packPaletteStatus) return;
    packPaletteStatus.textContent = text;
    packPaletteStatus.classList.toggle("busy", cls === "busy");
    packPaletteStatus.classList.toggle("done", cls === "done");
  }

  function setPackPaletteBusy(busy) {
    packPaletteRunning = busy;
    if (packPaletteApplyBtn) packPaletteApplyBtn.disabled = busy;
    if (packPaletteGradientBtn) packPaletteGradientBtn.disabled = busy;
    if (packPaletteResetBtn) packPaletteResetBtn.disabled = busy;
  }

  function cleanupDefaultTransform(id) {
    const t = state.perEmoji[id];
    if (t && !isTransformChanged(t)) delete state.perEmoji[id];
  }

  function refreshAfterPackPalette() {
    if (stripBuilt) rebuildPreviewStrip();
    if (gridBuilt) rebuildGrid();
    if (gridNewBuilt) rebuildGridNew();
    if (emojiPickerBuilt && emojiPickerOpen) rebuildEmojiPicker(true);
    refreshStyleBrushTargets(state.currentIdx);
    rerenderPreviewSoon();
  }

  function countPaletteEditedTiles() {
    return allFiles().filter(f => {
      const t = state.perEmoji[f.id];
      return t && hasColorRemap(t.color_remap);
    }).length;
  }

  async function applyPackPaletteToTile(id, palette) {
    if (id == null || !palette || isPassportId(id)) return false;
    const primary = normalizeHexColor(palette.primary || "#ff2d55");
    const light = normalizeHexColor(palette.light || "#ffffff");
    const gradient = !!palette.gradient;
    const colors = await getTileColorStats(id);
    const remap = buildPackPaletteRemap(colors, primary, light, { gradient });
    const keys = Object.keys(remap);
    const t = keys.length ? getTransform(id) : state.perEmoji[id];
    if (!t) return false;
    t.color_remap = keys.length ? remap : null;
    cleanupDefaultTransform(id);
    return keys.length > 0;
  }

  function sleep(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function applyPackPaletteToAll(options = {}) {
    if (packPaletteRunning) return;
    const files = allFiles();
    if (!files.length) return;
    const primary = normalizeHexColor(options.primary || packPalettePrimaryInput?.value || "#ff2d55");
    const light = normalizeHexColor(options.light || packPaletteLightInput?.value || "#ffffff");
    const gradient = options.gradient != null ? !!options.gradient : packPaletteGradientEnabled();
    previewPaletteSpec = { primary, light, gradient };
    const pulseTarget = options.button || packPaletteApplyBtn;
    setPackPaletteBusy(true);
    if (pulseTarget) pulseBtn(pulseTarget);
    setPackPaletteStatus(`0 / ${files.length}`, "busy");
    let done = 0;
    let changed = 0;
    let next = 0;
    const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
      while (next < files.length) {
        const f = files[next++];
        const colors = await getTileColorStats(f.id);
        const remap = buildPackPaletteRemap(colors, primary, light, { gradient });
        const keys = Object.keys(remap);
        const existing = state.perEmoji[f.id];
        const t = existing || (keys.length ? getTransform(f.id) : null);
        if (t) {
          t.color_remap = keys.length ? remap : null;
          if (keys.length) changed += 1;
          cleanupDefaultTransform(f.id);
        }
        done += 1;
        if (done % 8 === 0 || done === files.length) {
          setPackPaletteStatus(`${done} / ${files.length}`, "busy");
          await sleep(0);
        }
      }
    });
    try {
      await Promise.all(workers);
      refreshAfterPackPalette();
      setPackPaletteStatus(`Готово: ${changed}`, "done");
      setStatus(`Палитра применена к ${changed} эмодзи`);
    } catch (e) {
      console.error("[palette] apply failed:", e);
      setPackPaletteStatus("Ошибка", "");
      setStatus("Ошибка палитры: " + (e?.message || e));
    } finally {
      setPackPaletteBusy(false);
    }
  }

  function resetPackPaletteAll() {
    if (packPaletteRunning) return;
    let changed = 0;
    for (const f of allFiles()) {
      const t = state.perEmoji[f.id];
      if (!t || !t.color_remap) continue;
      t.color_remap = null;
      changed += 1;
      cleanupDefaultTransform(f.id);
    }
    pulseBtn(packPaletteResetBtn);
    refreshAfterPackPalette();
    setPackPaletteStatus(changed ? `Сброшено: ${changed}` : "слои всех эмодзи", changed ? "done" : "");
    setStatus(changed ? `Палитра сброшена у ${changed} эмодзи` : "");
  }

  packPaletteApplyBtn?.addEventListener("click", applyPackPaletteToAll);
  packPaletteResetBtn?.addEventListener("click", resetPackPaletteAll);
  packPalettePrimaryInput?.addEventListener("input", syncPackPaletteVisuals);
  packPaletteLightInput?.addEventListener("input", syncPackPaletteVisuals);
  packPaletteGradientBtn?.addEventListener("click", () => {
    packPaletteGradientBtn.classList.toggle("active");
    pulseBtn(packPaletteGradientBtn);
    syncPackPaletteVisuals();
    setPackPaletteStatus(packPaletteGradientEnabled() ? "градиент слоёв" : "слои всех эмодзи", "");
  });
  document.querySelectorAll(".pack-palette-presets button").forEach(btn => {
    btn.addEventListener("click", () => {
      const primary = normalizeHexColor(btn.dataset.palettePrimary || "#ff2d55");
      const light = normalizeHexColor(btn.dataset.paletteLight || "#ffffff");
      if (packPalettePrimaryInput) packPalettePrimaryInput.value = primary;
      if (packPaletteLightInput) packPaletteLightInput.value = light;
      syncPackPaletteVisuals();
      pulseBtn(btn);
    });
  });
  syncPackPaletteVisuals();

  function setPackStyleStatus(text, cls = "") {
    if (!packStyleStatus) return;
    packStyleStatus.textContent = text || "";
    packStyleStatus.classList.toggle("ok", cls === "ok");
    packStyleStatus.classList.toggle("busy", cls === "busy");
    packStyleStatus.classList.toggle("err", cls === "err");
  }

  function refreshPackStylePanelHeight() {
    if (!packStyleRow || !packStylePanel || !packStyleRow.classList.contains("open")) return;
    packStylePanel.style.maxHeight = `${packStylePanel.scrollHeight}px`;
  }

  function setPackStyleOpen(open) {
    if (!packStyleRow || !packStyleToggle || !packStylePanel) return;
    const next = !!open;
    packStyleRow.classList.toggle("open", next);
    packStyleToggle.setAttribute("aria-expanded", next ? "true" : "false");
    packStylePanel.style.maxHeight = next ? `${packStylePanel.scrollHeight}px` : "0px";
  }

  function setPackStyleBusy(busy) {
    packStyleRunning = !!busy;
    if (!packStylePresets) return;
    packStylePresets.querySelectorAll("button").forEach(btn => {
      btn.disabled = !!busy;
    });
  }

  function packStyleByKey(key) {
    return PACK_STYLE_PRESETS.find(p => p.key === key) || PACK_STYLE_PRESETS[0];
  }

  function activePackStyle() {
    return activeStyleKey ? packStyleByKey(activeStyleKey) : null;
  }

  function previewPackStyle() {
    const key = activeStyleKey || previewStyleKey;
    return key ? (PACK_STYLE_PRESETS.find(p => p.key === key) || null) : null;
  }

  function styleBrushAllowed(id) {
    return false;
  }

  function tileHasActiveStyle(id) {
    const t = state.perEmoji[id];
    return !!(activeStyleKey && t && t.pack_style === activeStyleKey);
  }

  function tileAppliedStyle(id) {
    const key = state.perEmoji[id] && state.perEmoji[id].pack_style;
    return key ? (PACK_STYLE_PRESETS.find(p => p.key === key) || null) : null;
  }

  function tileHasClearableStyle(id) {
    const t = state.perEmoji[id];
    if (!t) return false;
    return !!t.pack_style
      || hasColorRemap(t.color_remap);
  }

  function clearPreviewStyleAffordance() {
    activeStyleKey = null;
    previewStyleKey = null;
    previewPaletteSpec = null;
    refreshStyleBrushTargets(state.currentIdx);
  }

  function styleBrushButtonHtml() {
    return `
      <svg class="brush-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M10.8 2.4l2.8 2.8-6.2 6.2-2.8-2.8 6.2-6.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M4.1 9.2c-1.1.4-1.7 1.2-1.7 2.4 0 .9-.4 1.5-1.1 1.9 1.9.2 3.7-.3 4.3-1.7.3-.7.1-1.5-.5-2.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <svg class="brush-check" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M3 8.5 L7 12 L13 4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>
    `;
  }

  function makeStyleBrushButton(id, extraClass = "") {
    const btn = document.createElement("button");
    btn.className = `style-brush-btn ${extraClass} hidden`.trim();
    btn.type = "button";
    btn.dataset.styleId = String(id);
    btn.innerHTML = styleBrushButtonHtml();
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleStyleForTile(id, btn);
    });
    syncStyleBrushButton(btn, id);
    return btn;
  }

  function syncStyleBrushButton(btn, id) {
    if (!btn) return;
    const isPreviewClear = btn === previewStyleBrush;
    const appliedPreset = tileAppliedStyle(id);
    const clearable = tileHasClearableStyle(id);
    const previewPreset = previewPackStyle();
    const canApplyCurrent = !!((previewPreset || previewPaletteSpec) && id != null && !isPassportId(id));
    const allowed = isPreviewClear
      ? !!(id != null && !isPassportId(id) && (clearable || canApplyCurrent))
      : styleBrushAllowed(id);
    const applied = isPreviewClear ? clearable : tileHasActiveStyle(id);
    const busy = styleBrushRunning.has(String(id));
    btn.classList.toggle("hidden", !allowed);
    btn.classList.toggle("on", applied);
    btn.classList.toggle("busy", busy);
    btn.disabled = busy || !allowed;
    const preset = isPreviewClear ? previewPreset : activePackStyle();
    if (isPreviewClear) {
      if (clearable) {
        btn.title = appliedPreset
          ? `Убрать стиль ${appliedPreset.label} с этого эмодзи`
          : "Убрать покраску с этого эмодзи";
      } else {
        btn.title = preset
          ? `Применить стиль ${preset.label} к этому эмодзи`
          : "Вернуть палитру на этот эмодзи";
      }
    } else {
      btn.title = applied
        ? `Убрать стиль ${preset ? preset.label : ""}`
        : `Применить стиль ${preset ? preset.label : ""}`;
    }
    btn.setAttribute("aria-label", btn.title);
  }

  function refreshStyleBrushTargets(id = null) {
    document.body.classList.toggle("style-brush-mode", !!activeStyleKey);
    document.querySelectorAll(".pack-style-option").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.style === activeStyleKey);
    });
    const selector = id == null
      ? ".style-brush-btn"
      : `.style-brush-btn[data-style-id="${dataAttrValue(id)}"]`;
    document.querySelectorAll(selector).forEach(btn => {
      syncStyleBrushButton(btn, parseCellId(btn.dataset.styleId));
    });
    if (previewStyleBrush) {
      if (state.currentIdx != null) previewStyleBrush.dataset.styleId = String(state.currentIdx);
      syncStyleBrushButton(previewStyleBrush, state.currentIdx);
    }
    updateStyleBrushStatus();
  }

  function updateStyleBrushStatus() {
    if (!activeStyleKey) {
      setPackStyleStatus("", "");
      return;
    }
    const preset = activePackStyle();
    const count = allFiles().filter(f => {
      const t = state.perEmoji[f.id];
      return state.selected.has(f.id) && t && t.pack_style === activeStyleKey;
    }).length;
    setPackStyleStatus(`${preset.label}: ${count}`, count ? "ok" : "");
  }

  function selectPackStyle(key) {
    activeStyleKey = key;
    previewStyleKey = key;
    const preset = activePackStyle();
    if (packPalettePrimaryInput) packPalettePrimaryInput.value = normalizeHexColor(preset.primary);
    if (packPaletteLightInput) packPaletteLightInput.value = normalizeHexColor(preset.light);
    syncPackPaletteVisuals();
    refreshStyleBrushTargets();
    setStatus(`Выбран стиль "${preset.label}". Он применится к выбранным эмодзи.`);
  }

  function clearStyleFields(t) {
    t.content_color = "#ffffff";
    t.font = null;
    t.text_gradient = null;
    t.color_remap = null;
    t.pack_style = null;
  }

  async function applyStyleToTile(id, preset) {
    const font = effectiveFontKey(preset.font);
    await ensureFont(font, state.global.text || "Lean");
    const colors = await getTileColors(id);
    const remap = buildPackPaletteRemap(colors, preset.primary, preset.light);
    const t = getTransform(id);
    t.content_color = normalizeHexColor(preset.content);
    t.font = font;
    t.text_gradient = preset.gradient
      ? {
          enabled: true,
          from: normalizeHexColor(preset.gradient.from),
          to: normalizeHexColor(preset.gradient.to),
        }
      : null;
    t.color_remap = Object.keys(remap).length ? remap : null;
    t.pack_style = preset.key;
  }

  function removeStyleFromTile(id) {
    const t = state.perEmoji[id];
    if (!t) return;
    clearStyleFields(t);
    cleanupDefaultTransform(id);
  }

  function refreshAfterTileStyle(id) {
    refreshStripCellState(id);
    rebuildGridCellState(id);
    if (emojiPickerBuilt) refreshEmojiPickerState(id);
    refreshStyleBrushTargets(id);
    if (id === state.currentIdx) {
      loadEditorFromState();
      updateFontUi();
      rerenderPreviewSoon();
    }
  }

  function refreshAfterPackStyleBulk() {
    if (stripBuilt) rebuildPreviewStrip();
    if (gridBuilt) rebuildGrid();
    if (gridNewBuilt) rebuildGridNew();
    if (emojiPickerBuilt && emojiPickerOpen) rebuildEmojiPicker(true);
    refreshStyleBrushTargets();
    if (state.currentIdx != null) {
      loadEditorFromState();
      updateFontUi();
    }
    rerenderPreviewSoon();
  }

  async function applyPackStyleToSelected(preset) {
    if (!preset || packStyleRunning) return;
    previewStyleKey = preset.key;
    activeStyleKey = preset.key;
    const files = allFiles().filter(f => state.selected.has(f.id) && !isPassportId(f.id));
    if (!files.length) return;
    setPackStyleBusy(true);
    setPackStyleStatus(`0 / ${files.length}`, "busy");
    let done = 0;
    let next = 0;
    try {
      await ensureFont(effectiveFontKey(preset.font), state.global.text || "Lean");
      const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
        while (next < files.length) {
          const f = files[next++];
          await applyStyleToTile(f.id, preset);
          done += 1;
          if (done % 8 === 0 || done === files.length) {
            setPackStyleStatus(`${done} / ${files.length}`, "busy");
            await sleep(0);
          }
        }
      });
      await Promise.all(workers);
      refreshAfterPackStyleBulk();
      setPackStyleStatus(`${preset.label}: ${files.length}`, "ok");
      setStatus(`Стиль "${preset.label}" применён. Кисточка на превью снимает его с текущего эмодзи.`);
    } catch (e) {
      console.error("[style] bulk apply failed:", e);
      setPackStyleStatus("Ошибка", "err");
      setStatus("Ошибка стиля: " + (e?.message || e));
    } finally {
      setPackStyleBusy(false);
      refreshStyleBrushTargets();
    }
  }

  async function togglePreviewTileStyle(id) {
    if (id == null || styleBrushRunning.has(String(id))) return;
    const preset = tileAppliedStyle(id);
    if (preset) previewStyleKey = preset.key;
    const clearable = tileHasClearableStyle(id);
    const activePreset = previewPackStyle();
    if (activePreset && !activeStyleKey) activeStyleKey = activePreset.key;
    const activePalette = previewPaletteSpec;
    if (!clearable && ((!activePreset && !activePalette) || isPassportId(id))) return;
    const sid = String(id);
    styleBrushRunning.add(sid);
    syncStyleBrushButton(previewStyleBrush, id);
    try {
      if (clearable) {
        removeStyleFromTile(id);
        const label = preset ? `Стиль "${preset.label}"` : "Покраска";
        if (!preset && previewPaletteSpec) {
          setPackPaletteStatus(`Готово: ${countPaletteEditedTiles()}`, "done");
        }
        setStatus(`${label} убран${preset ? "" : "а"} с эмодзи ${tileBadge(id)}`);
      } else {
        if (activePreset) {
          await applyStyleToTile(id, activePreset);
          setStatus(`Стиль "${activePreset.label}" применён к эмодзи ${tileBadge(id)}`);
        } else {
          const ok = await applyPackPaletteToTile(id, activePalette);
          setPackPaletteStatus(`Готово: ${countPaletteEditedTiles()}`, "done");
          setStatus(ok ? `Палитра возвращена на эмодзи ${tileBadge(id)}` : "Для этого эмодзи палитра не изменила слои");
        }
      }
      refreshAfterTileStyle(id);
    } catch (e) {
      console.error("[style] preview clear failed:", e);
      setStatus("Не получилось изменить стиль: " + (e?.message || e));
    } finally {
      styleBrushRunning.delete(sid);
      refreshStyleBrushTargets(id);
    }
  }

  async function toggleStyleForTile(id, btn) {
    const preset = activePackStyle();
    if (!preset || !styleBrushAllowed(id) || styleBrushRunning.has(String(id))) return;
    const sid = String(id);
    styleBrushRunning.add(sid);
    syncStyleBrushButton(btn, id);
    try {
      if (tileHasActiveStyle(id)) {
        removeStyleFromTile(id);
        setStatus(`Стиль "${preset.label}" убран с эмодзи ${tileBadge(id)}`);
      } else {
        await applyStyleToTile(id, preset);
        setStatus(`Стиль "${preset.label}" применён к эмодзи ${tileBadge(id)}`);
      }
      refreshAfterTileStyle(id);
    } catch (e) {
      console.error("[style] tile toggle failed:", e);
      setStatus("Ошибка стиля: " + (e?.message || e));
    } finally {
      styleBrushRunning.delete(sid);
      refreshStyleBrushTargets(id);
    }
  }

  function renderPackStylePresets() {
    if (!packStylePresets) return;
    packStylePresets.innerHTML = "";
    PACK_STYLE_PRESETS.forEach(preset => {
      const btn = document.createElement("button");
      btn.className = "pack-style-option";
      btn.type = "button";
      btn.dataset.style = preset.key;
      btn.style.setProperty("--style-a", preset.swatch[0]);
      btn.style.setProperty("--style-b", preset.swatch[1]);
      btn.style.setProperty("--style-c", preset.swatch[2]);
      btn.style.setProperty("--style-text", preset.text || "#ffffff");
      btn.innerHTML = `
        <span class="pack-style-chip" aria-hidden="true">
          <span class="pack-style-sample">Lean</span>
        </span>
        <span class="pack-style-label">${escapeHtml(preset.label)}</span>
      `;
      btn.querySelector(".pack-style-sample").style.fontFamily =
        `"${fontCssName(preset.font)}", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      btn.addEventListener("click", () => applyPackStylePreset(preset.key, btn));
      packStylePresets.appendChild(btn);
    });
    refreshPackStylePanelHeight();
  }

  async function applyPackStylePreset(key, btn) {
    if (packPaletteRunning || packStyleRunning) return;
    pulseBtn(btn);
    selectPackStyle(key);
    setPackStyleOpen(false);
    await applyPackStyleToSelected(activePackStyle());
  }

  function setTemplateStatus(text, cls = "") {
    if (!templateStatus) return;
    templateStatus.textContent = text || "";
    templateStatus.classList.toggle("ok", cls === "ok");
    templateStatus.classList.toggle("err", cls === "err");
  }

  function readSavedEditorTemplate() {
    try {
      const raw = localStorage.getItem(STYLE_TEMPLATE_KEY);
      if (!raw) return null;
      const tpl = JSON.parse(raw);
      if (!tpl || tpl.version !== 1 || typeof tpl !== "object") return null;
      return tpl;
    } catch (_) {
      return null;
    }
  }

  function updateTemplateUi() {
    if (templateApplyBtn) templateApplyBtn.disabled = !readSavedEditorTemplate();
  }

  function cleanTemplateLines(lines) {
    if (!Array.isArray(lines)) return null;
    const out = [];
    for (const raw of lines) {
      if (!raw || !raw.name) continue;
      const line = {
        name: String(raw.name || ""),
        text: "",
        scale: typeof raw.scale === "number" ? raw.scale : (+raw.scale || 1),
        color: normalizeHexColor(raw.color || "#000000"),
        offset_x: typeof raw.offset_x === "number" ? raw.offset_x : (+raw.offset_x || 0),
        offset_y: typeof raw.offset_y === "number" ? raw.offset_y : (+raw.offset_y || 0),
      };
      const changed = Math.abs(line.scale - 1) > 1e-3
        || line.color !== "#000000"
        || Math.abs(line.offset_x) > 1e-6
        || Math.abs(line.offset_y) > 1e-6;
      if (changed) out.push(line);
    }
    return out.length ? out : null;
  }

  function cleanTransformForTemplate(raw) {
    const src = cloneJson(raw, {}) || {};
    const out = {};
    out.scale = clampScale(src.scale);
    out.offset_x = +src.offset_x || 0;
    out.offset_y = +src.offset_y || 0;
    if (hasFiniteAnchorValue(src.anchor_x)) out.anchor_x = +src.anchor_x;
    if (hasFiniteAnchorValue(src.anchor_y)) out.anchor_y = +src.anchor_y;
    if (src.replace_part) out.replace_part = true;
    out.rotation = +src.rotation || 0;
    out.content_color = normalizeHexColor(src.content_color);
    const gradient = activeTextGradient(src.text_gradient);
    if (gradient) out.text_gradient = gradient;
    if (src.font) out.font = effectiveFontKey(src.font);
    if (src.pack_style && packStyleByKey(src.pack_style)) out.pack_style = String(src.pack_style);
    if (hasColorRemap(src.color_remap)) out.color_remap = cloneJson(src.color_remap, null);
    const lines = cleanTemplateLines(src.lines);
    if (lines) out.lines = lines;
    if (src.photo_svg_b64) {
      out.photo_svg_b64 = String(src.photo_svg_b64);
    } else if (src.photo_png_b64) {
      out.photo_png_b64 = String(src.photo_png_b64);
    }
    if ((src.photo_svg_b64 || src.photo_png_b64)
        && normalizeHexColor(src.photo_color || "#ffffff") !== "#ffffff") {
      out.photo_color = normalizeHexColor(src.photo_color);
    }
    if (Math.abs((src.photo_scale || 1) - 1) > 1e-3) {
      out.photo_scale = clampPhotoScale(src.photo_scale);
    }
    return out;
  }

  function saveEditorTemplate() {
    const perEmoji = {};
    Object.entries(state.perEmoji || {}).forEach(([id, transform]) => {
      if (transform && isTransformChanged(transform)) {
        perEmoji[id] = cleanTransformForTemplate(transform);
      }
    });
    const tpl = {
      version: 1,
      saved_at: Date.now(),
      format: state.format === "sticker" ? "sticker" : "emoji",
      global: {
        kind: state.global.kind === "logo" ? "logo" : "text",
        font: effectiveFontKey(state.global.font),
      },
      selected: Array.from(state.selected).map(String),
      per_emoji: perEmoji,
    };
    try {
      localStorage.setItem(STYLE_TEMPLATE_KEY, JSON.stringify(tpl));
      pulseBtn(templateSaveBtn);
      updateTemplateUi();
      setTemplateStatus("Шаблон сохранён", "ok");
      setStatus("Шаблон сохранён");
    } catch (e) {
      console.error("[template] save failed:", e);
      setTemplateStatus("Не сохранился", "err");
      setStatus("Не получилось сохранить шаблон");
    }
  }

  async function applyEditorTemplate() {
    const tpl = readSavedEditorTemplate();
    if (!tpl) {
      updateTemplateUi();
      setTemplateStatus("Шаблона нет", "err");
      return;
    }
    const keepText = state.global.text || "";
    const keepLogo = state.global.logo_svg_b64 || "";
    state.global = {
      ...state.global,
      kind: tpl.global && tpl.global.kind === "logo" ? "logo" : "text",
      text: keepText,
      logo_svg_b64: keepLogo,
      font: effectiveFontKey(tpl.global && tpl.global.font),
    };
    state.mode = state.global.kind;
    state.format = tpl.format === "sticker" ? "sticker" : "emoji";
    document.querySelectorAll(".fmt-seg .seg-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.format === state.format);
    });
    const selected = new Set();
    (tpl.selected || []).forEach(raw => {
      const id = normalizeTemplateTileId(raw);
      if (id != null) selected.add(id);
    });
    state.selected = selected.size
      ? selected
      : (state.format === "sticker" ? pickDefaultStickerSelection() : pickDefaultSelection(DEFAULT_EMOJI_SELECTION));
    const perEmoji = {};
    Object.entries(tpl.per_emoji || {}).forEach(([key, value]) => {
      const id = normalizeTemplateTileId(key);
      if (id != null) perEmoji[id] = cloneTemplateTransform(value);
    });
    state.perEmoji = perEmoji;
    state.passportRevealed = false;
    applyModeUI(state.global.kind);
    applyStickerMode();
    updateSelectionUI();
    rebuildPreviewStrip();
    const firstId = state.selected.size
      ? Array.from(state.selected)[0]
      : (allFiles()[0] && allFiles()[0].id);
    if (firstId != null) await selectId(firstId);
    else loadEditorFromState();
    pulseBtn(templateApplyBtn);
    setTemplateStatus("Шаблон применён", "ok");
    setStatus("Шаблон применён. Можно менять ник или логотип.");
  }

  renderPackStylePresets();
  setPackStyleOpen(false);
  updateTemplateUi();
  packStyleToggle?.addEventListener("click", () => {
    const isOpen = packStyleRow?.classList.contains("open");
    setPackStyleOpen(!isOpen);
  });
  window.addEventListener("resize", refreshPackStylePanelHeight);
  previewStyleBrush?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.currentIdx != null) togglePreviewTileStyle(state.currentIdx);
  });
  templateSaveBtn?.addEventListener("click", saveEditorTemplate);
  templateApplyBtn?.addEventListener("click", applyEditorTemplate);

  function currentLayerColorTarget() {
    if (layerColorContext === "pde") {
      const id = packsState && packsState.editing;
      if (id == null) return null;
      return {
        id,
        getTile: () => getPdeOverride(id),
        changed: (tile) => {
          if (tile) {
            pdeColorRemapDraft = hasColorRemap(tile.color_remap) ? tile.color_remap : null;
            packsState.overrides.set(String(id), tile);
          }
          rerenderPdeSoon();
        },
      };
    }
    if (state.currentIdx == null) return null;
    const id = state.currentIdx;
    return {
      id,
      getTile: () => getTransform(id),
      changed: () => {
        rebuildGridCellState(id);
        rerenderPreviewSoon();
      },
    };
  }

  function openLayerColorsModal(context = "main") {
    layerColorContext = context === "pde" ? "pde" : "main";
    const target = currentLayerColorTarget();
    if (!target || target.id == null) return;
    lcmBackdrop.classList.remove("hidden");
    populateLayerColors();
  }
  function closeLayerColorsModal() {
    lcmBackdrop.classList.add("hidden");
  }
  if (lcmOpenBtn)  lcmOpenBtn.addEventListener("click", () => openLayerColorsModal("main"));
  if (lcmCloseBtn) lcmCloseBtn.addEventListener("click", closeLayerColorsModal);
  if (lcmBackdrop) lcmBackdrop.addEventListener("click", (e) => {
    if (e.target === lcmBackdrop) closeLayerColorsModal();
  });

  async function populateLayerColors() {
    if (!lcmList) return;
    const target = currentLayerColorTarget();
    const id = target && target.id;
    if (id == null) return;
    lcmList.innerHTML = '<div class="lcm-empty">Загрузка…</div>';
    const colors = await getTileColors(id);
    if (!colors.length) {
      lcmList.innerHTML = '<div class="lcm-empty">В этом эмодзи нет статичных заливок для редактирования.</div>';
      return;
    }
    const t = target.getTile();
    if (!t) return;
    const remap = (t.color_remap && typeof t.color_remap === "object")
      ? t.color_remap : {};
    lcmList.innerHTML = "";
    for (const orig of colors) {
      let spec = normalizeLayerColorSpec(remap[orig], orig);
      const row = document.createElement("div");
      row.className = "lcm-row";
      const sw = document.createElement("div");
      sw.className = "lcm-swatch";
      const meta = document.createElement("div");
      meta.className = "lcm-meta";
      const hex = document.createElement("div");
      const source = document.createElement("div");
      source.className = "lcm-source";
      source.textContent = orig.toUpperCase();
      meta.appendChild(hex);
      meta.appendChild(source);

      const controls = document.createElement("div");
      controls.className = "lcm-controls";
      const solidInput = document.createElement("input");
      solidInput.type = "color";
      solidInput.className = "lcm-input";
      const gradToggle = document.createElement("button");
      gradToggle.type = "button";
      gradToggle.className = "lcm-gradient-toggle";
      gradToggle.textContent = "Градиент";
      const gradFields = document.createElement("div");
      gradFields.className = "lcm-gradient-fields";
      const gradFrom = document.createElement("input");
      gradFrom.type = "color";
      gradFrom.className = "lcm-input";
      const gradTo = document.createElement("input");
      gradTo.type = "color";
      gradTo.className = "lcm-input";
      const applyAllBtn = document.createElement("button");
      applyAllBtn.type = "button";
      applyAllBtn.className = "lcm-apply-all";
      applyAllBtn.textContent = "Всем";
      gradFields.appendChild(gradFrom);
      gradFields.appendChild(gradTo);
      controls.appendChild(solidInput);
      controls.appendChild(gradToggle);
      controls.appendChild(gradFields);
      controls.appendChild(applyAllBtn);

      function saveSpec() {
        const activeTarget = currentLayerColorTarget();
        if (!activeTarget || String(activeTarget.id) !== String(id)) return;
        const tile = activeTarget.getTile();
        if (!tile) return;
        if (!tile.color_remap || typeof tile.color_remap !== "object") {
          tile.color_remap = {};
        }
        const payload = layerColorSpecPayload(spec, orig);
        if (!payload) {
          delete tile.color_remap[orig];
        } else {
          tile.color_remap[orig] = payload;
        }
        // Drop empty maps so isTransformChanged stays accurate.
        if (Object.keys(tile.color_remap).length === 0) tile.color_remap = null;
        activeTarget.changed(tile);
      }
      function syncRow() {
        sw.style.background = layerColorSpecCss(spec);
        hex.className = "lcm-hex" + (layerColorSpecChanged(spec, orig) ? " changed" : "");
        hex.textContent = layerColorSpecLabel(spec);
        row.classList.toggle("is-gradient", spec.mode === "gradient");
        gradToggle.classList.toggle("active", spec.mode === "gradient");
        gradToggle.setAttribute("aria-pressed", spec.mode === "gradient" ? "true" : "false");
        solidInput.value = normalizeHexColor(spec.mode === "gradient" ? spec.from : spec.color);
        gradFrom.value = normalizeHexColor(spec.mode === "gradient" ? spec.from : spec.color);
        gradTo.value = normalizeHexColor(spec.mode === "gradient" ? spec.to : spec.color);
      }
      solidInput.addEventListener("input", () => {
        spec = { mode: "solid", color: normalizeHexColor(solidInput.value) };
        syncRow();
        saveSpec();
      });
      gradToggle.addEventListener("click", () => {
        if (spec.mode === "gradient") {
          spec = { mode: "solid", color: normalizeHexColor(spec.from) };
        } else {
          const base = normalizeHexColor(spec.color || orig);
          spec = { mode: "gradient", from: base, to: base };
        }
        syncRow();
        saveSpec();
      });
      gradFrom.addEventListener("input", () => {
        spec = {
          mode: "gradient",
          from: normalizeHexColor(gradFrom.value),
          to: normalizeHexColor(spec.to || gradTo.value || orig),
        };
        syncRow();
        saveSpec();
      });
      gradTo.addEventListener("input", () => {
        spec = {
          mode: "gradient",
          from: normalizeHexColor(spec.from || gradFrom.value || orig),
          to: normalizeHexColor(gradTo.value),
        };
        syncRow();
        saveSpec();
      });
      applyAllBtn.addEventListener("click", () => {
        applyLayerColorSpecToAll(orig, spec, applyAllBtn);
      });
      syncRow();
      row.appendChild(sw);
      row.appendChild(meta);
      row.appendChild(controls);
      lcmList.appendChild(row);
    }
  }

  async function applyLayerColorSpecToAll(origRaw, specRaw, btn = null) {
    if (layerColorContext !== "main") return;
    const orig = normalizeHexColor(origRaw);
    const spec = normalizeLayerColorSpec(specRaw, orig);
    const payload = layerColorSpecPayload(spec, orig);
    const files = allFiles().filter(f => !isPassportId(f.id));
    if (!files.length) return;
    if (btn) {
      btn.disabled = true;
      pulseBtn(btn);
    }
    setStatus(`0 / ${files.length}`);
    let done = 0;
    let changed = 0;
    try {
      for (const f of files) {
        const colors = await getTileColors(f.id);
        if (colors.map(normalizeHexColor).includes(orig)) {
          const t = getTransform(f.id);
          if (!t.color_remap || typeof t.color_remap !== "object") {
            t.color_remap = {};
          }
          if (payload) {
            t.color_remap[orig] = cloneJson(payload, payload);
          } else {
            delete t.color_remap[orig];
          }
          if (Object.keys(t.color_remap).length === 0) t.color_remap = null;
          cleanupDefaultTransform(f.id);
          changed += 1;
        }
        done += 1;
        if (done % 10 === 0 || done === files.length) {
          setStatus(`${done} / ${files.length}`);
          await sleep(0);
        }
      }
      if (stripBuilt) rebuildPreviewStrip();
      if (gridBuilt) rebuildGrid();
      if (gridNewBuilt) rebuildGridNew();
      if (emojiPickerBuilt && emojiPickerOpen) rebuildEmojiPicker(true);
      rerenderPreviewSoon();
      setStatus(payload ? `Градиент применён к ${changed} эмодзи` : `Цвет сброшен у ${changed} эмодзи`);
      requestAnimationFrame(() => {
        runWave(grid.querySelectorAll(".cell"));
        runWave(gridNew.querySelectorAll(".cell"));
      });
    } catch (e) {
      console.error("[lcm] apply to all failed:", e);
      setStatus("Не получилось применить цвет ко всем: " + (e?.message || e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  if (lcmResetBtn) lcmResetBtn.addEventListener("click", () => {
    const target = currentLayerColorTarget();
    if (!target || target.id == null) return;
    const t = target.getTile();
    if (!t) return;
    t.color_remap = null;
    target.changed(t);
    populateLayerColors();
  });

  function isRasterImageFile(file) {
    return /\.(png|jpe?g|webp)$/i.test(file?.name || "")
      || /image\/(png|jpeg|webp)/i.test(file?.type || "");
  }

  async function rasterFileToPngBase64(file, maxSide = 512) {
    if (!file || file.size > 8 * 1024 * 1024) {
      throw new Error("Изображение > 8MB — слишком большое");
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Не удалось прочитать изображение"));
        img.src = url;
      });
      const ratio = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * ratio));
      const height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      const b64 = canvas.toDataURL("image/png").split(",")[1] || "";
      if (!b64 || b64.length > 2_800_000) {
        throw new Error("Изображение не удалось подготовить для TGS");
      }
      return b64;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // SVG stays vector. PNG/JPEG/WebP is normalized to PNG and embedded as a
  // real Lottie image asset, preserving the native TGS canvas and framerate.
  $("logo-input").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const isRaster = isRasterImageFile(f);
    const isSvg = /\.svg$/i.test(f.name) || f.type === "image/svg+xml";
    const hint = $("logo-png-hint");
    const rejectLogoFile = (message) => {
      if (state.textScope === "tile" && state.currentIdx != null) {
        const t = getTransform(state.currentIdx);
        t.kind = "text";
        t.text = String(t.text || "").trim() || DEFAULT_BRAND_TEXT;
        t.logo_svg_b64 = "";
        t.logo_png_b64 = "";
        applyModeUI("text", { writeGlobal: false });
        rebuildGridCellState(state.currentIdx);
      } else {
        state.global.kind = "text";
        state.global.text = String(state.global.text || "").trim() || DEFAULT_BRAND_TEXT;
        state.global.logo_svg_b64 = "";
        state.global.logo_png_b64 = "";
        applyModeUI("text");
      }
      if (hint) hint.classList.add("hidden");
      e.target.value = "";
      syncTextScopeUi();
      $("logo-label").textContent = message;
      setStatus(message);
      rerenderPreviewSoon();
    };
    if (!isRaster && !isSvg) {
      rejectLogoFile("Поддерживаются PNG, JPG, WEBP и SVG");
      return;
    }
    if (isRaster) {
      let b64;
      try { b64 = await rasterFileToPngBase64(f); }
      catch (err) { rejectLogoFile(err?.message || "Не удалось прочитать изображение"); return; }
      if (state.textScope === "tile" && state.currentIdx != null) {
        const t = getTransform(state.currentIdx);
        t.kind = "logo";
        t.logo_png_b64 = b64;
        t.logo_svg_b64 = "";
        t.text = "";
        applyModeUI("logo", { writeGlobal: false });
        rebuildGridCellState(state.currentIdx);
      } else {
        state.global.logo_png_b64 = b64;
        state.global.logo_svg_b64 = "";
        applyModeUI("logo");
      }
      if (hint) hint.classList.remove("hidden");
    } else {
      if (f.size > 256 * 1024) {
        rejectLogoFile("SVG > 256KB — слишком большой"); return;
      }
      const txt = await f.text();
      if (!/<svg/i.test(txt)) {
        rejectLogoFile("Не похоже на SVG"); return;
      }
      const b64 = btoa(unescape(encodeURIComponent(txt)));
      if (state.textScope === "tile" && state.currentIdx != null) {
        const t = getTransform(state.currentIdx);
        t.kind = "logo";
        t.logo_svg_b64 = b64;
        t.logo_png_b64 = "";
        t.text = "";
        applyModeUI("logo", { writeGlobal: false });
        rebuildGridCellState(state.currentIdx);
      } else {
        state.global.logo_svg_b64 = b64;
        state.global.logo_png_b64 = "";
        applyModeUI("logo");
      }
      if (hint) hint.classList.add("hidden");
    }
    $("logo-label").textContent = f.name + " ✓";
    syncTextScopeUi();
    setStatus("");
    rerenderPreviewSoon();
  });

  const contentRotationSlider = $("g-content-rotation");
  const contentRotationVal = $("g-content-rotation-val");
  if (!contentRotationSlider) {
    console.error("[editor] g-content-rotation not found");
  } else {
    const onRot = () => {
      const v = parseFloat(contentRotationSlider.value) || 0;
      const t = getTransform(state.currentIdx);
      t.rotation = v;
      contentRotationVal.textContent = v + "°";
      rebuildGridCellState(state.currentIdx);
      rerenderPreviewSoon();
    };
    contentRotationSlider.addEventListener("input", onRot);
    contentRotationSlider.addEventListener("change", onRot);
  }

  // ── Sliders (per-emoji transform) ──────────
  function bindSlider(id, valId, key, fmt) {
    const sl = $(id), val = $(valId);
    const handler = () => {
      const t  = getTransform(state.currentIdx);
      const v  = parseFloat(sl.value);
      if (key === "scale") t.scale = clampScale(v / 100);
      else t[key] = v;
      val.textContent = fmt(v);
      rebuildGridCellState(state.currentIdx);
      rerenderPreviewSoon();
    };
    sl.addEventListener("input", handler);
    sl.addEventListener("change", handler);
  }
  bindSlider("s-scale",     "v-scale",     "scale",    v => v + "%");
  bindSlider("s-offset-x",  "v-offset-x",  "offset_x", v => v + "");
  bindSlider("s-offset-y",  "v-offset-y",  "offset_y", v => v + "");

  // ── Format ─────────────────────────────────
  document.querySelectorAll(".fmt-seg .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const newFormat = btn.dataset.format === "sticker" ? "sticker" : "emoji";
      state.format = newFormat;
      document.querySelectorAll(".fmt-seg .seg-btn").forEach(b =>
        b.classList.toggle("active", b === btn));
      applyStickerMode();
    });
  });

  // ── Sticker-mode selection ─────────────────
  function isPassportId(id) {
    if (!state.pricing.passport_ids || !state.pricing.passport_ids.length) return false;
    const s = String(id);
    return state.pricing.passport_ids.some(pid => String(pid) === s);
  }

  function pickDefaultStickerSelection() {
    /** Sticker mode default selection: visible catalog order,
     *  capped at STICKER_LIMIT. Passport NOT auto-included — user opts in. */
    const out = new Set();
    const masters = state.masterFiles, news = state.newFiles, uploads = state.uploadFiles || [];
    for (const f of masters) {
      if (out.size >= STICKER_LIMIT) break;
      if (isPassportId(f.id)) continue;
      out.add(f.id);
    }
    for (const f of news) {
      if (out.size >= STICKER_LIMIT) break;
      if (isPassportId(f.id)) continue;
      out.add(f.id);
    }
    for (const f of uploads) {
      if (out.size >= STICKER_LIMIT) break;
      out.add(f.id);
    }
    return out;
  }

  function pickDefaultSelection(maxN) {
    /** Default emoji-mode selection: every non-passport tile, capped at
     *  `maxN` (Telegram limit). Without the cap the user landed on 243/200
     *  in red and had to manually deselect 43 tiles before they could build
     *  — now we pre-select exactly the cap and they can swap in/out from
     *  there. Passport is opt-in (extra 25₽), never auto-included. */
    const cap = (typeof maxN === "number" && maxN > 0)
      ? maxN : Infinity;
    const out = new Set();
    for (const f of state.masterFiles) {
      if (out.size >= cap) return out;
      if (!isPassportId(f.id)) out.add(f.id);
    }
    // Default follows visible catalog order: master first,
    // then the added emoji, up to Telegram's emoji-pack cap.
    for (const f of state.newFiles) {
      if (out.size >= cap) return out;
      if (!isPassportId(f.id)) out.add(f.id);
    }
    for (const f of (state.uploadFiles || [])) {
      if (out.size >= cap) return out;
      out.add(f.id);
    }
    return out;
  }

  function keepCurrentSelected(limit) {
    const id = state.currentIdx;
    if (id == null || isPassportId(id) || !fileById(id) || state.selected.has(id)) return;
    const cap = (typeof limit === "number" && limit > 0) ? limit : currentLimit();
    while (state.selected.size >= cap) {
      const removable = Array.from(state.selected).reverse()
        .find(x => String(x) !== String(id) && !isPassportId(x));
      if (removable == null) break;
      state.selected.delete(removable);
    }
    if (state.selected.size < cap) state.selected.add(id);
  }

  function trimSelectionToLimit(limit, preferredId = state.currentIdx) {
    const cap = (typeof limit === "number" && limit >= 0) ? limit : currentLimit();
    while (state.selected.size > cap) {
      const ids = Array.from(state.selected);
      const removable = ids.reverse().find(x => String(x) !== String(preferredId)) ?? ids[0];
      if (removable == null) break;
      state.selected.delete(removable);
    }
  }

  function computePriceRub() {
    // Цена пака в Telegram Stars: 1 стикер/эмодзи = 1 ⭐ (сервер — источник правды).
    const per = +(state.pricing && state.pricing.star_per_sticker) || 1;
    return new Set(state.selected).size * per;
  }

  function applyStickerMode() {
    const on = state.format === "sticker";
    document.body.classList.toggle("sticker-mode", on);
    // Selection bar is now always visible (count + price). Sticker-mode
    // class still controls the per-cell click behaviour and the limit cap.
    selectBar.classList.remove("hidden");
    if (on) {
      trimSelectionToLimit(STICKER_LIMIT);
      // Editor preview should only walk through selected stickers.
      const list = editorFiles();
      if (list.length && !list.some(f => f.id === state.currentIdx)) {
        state.currentIdx = list[0].id;
        renderPreview(state.currentIdx);
      }
    } else {
      trimSelectionToLimit(EMOJI_LIMIT);
    }
    updateSelectionUI();
    rebuildGridSelectionState();
  }
  selectCountMax.textContent = EMOJI_LIMIT;

  function updateSelectionUI() {
    const n = state.selected.size;
    const cap = currentLimit();
    selectCountNum.textContent = n;
    const over = n > cap;
    selectCountNum.classList.toggle("over", over);
    selectBar.classList.toggle("limit", over);
    // Show "N/cap" in both modes — the cap is just larger in emoji mode (200).
    const sep = selectBar.querySelector(".select-count-sep");
    const maxN = document.getElementById("select-count-max");
    if (sep) sep.classList.remove("hidden");
    if (maxN) {
      maxN.classList.remove("hidden");
      maxN.textContent = cap;
    }
    const rub = computePriceRub();
    const priceEl = document.getElementById("pack-price");
    if (priceEl) priceEl.textContent = rub > 0 ? rub + " ⭐" : "—";
    const genBtn = document.getElementById("generate");
    if (genBtn) {
      genBtn.textContent = rub > 0 ? `Создать пак · ${rub} ⭐` : "Создать пак";
      genBtn.disabled = buildInFlight || over || n === 0;
    }
    // Passport toggle card state
    const passportToggle = document.getElementById("passport-toggle");
    const hasPassport = state.pricing.passport_ids && state.pricing.passport_ids.length &&
      state.pricing.passport_ids.some(pid => state.selected.has(pid));
    if (passportToggle) {
      passportToggle.classList.toggle("on", !!hasPassport);
    }
    // «×» в углу плашки — видна только когда паспорт уже в паке.
    const passportRemove = document.getElementById("passport-remove");
    if (passportRemove) passportRemove.classList.toggle("hidden", !hasPassport);
    // Solo-passport reveal state: сбрасываем, как только пользователь
    // выходит из этого состояния (добавил другой тайл, снял паспорт).
    if (!isOnlyPassportSelected()) {
      state.passportRevealed = false;
    }
    // Per-tile include toggle (sticker mode) — sync visibility + state.
    refreshPreviewToggle();
    // Sync strip cell .selected classes (sticker-mode dims non-selected).
    refreshStripSelectionState();
    refreshEmojiPickerState();
    refreshStyleBrushTargets();
    // Refresh the live passport thumbnail (cheap, debounced internally).
    refreshPassportThumb();
    // Solo-passport может потребовать перерисовку секции паспорта
    // (показать/скрыть редактор), синхронно с изменением выбора.
    if (state.currentIdx != null) renderPassportLinesUI();
  }

  // ── Per-tile include toggle (visible in both formats) ───────
  function refreshPreviewToggle() {
    const pin = document.getElementById("preview-pin");
    const id = state.currentIdx;
    const inSet = id != null && state.selected.has(id);
    if (pin) {
      pin.classList.remove("hidden");
      pin.classList.toggle("on", inSet);
    }
  }

  function toggleCurrentTile() {
    const id = state.currentIdx;
    if (id == null) return;
    const prevId = state.currentIdx;
    const ok = toggleSelected(id);
    // Prevent sticker-mode auto-jump to next selected item.
    if (state.currentIdx !== prevId) {
      state.currentIdx = prevId;
      renderPreview(state.currentIdx);
    }
    refreshPreviewToggle();
    // Visual feedback.
    const pin = document.getElementById("preview-pin");
    if (pin) { pin.classList.remove("bump"); void pin.offsetWidth; pin.classList.add("bump"); }
    if (!ok) {
      // Sticker cap hit — flash the count.
      selectCountNum.classList.remove("over");
      void selectCountNum.offsetWidth;
      selectCountNum.classList.add("over");
      setTimeout(() => selectCountNum.classList.remove("over"), 350);
    }
  }

  document.getElementById("preview-pin")?.addEventListener("click", toggleCurrentTile);

  // ── Live passport thumbnail in the selection bar ─────────
  // Renders a mini Lottie of the actual passport tile (with the user's
  // current per-line edits + photo SVG applied) inside #passport-thumb.
  // The Lottie player keeps playing the looping animation at low cost.
  let _ppThumbAnim = null;
  let _ppThumbId = null;
  let _ppThumbToken = 0;
  let _ppThumbTimer = null;
  function refreshPassportThumb() {
    if (_ppThumbTimer) clearTimeout(_ppThumbTimer);
    _ppThumbTimer = setTimeout(_renderPassportThumb, 90);
  }
  async function _renderPassportThumb() {
    const host = document.getElementById("passport-thumb");
    if (!host) return;
    const ids = (state.pricing && state.pricing.passport_ids) || [];
    if (!ids.length) {
      host.classList.add("empty");
      return;
    }
    const pid = ids[0];
    const myToken = ++_ppThumbToken;
    try {
      const original = await loadLottie(pid);
      if (myToken !== _ppThumbToken) return;
      let data;
      try {
        // Use the same override the editor uses so user edits show through.
        const eff = effectiveOverride(pid);
        await ensureFont(eff.font, fontTextForOverride(eff));
        data = SwexReplacer.applyToLottie(original, eff);
      } catch (_) {
        data = original;
      }
      // (Re)create the Lottie player. Loop the animation softly.
      if (_ppThumbAnim) { try { _ppThumbAnim.destroy(); } catch (_) {} _ppThumbAnim = null; }
      host.innerHTML = "";
      host.classList.remove("empty");
      _ppThumbAnim = lottie.loadAnimation({
        container: host,
        renderer: "svg",
        loop: true,
        autoplay: true,
        animationData: data,
        rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
      });
      _ppThumbId = pid;
    } catch (e) {
      host.classList.add("empty");
    }
  }
  function bumpCount() {
    selectCountNum.classList.remove("bump");
    // restart animation
    void selectCountNum.offsetWidth;
    selectCountNum.classList.add("bump");
    setTimeout(() => selectCountNum.classList.remove("bump"), 260);
  }
  function rebuildGridSelectionState() {
    const cap = currentLimit();
    document.querySelectorAll(".grid .cell, .grid-new .cell").forEach(c => {
      const id = parseCellId(c.dataset.id);
      const isSel = state.selected.has(id);
      c.classList.toggle("selected", isSel);
      const overCap = !isSel && state.selected.size >= cap;
      c.classList.toggle("disabled", overCap);
      c.querySelectorAll(".style-brush-btn").forEach(btn => syncStyleBrushButton(btn, id));
    });
  }
  function parseCellId(raw) {
    if (raw && (raw.startsWith("new:") || raw.startsWith("upload:"))) return raw;
    return +raw;
  }
  function toggleSelected(id) {
    if (state.selected.has(id)) {
      state.selected.delete(id);
    } else {
      // Enforce TG hard caps: 120 for sticker sets, 200 for custom-emoji.
      if (state.selected.size >= currentLimit()) return false;
      state.selected.add(id);
    }
    bumpCount();
    updateSelectionUI();
    rebuildGridSelectionState();
    // In sticker mode, keep the editor preview inside the selection.
    if (state.format === "sticker") {
      const list = editorFiles();
      if (list.length && !list.some(f => f.id === state.currentIdx)) {
        state.currentIdx = list[0].id;
        renderPreview(state.currentIdx);
      }
    }
    return true;
  }

  $("select-all").addEventListener("click", () => {
    runWave(grid.querySelectorAll(".cell"));
    runWave(gridNew.querySelectorAll(".cell"));
    state.selected = state.format === "sticker"
      ? pickDefaultStickerSelection()
      : pickDefaultSelection(EMOJI_LIMIT);
    keepCurrentSelected(state.format === "sticker" ? STICKER_LIMIT : EMOJI_LIMIT);
    bumpCount();
    updateSelectionUI();
    rebuildGridSelectionState();
  });
  function pickRandomSelection(n) {
    /** n случайных не-паспортных тайлов из всего доступного каталога,
     *  ограничено текущим лимитом формата и тем, сколько вообще есть. */
    const cap = currentLimit();
    const pool = [];
    for (const f of state.masterFiles) if (!isPassportId(f.id)) pool.push(f.id);
    for (const f of state.newFiles) if (!isPassportId(f.id)) pool.push(f.id);
    for (const f of (state.uploadFiles || [])) pool.push(f.id);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const count = Math.max(0, Math.min(n, cap, pool.length));
    return new Set(pool.slice(0, count));
  }
  function openRandomCountModal() {
    const m = $("random-count-modal");
    const i = $("random-count-input");
    const range = $("random-count-range");
    const ok = $("random-count-ok");
    const cancel = $("random-count-cancel");
    const cap = currentLimit();
    const poolSize = Math.min(
      cap,
      state.masterFiles.filter(f => !isPassportId(f.id)).length
        + state.newFiles.filter(f => !isPassportId(f.id)).length
        + (state.uploadFiles || []).length,
    );
    const maxN = Math.max(1, poolSize);
    i.max = String(maxN);
    i.value = String(Math.min(50, maxN));
    range.textContent = `от 1 до ${maxN}`;
    function close() {
      m.classList.add("hidden");
      m.classList.remove("show");
      cleanup();
    }
    function confirmPick() {
      const n = Math.max(1, Math.min(parseInt(i.value, 10) || 0, maxN));
      close();
      runWave(grid.querySelectorAll(".cell"));
      runWave(gridNew.querySelectorAll(".cell"));
      state.selected = pickRandomSelection(n);
      bumpCount();
      updateSelectionUI();
      rebuildGridSelectionState();
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter") { e.preventDefault(); confirmPick(); }
    }
    function onBackdrop(e) {
      if (e.target.classList.contains("name-modal-backdrop")) close();
    }
    function cleanup() {
      ok.removeEventListener("click", confirmPick);
      cancel.removeEventListener("click", close);
      m.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    }
    ok.addEventListener("click", confirmPick);
    cancel.addEventListener("click", close);
    m.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    m.classList.remove("hidden");
    requestAnimationFrame(() => {
      m.classList.add("show");
      i.focus();
      i.select();
    });
  }
  $("select-random").addEventListener("click", openRandomCountModal);
  $("select-none").addEventListener("click", () => {
    runWave(grid.querySelectorAll(".cell.selected"));
    runWave(gridNew.querySelectorAll(".cell.selected"));
    state.selected.clear();
    bumpCount();
    updateSelectionUI();
    rebuildGridSelectionState();
  });

  // Passport pill — теперь это «кнопка перехода» в редактор паспорта.
  // Один тап → паспорт автоматически попадает в пак (если ещё не там) +
  // превью переключается на него + раскрывается секция строк/фото. То
  // есть юзеру не надо искать паспорт-эмодзи в листании ◁ ▷ среди 180.
  // Удалить из пака — через маленькую «×» в правом-верхнем углу плашки.
  function jumpToPassport() {
    const ids = state.pricing.passport_ids || [];
    if (!ids.length) return;
    const pid = ids[0];
    if (!state.selected.has(pid)) {
      state.selected.add(pid);
      bumpCount();
    }
    state.passportRevealed = true;
    selectId(pid);  // обновит preview + renderPassportLinesUI() → редактор паспорта
    updateSelectionUI();
    rebuildGridSelectionState();
    // Дать рендеру кадр на отрисовку и доскроллить до редактора паспорта.
    requestAnimationFrame(() => {
      const sec = document.getElementById("passport-lines");
      if (sec && !sec.classList.contains("hidden")) {
        sec.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  const passportToggle = $("passport-toggle");
  if (passportToggle) {
    passportToggle.addEventListener("click", jumpToPassport);
    passportToggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        jumpToPassport();
      }
    });
  }
  const passportRemove = $("passport-remove");
  if (passportRemove) {
    passportRemove.addEventListener("click", (e) => {
      e.stopPropagation();
      const ids = state.pricing.passport_ids || [];
      if (!ids.length) return;
      const pid = ids[0];
      if (!state.selected.has(pid)) return;
      state.selected.delete(pid);
      bumpCount();
      updateSelectionUI();
      rebuildGridSelectionState();
      if (state.format === "sticker") {
        const list = editorFiles();
        if (list.length && !list.some(f => f.id === state.currentIdx)) {
          state.currentIdx = list[0].id;
          renderPreview(state.currentIdx);
        }
      }
    });
  }

  // ── Wave / pulse animation helpers ─────────
  function runWave(nodes) {
    // cascade highlight across cells, ~18ms per cell with 250ms tail
    const list = Array.from(nodes);
    list.forEach((c, i) => {
      setTimeout(() => {
        c.classList.remove("wave-hit");
        void c.offsetWidth;
        c.classList.add("wave-hit");
        setTimeout(() => c.classList.remove("wave-hit"), 460);
      }, i * 18);
    });
  }
  function pulseBtn(btn) {
    btn.classList.remove("pulsing");
    void btn.offsetWidth;
    btn.classList.add("pulsing");
    setTimeout(() => btn.classList.remove("pulsing"), 360);
  }
  function setupTapFeedback() {
    const selector = [
      "button",
      ".font-toggle",
      ".file-btn",
      ".pp-btn-sm",
    ].join(",");
    document.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      const el = e.target.closest(selector);
      if (!el || el.disabled || el.classList.contains("hidden")) return;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;
      el.classList.add("tap-feedback");
      if (window.getComputedStyle(el).position === "static") {
        el.classList.add("tap-positioned");
      }
      el.classList.remove("tap-release");
      el.style.setProperty("--tap-x", `${Math.max(0, Math.min(box.width, e.clientX - box.left))}px`);
      el.style.setProperty("--tap-y", `${Math.max(0, Math.min(box.height, e.clientY - box.top))}px`);
      el.classList.add("tap-press");

      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        el.classList.remove("tap-press");
        el.classList.add("tap-release");
        window.setTimeout(() => el.classList.remove("tap-release"), 340);
      };
      document.addEventListener("pointerup", release, { once: true });
      document.addEventListener("pointercancel", release, { once: true });
      document.addEventListener("scroll", release, { once: true, passive: true });
    }, { passive: true });
  }
  setupTapFeedback();

  // ── Nav ────────────────────────────────────
  $("prev").addEventListener("click", () => navTo(-1));
  $("next").addEventListener("click", () => navTo(+1));

  function isOnlyPassportSelected() {
    if (state.selected.size !== 1) return false;
    const ids = state.pricing && state.pricing.passport_ids;
    if (!Array.isArray(ids) || !ids.length) return false;
    const only = String([...state.selected][0]);
    return ids.includes(only);
  }

  function navTo(delta) {
    const list = editorFiles();
    const n = list.length; if (!n) return;
    const cur = list.findIndex(f => f.id === state.currentIdx);
    const idx = (cur + delta + n) % n;
    selectId(list[idx].id);
  }

  // ── Apply-all / reset ──────────────────────
  function applyToAllCells(mutator, opts = {}) {
    const includePassport = !!opts.includePassport;
    allFiles().forEach(f => {
      if (!includePassport && isPassportId(f.id)) return;
      mutator(getTransform(f.id), f);
    });
    setStatus("");
    rebuildGrid();
    rebuildGridNew();
    rerenderPreviewSoon();
  }
  function applyAllWithAnimation(btnId, mutator) {
    const btn = $(btnId);
    pulseBtn(btn);
    applyToAllCells(mutator);
    // Wave through both grids — visible feedback that the change reached
    // every cell, not only the current one. Use a single rAF so the DOM
    // state from rebuild is already painted before the wave starts.
    requestAnimationFrame(() => {
      runWave(grid.querySelectorAll(".cell"));
      runWave(gridNew.querySelectorAll(".cell"));
    });
  }

  $("apply-all").addEventListener("click", () => {
    const src = state.perEmoji[state.currentIdx] || defaultTransform();
    const color = normalizeHexColor(src.content_color);
    const gradient = normalizeTextGradient(src.text_gradient);
    const font = effectiveFontKey(src.font);
    applyAllWithAnimation("apply-all", (t) => {
      t.scale = clampScale(src.scale);
      t.offset_x = src.offset_x;
      t.offset_y = src.offset_y;
      t.content_color = color;
      t.text_gradient = gradient.enabled ? { ...gradient } : null;
      t.font = font;
    });
  });
  $("apply-color-all").addEventListener("click", () => {
    const src = state.perEmoji[state.currentIdx] || defaultTransform();
    const color = normalizeHexColor(src.content_color);
    const gradient = normalizeTextGradient(src.text_gradient);
    applyAllWithAnimation("apply-color-all", (t) => {
      t.content_color = color;
      t.text_gradient = gradient.enabled ? { ...gradient } : null;
    });
  });
  $("apply-rotation-all").addEventListener("click", () => {
    const src = state.perEmoji[state.currentIdx] || defaultTransform();
    const rotation = +src.rotation || 0;
    applyAllWithAnimation("apply-rotation-all", (t) => {
      t.rotation = rotation;
    });
  });
  $("reset-one").addEventListener("click", () => {
    delete state.perEmoji[state.currentIdx];
    loadEditorFromState();
    rebuildGrid();
    setStatus("");
    rerenderPreviewSoon();
  });

  // ── Editor ↔ state ─────────────────────────
  function loadEditorFromState() {
    // Глобальные поля
    if (tileHasOwnContent(state.currentIdx)) state.textScope = "tile";
    applyModeUI(currentContentKind(), { writeGlobal: false });
    syncTextScopeUi();
    updateFontUi();
    const t = state.perEmoji[state.currentIdx] || defaultTransform();
    if (contentColorInput) contentColorInput.value = normalizeHexColor(t.content_color);
    if (contentColorVal) contentColorVal.textContent = normalizeHexColor(t.content_color).toUpperCase();
    syncGradientUi(t);
    if (contentRotationSlider) contentRotationSlider.value = Math.round(t.rotation || 0);
    if (contentRotationVal) contentRotationVal.textContent = Math.round(t.rotation || 0) + "°";
    // Per-emoji трансформ
    t.scale = clampScale(t.scale);
    $("s-scale").value    = Math.round(t.scale * 100);
    $("v-scale").textContent = Math.round(t.scale * 100) + "%";
    $("s-offset-x").value = t.offset_x;
    $("v-offset-x").textContent = String(t.offset_x);
    $("s-offset-y").value = t.offset_y;
    $("v-offset-y").textContent = String(t.offset_y);
    renderPassportLinesUI();
    if (!currentIsUploadTile()) state.placementMode = false;
    updateUploadPlacementUi();
  }

  function defaultLine(name) {
    return { name, text: "", scale: 1.0, color: "#000000", offset_x: 0, offset_y: 0 };
  }
  function isLineModified(l) {
    if (!l) return false;
    return (l.text && l.text.trim() !== "")
        || Math.abs((l.scale || 1) - 1) > 1e-3
        || (l.color && l.color.toLowerCase() !== "#000000")
        || Math.abs(l.offset_x || 0) > 1e-6
        || Math.abs(l.offset_y || 0) > 1e-6;
  }

  function renderPassportLinesUI() {
    const wrap = $("passport-lines");
    const rows = $("passport-lines-rows");
    if (!wrap || !rows) return;
    const f = fileById(state.currentIdx);
    let tplLines = f && Array.isArray(f.passport_lines) ? f.passport_lines : null;
    if (!tplLines || !tplLines.length) {
      wrap.classList.add("hidden");
      rows.innerHTML = "";
      document.body.classList.remove("passport-mode");
      return;
    }
    document.body.classList.add("passport-mode");
    wrap.classList.remove("hidden");
    // Server sends: [__header__, secondary_a, secondary_b, secondary_c].
    // Swap the first two secondary rows (indices 1 and 2) so the @-handle
    // slot reads first under the header — natural passport order.
    if (tplLines.length >= 3) {
      tplLines = [tplLines[0], tplLines[2], tplLines[1], ...tplLines.slice(3)];
    }
    const t = getTransform(state.currentIdx);
    // Passport has its own per-line controls. Normal per-emoji text/logo
    // settings can arrive here from "apply to all"; scrub them so they do
    // not repaint or move the photo/header slots.
    t.scale = 1.0;
    t.offset_x = 0;
    t.offset_y = 0;
    t.rotation = 0;
    t.content_color = "#ffffff";
    t.text_gradient = null;
    // Migrate using NAME-based lookup so user-typed text stays attached to
    // its swex_text_* slot even if we shuffle UI rows around.
    const prev = Array.isArray(t.lines) ? t.lines.slice() : [];
    t.lines = tplLines.map(tpl => {
      const existing = prev.find(l => l && l.name === tpl.name);
      if (existing) {
        return {
          name:     tpl.name,
          text:     typeof existing.text === "string" ? existing.text : "",
          scale:    typeof existing.scale === "number" ? existing.scale : 1.0,
          color:    typeof existing.color === "string" ? existing.color : "#000000",
          offset_x: typeof existing.offset_x === "number" ? existing.offset_x : 0,
          offset_y: typeof existing.offset_y === "number" ? existing.offset_y : 0,
        };
      }
      return defaultLine(tpl.name);
    });
    rows.innerHTML = "";
    // Show every row, including the synthetic __header__ row. That top row
    // controls the name printed above the passport handle lines.
    tplLines.forEach((tpl, i) => {
      const row = document.createElement("div");
      row.className = "pp-row";
      const line = t.lines[i];
      const cur = line.text || "";
      if (isLineModified(line)) row.classList.add("modified");
      if (cur) row.classList.add("has-value");
      const label = (i + 1).toString();
      const placeholder = tpl.text;
      row.innerHTML = `
        <div class="pp-row-line1">
          <span class="num">${label}</span>
          <input class="line-text" type="text" maxlength="30"
                 placeholder="${escapeHtml(placeholder)}"
                 value="${escapeHtml(cur)}"
                 autocomplete="off" autocorrect="off" spellcheck="false">
          <span class="ctr">${cur.length}/30</span>
          <button class="clear" type="button" title="Очистить">✕</button>
        </div>
        <div class="pp-row-line2">
          <div class="line-size">
            <span class="line-size-label">Размер</span>
            <div class="line-size-row">
              <input class="line-scale" type="range" min="50" max="200" step="5"
                     value="${Math.round((line.scale || 1) * 100)}">
              <span class="line-scale-val">${Math.round((line.scale || 1) * 100)}%</span>
            </div>
          </div>
          <input class="line-color" type="color" value="${escapeHtml(line.color || "#000000")}">
        </div>
        <div class="pp-row-line3">
          <div class="line-axis">
            <span class="line-axis-label">X</span>
            <input class="line-offset-x" type="range" min="-250" max="250" step="1"
                   value="${Math.round(line.offset_x || 0)}">
            <span class="line-axis-val line-offset-x-val">${Math.round(line.offset_x || 0)}</span>
          </div>
          <div class="line-axis">
            <span class="line-axis-label">Y</span>
            <input class="line-offset-y" type="range" min="-100" max="100" step="1"
                   value="${Math.round(line.offset_y || 0)}">
            <span class="line-axis-val line-offset-y-val">${Math.round(line.offset_y || 0)}</span>
          </div>
        </div>
      `;
      const textInputEl = row.querySelector(".line-text");
      const ctr = row.querySelector(".ctr");
      const clearBtn = row.querySelector(".clear");
      const scaleEl = row.querySelector(".line-scale");
      const scaleVal = row.querySelector(".line-scale-val");
      const colorEl = row.querySelector(".line-color");
      const offXEl = row.querySelector(".line-offset-x");
      const offXVal = row.querySelector(".line-offset-x-val");
      const offYEl = row.querySelector(".line-offset-y");
      const offYVal = row.querySelector(".line-offset-y-val");

      function updateModifiedClass() {
        row.classList.toggle("modified", isLineModified(line));
        row.classList.toggle("has-value", (line.text || "").length > 0);
      }
      function syncText() {
        const v = textInputEl.value.slice(0, 30);
        line.text = v;
        ctr.textContent = `${v.length}/30`;
        ctr.classList.toggle("warn", v.length >= 24 && v.length < 30);
        ctr.classList.toggle("full", v.length >= 30);
        updateModifiedClass();
        rebuildGridCellState(state.currentIdx);
        rerenderPreviewSoon();
      }
      function syncScale() {
        line.scale = (parseFloat(scaleEl.value) || 100) / 100;
        scaleVal.textContent = Math.round(line.scale * 100) + "%";
        updateModifiedClass();
        rebuildGridCellState(state.currentIdx);
        rerenderPreviewSoon();
      }
      function syncColor() {
        line.color = colorEl.value;
        updateModifiedClass();
        rebuildGridCellState(state.currentIdx);
        rerenderPreviewSoon();
      }
      textInputEl.addEventListener("input", syncText);
      clearBtn.addEventListener("click", () => {
        textInputEl.value = "";
        syncText();
        textInputEl.focus();
      });
      scaleEl.addEventListener("input", syncScale);
      scaleEl.addEventListener("change", syncScale);
      colorEl.addEventListener("input", syncColor);
      colorEl.addEventListener("change", syncColor);

      function syncOffsetX() {
        line.offset_x = parseFloat(offXEl.value) || 0;
        offXVal.textContent = String(Math.round(line.offset_x));
        updateModifiedClass();
        rebuildGridCellState(state.currentIdx);
        rerenderPreviewSoon();
      }
      function syncOffsetY() {
        line.offset_y = parseFloat(offYEl.value) || 0;
        offYVal.textContent = String(Math.round(line.offset_y));
        updateModifiedClass();
        rebuildGridCellState(state.currentIdx);
        rerenderPreviewSoon();
      }
      offXEl.addEventListener("input", syncOffsetX);
      offXEl.addEventListener("change", syncOffsetX);
      offYEl.addEventListener("input", syncOffsetY);
      offYEl.addEventListener("change", syncOffsetY);

      ctr.classList.toggle("warn", cur.length >= 24 && cur.length < 30);
      ctr.classList.toggle("full", cur.length >= 30);
      rows.appendChild(row);
    });
    renderPassportPhotoUI();
  }

  function renderPassportPhotoUI() {
    const preview = $("passport-photo-preview");
    const label = $("passport-photo-label");
    const clearBtn = $("passport-photo-clear");
    if (!preview) return;
    const t = getTransform(state.currentIdx);
    const hasSvg = !!t.photo_svg_b64;
    const hasPng = !!t.photo_png_b64;
    const photoColor = normalizeHexColor(t.photo_color || "#ffffff");
    if (hasPng) {
      preview.innerHTML = "";
      const img = document.createElement("img");
      img.src = "data:image/png;base64," + t.photo_png_b64;
      preview.appendChild(img);
      if (label) label.textContent = "Заменить фото";
      if (clearBtn) clearBtn.classList.remove("hidden");
    } else if (hasSvg) {
      try {
        const svgText = decodeURIComponent(escape(atob(t.photo_svg_b64)));
        preview.innerHTML = recolorPassportSvg(svgText, photoColor);
      } catch (_) {
        preview.innerHTML = '<span class="pp-photo-q">?</span>';
      }
      if (label) label.textContent = "Заменить SVG";
      if (clearBtn) clearBtn.classList.remove("hidden");
    } else {
      preview.innerHTML = '<span class="pp-photo-q">?</span>';
      if (label) label.textContent = "Загрузить SVG или фото";
      if (clearBtn) clearBtn.classList.add("hidden");
    }
    const sizeBox = document.getElementById("passport-photo-size");
    const sizeEl = document.getElementById("passport-photo-scale");
    const sizeVal = document.getElementById("passport-photo-scale-val");
    if (sizeBox && sizeEl && sizeVal) {
      // Slider is only meaningful when a photo (SVG or PNG) is present —
      // '?' is sized to a fixed font glyph (handled in the renderer) and
      // the scale knob doesn't apply to it.
      sizeBox.classList.toggle("hidden", !hasSvg && !hasPng);
      const pct = Math.round(clampPhotoScale(t.photo_scale) * 100);
      sizeEl.value = String(pct);
      sizeVal.textContent = pct + "%";
    }
    const colorBox = document.getElementById("passport-photo-color-row");
    const colorEl = document.getElementById("passport-photo-color");
    const colorVal = document.getElementById("passport-photo-color-val");
    if (colorBox && colorEl && colorVal) {
      // Recolouring only applies to the SVG path — a PNG keeps its own
      // colours.
      colorBox.classList.toggle("hidden", !hasSvg);
      colorEl.value = photoColor;
      colorVal.textContent = photoColor.toUpperCase();
    }
  }

  // Passport-wide actions: reset all, photo SVG/PNG upload/clear.
  (function bindPassportActions() {
    const reset = document.getElementById("passport-reset");
    const svgInput = document.getElementById("passport-photo-svg");
    const clearBtn = document.getElementById("passport-photo-clear");
    if (reset) reset.addEventListener("click", () => {
      const t = state.perEmoji[state.currentIdx];
      if (!t) return;
      if (Array.isArray(t.lines)) t.lines.forEach(l => {
        l.text = ""; l.scale = 1.0; l.color = "#000000";
        l.offset_x = 0; l.offset_y = 0;
      });
      t.photo_svg_b64 = "";
      t.photo_png_b64 = "";
      t.photo_scale = 1.0;
      t.photo_color = "#ffffff";
      renderPassportLinesUI();
      rebuildGridCellState(state.currentIdx);
      rerenderPreviewSoon();
    });
    if (svgInput) svgInput.addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const isRaster = isRasterImageFile(f);
      const isSvg = /\.svg$/i.test(f.name) || f.type === "image/svg+xml";
      const t = getTransform(state.currentIdx);
      if (isRaster) {
        let b64;
        try { b64 = await rasterFileToPngBase64(f); }
        catch (err) { setStatus(err?.message || "Не удалось прочитать изображение"); e.target.value = ""; return; }
        t.photo_png_b64 = b64;
        t.photo_svg_b64 = "";
      } else if (isSvg) {
        if (f.size > 256 * 1024) { setStatus("SVG > 256KB"); e.target.value = ""; return; }
        const txt = await f.text();
        if (!/<svg/i.test(txt)) { setStatus("Не похоже на SVG"); e.target.value = ""; return; }
        t.photo_svg_b64 = btoa(unescape(encodeURIComponent(txt)));
        t.photo_png_b64 = "";
      } else {
        setStatus("Поддерживаются PNG, JPG, WEBP и SVG"); e.target.value = ""; return;
      }
      t.photo_color = normalizeHexColor(t.photo_color || "#ffffff");
      renderPassportPhotoUI();
      rebuildGridCellState(state.currentIdx);
      rerenderPreviewSoon();
      setStatus("");
    });
    if (clearBtn) clearBtn.addEventListener("click", () => {
      const t = state.perEmoji[state.currentIdx];
      if (!t) return;
      t.photo_svg_b64 = "";
      t.photo_png_b64 = "";
      t.photo_scale = 1.0;
      t.photo_color = "#ffffff";
      const inp = document.getElementById("passport-photo-svg");
      if (inp) inp.value = "";
      renderPassportPhotoUI();
      rebuildGridCellState(state.currentIdx);
      rerenderPreviewSoon();
    });
    const sizeEl = document.getElementById("passport-photo-scale");
    const sizeVal = document.getElementById("passport-photo-scale-val");
    if (sizeEl) {
      const syncPhotoScale = () => {
        const t = getTransform(state.currentIdx);
        t.photo_scale = clampPhotoScale((parseFloat(sizeEl.value) || 100) / 100);
        if (sizeVal) sizeVal.textContent = Math.round(t.photo_scale * 100) + "%";
        rebuildGridCellState(state.currentIdx);
        rerenderPreviewSoon();
      };
      sizeEl.addEventListener("input", syncPhotoScale);
      sizeEl.addEventListener("change", syncPhotoScale);
    }
    const colorEl = document.getElementById("passport-photo-color");
    const colorVal = document.getElementById("passport-photo-color-val");
    if (colorEl) {
      const syncPhotoColor = () => {
        const t = getTransform(state.currentIdx);
        t.photo_color = normalizeHexColor(colorEl.value || "#ffffff");
        if (colorVal) colorVal.textContent = t.photo_color.toUpperCase();
        renderPassportPhotoUI();
        rebuildGridCellState(state.currentIdx);
        rerenderPreviewSoon();
      };
      colorEl.addEventListener("input", syncPhotoColor);
      colorEl.addEventListener("change", syncPhotoColor);
    }
  })();

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── Grid ───────────────────────────────────
  let gridBuilt = false;
  let gridNewBuilt = false;

  // Lazy Lottie preview inside grid cells (original emoji, no override).
  const gridObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const cell = entry.target;
        gridObserver.unobserve(cell);
        renderCellPreview(cell, parseCellId(cell.dataset.id));
      }
    }
  }, { rootMargin: "120px" });

  async function thumbnailLottieData(id, raw) {
    // Grid/strip thumbnails render the raw master template otherwise, which
    // still carries the baked s/w/e/x watermark letters. Apply the same
    // substitution the single-tile editor preview uses, falling back to the
    // "Lean" placeholder when no nickname/logo has been typed yet.
    try {
      const eff = effectiveOverride(id);
      if (eff.kind === "text" && !String(eff.text || "").trim()) {
        eff.text = DEFAULT_BRAND_TEXT;
      }
      await ensureFont(eff.font, fontTextForOverride(eff) || "Lean");
      return SwexReplacer.applyToLottie(raw, eff);
    } catch (e) {
      console.error("[editor] thumbnail applyToLottie failed for", id, e);
      return raw;
    }
  }

  async function renderCellPreview(cell, id) {
    if (cell._previewLoaded) return;
    cell._previewLoaded = true;
    try {
      const container = cell.querySelector(".cell-anim");
      const fallback = cell.querySelector(".cell-fallback");
      if (renderStaticPreview(container, id, fallback)) return;
      const raw = await loadLottie(id);
      const data = await thumbnailLottieData(id, raw);
      if (!container) return;
      const anim = lottie.loadAnimation({
        container,
        renderer: "canvas",
        loop: false,
        autoplay: false,
        animationData: data,
      });
      cell._gridAnim = anim;
      anim.addEventListener("DOMLoaded", () => {
        anim.goToAndStop(0, true);
        if (fallback) fallback.style.display = "none";
      });
    } catch (e) {
      console.error("[editor] grid preview failed for", id, e);
    }
  }

  function makeCell(f) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.id = String(f.id);
    cell.title = "#" + f.id;

    const animDiv = document.createElement("div");
    animDiv.className = "cell-anim";
    cell.appendChild(animDiv);

    const fallback = document.createElement("span");
    fallback.className = "cell-fallback";
    fallback.textContent = f.emoji || "·";
    cell.appendChild(fallback);

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = tileBadge(f.id);
    cell.appendChild(idx);
    // Per-cell selection toggle (works in both modes, indep. of cell click).
    const chk = document.createElement("span");
    chk.className = "chk";
    chk.title = "В пак";
    chk.addEventListener("click", (e) => {
      e.stopPropagation();
      const ok = toggleSelected(f.id);
      if (!ok) {
        selectCountNum.classList.remove("over");
        void selectCountNum.offsetWidth;
        selectCountNum.classList.add("over");
        setTimeout(() => selectCountNum.classList.remove("over"), 350);
      }
    });
    cell.appendChild(chk);
    cell.appendChild(makeStyleBrushButton(f.id, "cell-style-brush"));
    if (f.id === state.currentIdx) cell.classList.add("current");
    if (isTransformChanged(state.perEmoji[f.id])) cell.classList.add("modified");
    if (state.selected.has(f.id)) cell.classList.add("selected");
    if (isPassportId(f.id)) cell.classList.add("is-passport");
    if (isUploadId(f.id)) cell.classList.add("is-upload");
    gridObserver.observe(cell);
    cell.addEventListener("click", () => {
      if (state.format === "sticker") {
        const ok = toggleSelected(f.id);
        if (!ok) {
          selectCountNum.classList.remove("over");
          void selectCountNum.offsetWidth;
          selectCountNum.classList.add("over");
          setTimeout(() => selectCountNum.classList.remove("over"), 350);
        }
        return;
      }
      selectId(f.id);
      document.querySelector('.tab[data-tab="editor"]').click();
    });
    return cell;
  }

  function rebuildGrid() {
    if (gridBuilt) {
      grid.querySelectorAll(".cell").forEach(c => {
        const id = parseCellId(c.dataset.id);
        c.classList.toggle("current",  id === state.currentIdx);
        c.classList.toggle("modified", isTransformChanged(state.perEmoji[id]));
        c.classList.toggle("selected", state.selected.has(id));
        c.querySelectorAll(".style-brush-btn").forEach(btn => syncStyleBrushButton(btn, id));
      });
      rebuildGridSelectionState();
      return;
    }
    grid.innerHTML = "";
    state.masterFiles.forEach(f => grid.appendChild(makeCell(f)));
    gridBuilt = true;
    rebuildGridSelectionState();
  }
  function rebuildGridNew() {
    if (gridNewBuilt) {
      gridNew.querySelectorAll(".cell").forEach(c => {
        const id = parseCellId(c.dataset.id);
        c.classList.toggle("current",  id === state.currentIdx);
        c.classList.toggle("modified", isTransformChanged(state.perEmoji[id]));
        c.classList.toggle("selected", state.selected.has(id));
        c.querySelectorAll(".style-brush-btn").forEach(btn => syncStyleBrushButton(btn, id));
      });
      rebuildGridSelectionState();
      return;
    }
    gridNew.innerHTML = "";
    if (!state.newFiles.length) {
      gridNew.innerHTML = '<div class="row label" style="grid-column:1/-1;color:#6e6e73">пусто</div>';
      gridNewBuilt = true;
      return;
    }
    state.newFiles.forEach(f => gridNew.appendChild(makeCell(f)));
    gridNewBuilt = true;
    rebuildGridSelectionState();
  }
  function rebuildGridCellState(id) {
    const sel = `.cell[data-id="${String(id).replace(/"/g, '\\"')}"]`;
    document.querySelectorAll(sel).forEach(cell => {
      cell.classList.toggle("modified", isTransformChanged(state.perEmoji[id]));
      cell.querySelectorAll(".style-brush-btn").forEach(btn => syncStyleBrushButton(btn, id));
    });
    refreshStripCellState(id);
  }

  // ── Preview strip (horizontal thumbnails of all emoji) ─────
  let stripBuilt = false;
  let stripPreviewActive = 0;
  let stripWarmRaf = 0;
  const stripPreviewQueue = [];
  const STRIP_PREVIEW_CONCURRENCY = isCoarsePointer ? 1 : 2;
  const stripObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const cell = entry.target;
        stripObserver.unobserve(cell);
        queueStripCellPreview(cell, parseCellId(cell.dataset.id));
      }
    }
  }, { root: previewStrip, rootMargin: isCoarsePointer ? "70px" : "120px" });

  function queueStripCellPreview(cell, id, priority = false) {
    if (!cell || cell._stripLoaded || cell._stripLoading || cell._stripQueued) return;
    cell._stripQueued = true;
    const job = { cell, id };
    if (priority) stripPreviewQueue.unshift(job);
    else stripPreviewQueue.push(job);
    pumpStripPreviewQueue();
  }

  function pumpStripPreviewQueue() {
    while (stripPreviewActive < STRIP_PREVIEW_CONCURRENCY && stripPreviewQueue.length) {
      const job = stripPreviewQueue.shift();
      const cell = job.cell;
      cell._stripQueued = false;
      if (!document.body.contains(cell) || cell._stripLoaded || cell._stripLoading) continue;
      stripPreviewActive += 1;
      renderStripCellPreview(cell, job.id).finally(() => {
        stripPreviewActive = Math.max(0, stripPreviewActive - 1);
        setTimeout(pumpStripPreviewQueue, 35);
      });
    }
  }

  function warmVisibleStripPreviews(limit = isCoarsePointer ? 5 : 10) {
    if (!previewStrip) return;
    const rootRect = previewStrip.getBoundingClientRect();
    let queued = 0;
    previewStrip.querySelectorAll(".strip-cell").forEach(cell => {
      if (queued >= limit) return;
      if (cell._stripLoaded || cell._stripLoading || cell._stripQueued) return;
      const rect = cell.getBoundingClientRect();
      const margin = isCoarsePointer ? 80 : 140;
      if (rect.right >= rootRect.left - margin && rect.left <= rootRect.right + margin) {
        queued += 1;
        queueStripCellPreview(cell, parseCellId(cell.dataset.id), cell.classList.contains("current"));
      }
    });
  }

  function scheduleStripWarm(limit = isCoarsePointer ? 5 : 10) {
    if (!previewStrip) return;
    if (stripWarmRaf) cancelAnimationFrame(stripWarmRaf);
    let queued = false;
    const run = () => {
      if (queued) return;
      queued = true;
      stripWarmRaf = 0;
      warmVisibleStripPreviews(limit);
    };
    stripWarmRaf = requestAnimationFrame(run);
    setTimeout(run, 80);
  }

  function attachStripWarmScroll() {
    if (!previewStrip || previewStrip._stripWarmHooked) return;
    previewStrip._stripWarmHooked = true;
    previewStrip.addEventListener("scroll", () => scheduleStripWarm(isCoarsePointer ? 5 : 10), { passive: true });
  }

  async function renderStripCellPreview(cell, id) {
    if (cell._stripLoaded || cell._stripLoading) return;
    cell._stripLoading = true;
    try {
      const container = cell.querySelector(".strip-anim");
      const fb = cell.querySelector(".strip-fallback");
      if (renderStaticPreview(container, id, fb)) {
        cell._stripLoaded = true;
        return;
      }
      const raw = await loadLottie(id);
      const data = await thumbnailLottieData(id, raw);
      if (!document.body.contains(cell)) return;
      if (!container) return;
      const anim = lottie.loadAnimation({
        container,
        renderer: "canvas",
        loop: false,
        autoplay: false,
        animationData: data,
      });
      cell._stripAnim = anim;
      anim.addEventListener("DOMLoaded", () => {
        anim.goToAndStop(0, true);
        if (fb) fb.style.display = "none";
      });
      cell._stripLoaded = true;
    } catch (e) {
      cell._stripLoaded = false;
      console.error("[editor] strip preview failed for", id, e);
    } finally {
      cell._stripLoading = false;
    }
  }

  function makeStripCell(f) {
    const cell = document.createElement("div");
    cell.className = "strip-cell";
    cell.dataset.id = String(f.id);
    cell.setAttribute("role", "option");
    cell.title = "#" + f.id;

    const anim = document.createElement("div");
    anim.className = "strip-anim";
    cell.appendChild(anim);

    const fallback = document.createElement("span");
    fallback.className = "strip-fallback";
    fallback.textContent = f.emoji || "·";
    cell.appendChild(fallback);
    cell.appendChild(makeStyleBrushButton(f.id, "strip-style-brush"));

    if (f.id === state.currentIdx) cell.classList.add("current");
    if (isTransformChanged(state.perEmoji[f.id])) cell.classList.add("modified");
    if (state.selected.has(f.id)) cell.classList.add("selected");
    if (isPassportId(f.id)) cell.classList.add("is-passport");
    if (isUploadId(f.id)) cell.classList.add("is-upload");

    cell.addEventListener("click", () => selectId(f.id));
    stripObserver.observe(cell);
    return cell;
  }

  function rebuildPreviewStrip() {
    if (!previewStrip) return;
    if (stripBuilt) {
      // Lightweight refresh of state classes only.
      previewStrip.querySelectorAll(".strip-cell").forEach(c => {
        const id = parseCellId(c.dataset.id);
        c.classList.toggle("current",  id === state.currentIdx);
        c.classList.toggle("modified", isTransformChanged(state.perEmoji[id]));
        c.classList.toggle("selected", state.selected.has(id));
        c.querySelectorAll(".style-brush-btn").forEach(btn => syncStyleBrushButton(btn, id));
      });
      if (emojiPickerBuilt) {
        if (emojiPickerOpen) {
          rebuildEmojiPicker(true);
        } else {
          if (emojiPickerObserver) {
            emojiPickerGrid?.querySelectorAll(".emoji-picker-cell").forEach(cell => {
              try { emojiPickerObserver.unobserve(cell); } catch (_) {}
            });
          }
          emojiPickerGrid?.replaceChildren();
          emojiPickerBuilt = false;
        }
      }
      return;
    }
    previewStrip.innerHTML = "";
    allFiles().forEach(f => previewStrip.appendChild(makeStripCell(f)));
    attachStripDesktopScroll();
    attachStripWarmScroll();
    stripBuilt = true;
    scheduleStripWarm();
  }

  // Desktop scroll affordances. The strip is `overflow-x: auto` so phone
  // touch swipe works natively, but on desktop the scrollbar is hidden
  // (`display:none`) and the browser doesn't translate vertical wheel into
  // horizontal scroll automatically — so the strip looked frozen. Hook a
  // wheel listener that does the translation, plus mouse-drag (click-and-
  // pan) so users can scrub through the thumbnails like a film strip.
  function attachStripDesktopScroll() {
    if (!previewStrip || previewStrip._desktopScrollHooked) return;
    previewStrip._desktopScrollHooked = true;

    previewStrip.addEventListener("wheel", (e) => {
      // Only intercept when the user is actually scrolling primarily
      // vertically. Trackpads that already emit horizontal deltaX (e.g.
      // Apple Magic Trackpad two-finger swipe) keep their native behaviour.
      const dx = e.deltaX;
      const dy = e.deltaY;
      if (Math.abs(dy) > Math.abs(dx) && dy !== 0) {
        previewStrip.scrollLeft += dy;
        e.preventDefault();
      }
    }, { passive: false });

    let drag = null;
    previewStrip.addEventListener("mousedown", (e) => {
      // Ignore non-primary buttons; let clicks on cells through (the cell
      // click handler will run if the pointer didn't move).
      if (e.button !== 0) return;
      drag = {
        startX: e.clientX,
        startScroll: previewStrip.scrollLeft,
        moved: false,
      };
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) > 4) {
        drag.moved = true;
        previewStrip.classList.add("dragging");
      }
      if (drag.moved) {
        previewStrip.scrollLeft = drag.startScroll - dx;
        e.preventDefault();
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (!drag) return;
      const wasDrag = drag.moved;
      drag = null;
      previewStrip.classList.remove("dragging");
      if (wasDrag) {
        // Eat the trailing click so the cell under the mouse doesn't
        // accidentally select after the drag.
        const swallow = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          window.removeEventListener("click", swallow, true);
        };
        window.addEventListener("click", swallow, true);
      }
    });
  }

  function refreshStripCellState(id) {
    if (!previewStrip) return;
    const sel = `.strip-cell[data-id="${String(id).replace(/"/g, '\\"')}"]`;
    const cell = previewStrip.querySelector(sel);
    if (!cell) return;
    cell.classList.toggle("modified", isTransformChanged(state.perEmoji[id]));
    cell.classList.toggle("selected", state.selected.has(id));
    cell.querySelectorAll(".style-brush-btn").forEach(btn => syncStyleBrushButton(btn, id));
    refreshEmojiPickerState(id);
  }

  function refreshStripSelectionState() {
    if (!previewStrip || !stripBuilt) return;
    previewStrip.querySelectorAll(".strip-cell").forEach(c => {
      const id = parseCellId(c.dataset.id);
      c.classList.toggle("selected", state.selected.has(id));
      c.querySelectorAll(".style-brush-btn").forEach(btn => syncStyleBrushButton(btn, id));
    });
  }

  function centerStripCell(target, behavior = "smooth") {
    if (!previewStrip || !target) return;
    const left = Math.max(
      0,
      target.offsetLeft + target.offsetWidth / 2 - previewStrip.clientWidth / 2,
    );
    if (behavior === "auto") {
      const prevBehavior = previewStrip.style.scrollBehavior;
      previewStrip.style.scrollBehavior = "auto";
      previewStrip.scrollLeft = left;
      previewStrip.style.scrollBehavior = prevBehavior;
      return;
    }
    previewStrip.scrollTo({ left, behavior });
  }

  function syncStripCurrent(id, behavior = "smooth") {
    if (!previewStrip) return;
    let target = null;
    previewStrip.querySelectorAll(".strip-cell").forEach(c => {
      const cid = parseCellId(c.dataset.id);
      const is = cid === id;
      c.classList.toggle("current", is);
      c.querySelectorAll(".style-brush-btn").forEach(btn => syncStyleBrushButton(btn, cid));
      if (is) target = c;
    });
    if (target) {
      centerStripCell(target, behavior);
      queueStripCellPreview(target, id, true);
      scheduleStripWarm(isCoarsePointer ? 4 : 8);
    }
    refreshEmojiPickerState(id);
  }

  function centerStripOnId(id, behavior = "smooth") {
    if (!previewStrip) return;
    const target = previewStrip.querySelector(`.strip-cell[data-id="${dataAttrValue(id)}"]`);
    if (target) centerStripCell(target, behavior);
  }

  // ── Emoji picker catalog (3-column quick jump) ─────────────────────
  let emojiPickerPreviewActive = 0;
  const emojiPickerPreviewQueue = [];
  const EMOJI_PICKER_PREVIEW_CONCURRENCY = isCoarsePointer ? 1 : 2;
  const emojiPickerObserver = emojiPickerGrid && "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        let warmed = 0;
        for (const entry of entries) {
          if (entry.isIntersecting && emojiPickerOpen && warmed < PICKER_SCROLL_WARM_LIMIT) {
            const cell = entry.target;
            if (cell.hidden) continue;
            emojiPickerObserver.unobserve(cell);
            warmed += 1;
            queueEmojiPickerCellPreview(cell, parseCellId(cell.dataset.id));
          }
        }
      }, { root: emojiPickerGrid, rootMargin: isCoarsePointer ? "40px" : "120px" })
    : null;

  function queueEmojiPickerCellPreview(cell, id, priority = false) {
    if (!emojiPickerOpen || !cell || cell.hidden || cell._epLoaded || cell._epLoading || cell._epQueued) return;
    cell._epQueued = true;
    const job = { cell, id, epoch: emojiPickerPreviewEpoch };
    if (priority) emojiPickerPreviewQueue.unshift(job);
    else emojiPickerPreviewQueue.push(job);
    pumpEmojiPickerPreviewQueue();
  }

  function clearEmojiPickerPreviewQueue() {
    while (emojiPickerPreviewQueue.length) {
      const job = emojiPickerPreviewQueue.shift();
      if (job?.cell) job.cell._epQueued = false;
    }
  }

  function pumpEmojiPickerPreviewQueue() {
    if (!emojiPickerOpen) {
      clearEmojiPickerPreviewQueue();
      return;
    }
    while (emojiPickerPreviewActive < EMOJI_PICKER_PREVIEW_CONCURRENCY && emojiPickerPreviewQueue.length) {
      const job = emojiPickerPreviewQueue.shift();
      const cell = job.cell;
      if (cell) cell._epQueued = false;
      if (
        !cell || !document.body.contains(cell) || cell.hidden ||
        cell._epLoaded || cell._epLoading || job.epoch !== emojiPickerPreviewEpoch
      ) continue;
      emojiPickerPreviewActive += 1;
      renderEmojiPickerCellPreview(cell, job.id).finally(() => {
        emojiPickerPreviewActive = Math.max(0, emojiPickerPreviewActive - 1);
        setTimeout(pumpEmojiPickerPreviewQueue, isCoarsePointer ? 90 : 40);
      });
    }
  }

  async function renderEmojiPickerCellPreview(cell, id) {
    if (!emojiPickerOpen || cell.hidden || cell._epLoaded || cell._epLoading) return;
    cell._epLoading = true;
    const epoch = emojiPickerPreviewEpoch;
    try {
      const container = cell.querySelector(".ep-anim");
      const fb = cell.querySelector(".ep-fallback");
      if (renderStaticPreview(container, id, fb)) {
        cell._epLoaded = true;
        return;
      }
      const raw = await loadLottie(id);
      const data = await thumbnailLottieData(id, raw);
      if (!emojiPickerOpen || cell.hidden || epoch !== emojiPickerPreviewEpoch) {
        cell._epLoading = false;
        return;
      }
      if (!container) return;
      const anim = lottie.loadAnimation({
        container,
        renderer: "canvas",
        loop: false,
        autoplay: false,
        animationData: data,
      });
      cell._epAnim = anim;
      cell._epLoaded = true;
      anim.addEventListener("DOMLoaded", () => {
        anim.goToAndStop(0, true);
        if (fb) fb.style.display = "none";
      });
    } catch (e) {
      console.error("[editor] picker preview failed for", id, e);
    } finally {
      cell._epLoading = false;
    }
  }

  function makeEmojiPickerCell(f, pos) {
    const cell = document.createElement("div");
    cell.className = "emoji-picker-cell";
    cell.dataset.id = String(f.id);
    cell.dataset.pos = String(pos);
    cell.setAttribute("role", "option");
    cell.setAttribute("aria-label", "Эмодзи " + pos);
    cell.title = "#" + pos;

    const anim = document.createElement("div");
    anim.className = "ep-anim";
    cell.appendChild(anim);

    const fallback = document.createElement("span");
    fallback.className = "ep-fallback";
    fallback.textContent = f.emoji || "·";
    cell.appendChild(fallback);

    const num = document.createElement("span");
    num.className = "ep-num";
    num.textContent = pos;
    cell.appendChild(num);
    cell.appendChild(makeStyleBrushButton(f.id, "ep-style-brush"));

    if (f.id === state.currentIdx) cell.classList.add("current");
    if (isTransformChanged(state.perEmoji[f.id])) cell.classList.add("modified");
    if (state.selected.has(f.id)) cell.classList.add("selected");
    if (isPassportId(f.id)) cell.classList.add("is-passport");
    if (isUploadId(f.id)) cell.classList.add("is-upload");

    cell.addEventListener("click", () => selectId(f.id, { fromPicker: true }));
    if (emojiPickerObserver) emojiPickerObserver.observe(cell);
    return cell;
  }

  function updateEmojiPickerCount(visible, total) {
    if (!emojiPickerCount) return;
    emojiPickerCount.textContent = visible === total ? `${total} эмодзи` : `${visible} из ${total}`;
  }

  function syncEmojiPickerCellState(cell, id, currentId = state.currentIdx) {
    if (!cell) return;
    const isCurrent = id === currentId;
    cell.classList.toggle("current", isCurrent);
    cell.classList.toggle("modified", isTransformChanged(state.perEmoji[id]));
    cell.classList.toggle("selected", state.selected.has(id));
    cell.setAttribute("aria-selected", isCurrent ? "true" : "false");
    cell.querySelectorAll(".style-brush-btn").forEach(btn => syncStyleBrushButton(btn, id));
  }

  function emojiPickerCellById(id) {
    if (!emojiPickerGrid) return null;
    return emojiPickerGrid.querySelector(`.emoji-picker-cell[data-id="${dataAttrValue(id)}"]`);
  }

  function warmEmojiPickerVisiblePreviews(limit = PICKER_WARM_LIMIT) {
    if (!emojiPickerGrid || !emojiPickerOpen) return;
    const rootRect = emojiPickerGrid.getBoundingClientRect();
    let warmed = 0;
    emojiPickerGrid.querySelectorAll(".emoji-picker-cell:not([hidden])").forEach(cell => {
      if (warmed >= limit) return;
      if (cell._epLoaded || cell._epLoading || cell._epQueued || cell.hidden) return;
      const rect = cell.getBoundingClientRect();
      const margin = isCoarsePointer ? 32 : 80;
      if (rect.bottom >= rootRect.top - margin && rect.top <= rootRect.bottom + margin) {
        warmed += 1;
        queueEmojiPickerCellPreview(cell, parseCellId(cell.dataset.id));
      }
    });
  }

  function scheduleEmojiPickerWarm(limit = PICKER_WARM_LIMIT) {
    if (!emojiPickerGrid || !emojiPickerOpen) return;
    if (emojiPickerWarmRaf) cancelAnimationFrame(emojiPickerWarmRaf);
    cancelIdleWork(emojiPickerWarmIdle);
    emojiPickerWarmIdle = null;
    let queued = false;
    const queueWarm = () => {
      if (queued) return;
      queued = true;
      emojiPickerWarmRaf = 0;
      cancelIdleWork(emojiPickerWarmIdle);
      emojiPickerWarmIdle = {
        type: "timer",
        id: setTimeout(() => {
          emojiPickerWarmIdle = null;
          warmEmojiPickerVisiblePreviews(limit);
        }, 180)
      };
    };
    emojiPickerWarmRaf = requestAnimationFrame(queueWarm);
    emojiPickerWarmIdle = { type: "timer", id: setTimeout(queueWarm, 80) };
  }

  function resetEmojiPickerCellPreview(cell, options = {}) {
    if (!cell) return;
    if (cell._epAnim) {
      try { cell._epAnim.destroy(); } catch (_) {}
    }
    cell._epAnim = null;
    cell._epLoaded = false;
    cell._epQueued = false;
    const container = cell.querySelector(".ep-anim");
    if (container) container.innerHTML = "";
    const fb = cell.querySelector(".ep-fallback");
    if (fb) fb.style.display = "";
    if (options.reobserve && emojiPickerObserver && emojiPickerOpen && !cell.hidden) {
      try { emojiPickerObserver.observe(cell); } catch (_) {}
    }
  }

  function disposeEmojiPickerFarPreviews() {
    if (!emojiPickerGrid || !emojiPickerOpen) return;
    const rootRect = emojiPickerGrid.getBoundingClientRect();
    const margin = isCoarsePointer ? 110 : 520;
    emojiPickerGrid.querySelectorAll(".emoji-picker-cell").forEach(cell => {
      if (!cell._epLoaded || cell.hidden) return;
      const rect = cell.getBoundingClientRect();
      const far = rect.bottom < rootRect.top - margin || rect.top > rootRect.bottom + margin;
      if (far) resetEmojiPickerCellPreview(cell, { reobserve: true });
    });
  }

  let emojiPickerTrimRaf = 0;
  function scheduleEmojiPickerTrim() {
    if (!emojiPickerGrid || !emojiPickerOpen) return;
    if (emojiPickerTrimRaf) cancelAnimationFrame(emojiPickerTrimRaf);
    emojiPickerTrimRaf = requestAnimationFrame(() => {
      emojiPickerTrimRaf = 0;
      disposeEmojiPickerFarPreviews();
    });
  }

  function disposeEmojiPickerPreviews(options = {}) {
    if (!emojiPickerGrid) return;
    const reobserve = options.reobserve === true;
    const cells = Array.from(emojiPickerGrid.querySelectorAll(".emoji-picker-cell"));
    const chunked = options.chunked !== false;
    if (!chunked) {
      cells.forEach(cell => resetEmojiPickerCellPreview(cell, { reobserve }));
      return;
    }
    const chunkSize = isCoarsePointer ? 4 : 12;
    let i = 0;
    const step = () => {
      const end = Math.min(cells.length, i + chunkSize);
      for (; i < end; i += 1) resetEmojiPickerCellPreview(cells[i], { reobserve });
      if (i < cells.length) setTimeout(step, isCoarsePointer ? 45 : 20);
    };
    step();
  }

  function scheduleEmojiPickerPreviewCleanup() {
    cancelIdleWork(emojiPickerDisposeIdle);
    emojiPickerDisposeIdle = scheduleIdleWork(() => {
      emojiPickerDisposeIdle = null;
      if (!emojiPickerOpen) disposeEmojiPickerPreviews();
    }, 900);
  }

  function applyEmojiPickerFilter(options = {}) {
    if (!emojiPickerGrid) return;
    const shouldWarm = options.warm !== false;
    const total = emojiPickerGrid.querySelectorAll(".emoji-picker-cell").length;
    let q = (emojiPickerSearch?.value || "").replace(/\D+/g, "");
    if (emojiPickerSearch && emojiPickerSearch.value !== q) emojiPickerSearch.value = q;
    let visible = 0;
    emojiPickerGrid.querySelectorAll(".emoji-picker-cell").forEach(cell => {
      const pos = String(cell.dataset.pos || "");
      const match = !q || pos.includes(q);
      cell.hidden = !match;
      if (!match && cell._epLoaded) resetEmojiPickerCellPreview(cell, { reobserve: false });
      if (match) visible += 1;
    });
    const empty = emojiPickerGrid.querySelector(".emoji-picker-empty");
    if (empty) empty.hidden = visible > 0;
    updateEmojiPickerCount(visible, total);
    if (shouldWarm) scheduleEmojiPickerWarm(PICKER_WARM_LIMIT);
  }

  function rebuildEmojiPicker(force = false) {
    if (!emojiPickerGrid) return;
    if (emojiPickerBuilt && !force) {
      refreshEmojiPickerState(state.currentIdx);
      applyEmojiPickerFilter({ warm: emojiPickerOpen });
      return;
    }
    if (emojiPickerObserver) {
      emojiPickerGrid.querySelectorAll(".emoji-picker-cell").forEach(cell => {
        try { emojiPickerObserver.unobserve(cell); } catch (_) {}
      });
    }
    const frag = document.createDocumentFragment();
    allFiles().forEach((f, i) => frag.appendChild(makeEmojiPickerCell(f, i + 1)));

    const empty = document.createElement("div");
    empty.className = "emoji-picker-empty";
    empty.textContent = "Ничего не найдено";
    empty.hidden = true;
    frag.appendChild(empty);
    emojiPickerGrid.replaceChildren(frag);

    emojiPickerBuilt = true;
    applyEmojiPickerFilter({ warm: emojiPickerOpen });
    refreshEmojiPickerState(state.currentIdx);
  }

  function refreshEmojiPickerState(id = state.currentIdx) {
    if (!emojiPickerGrid || !emojiPickerBuilt) return;
    const ids = new Set([String(id), String(state.currentIdx)]);
    const prev = emojiPickerGrid.querySelector(".emoji-picker-cell.current");
    if (prev?.dataset?.id) ids.add(prev.dataset.id);
    ids.forEach(rawId => {
      const cell = emojiPickerCellById(rawId);
      if (!cell) return;
      syncEmojiPickerCellState(cell, parseCellId(cell.dataset.id));
    });
  }

  function scrollEmojiPickerCurrentIntoView(behavior = "smooth") {
    if (!emojiPickerGrid || !emojiPickerOpen) return;
    const target = emojiPickerGrid.querySelector(".emoji-picker-cell.current:not([hidden])");
    if (!target) return;
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
    scheduleEmojiPickerWarm(PICKER_WARM_LIMIT);
  }

  function setEmojiPickerOpen(open) {
    if (!emojiPickerPanel) return;
    open = !!open;
    if (open === emojiPickerOpen && !emojiPickerPanel.classList.contains("is-closing")) return;
    if (emojiPickerPanel._closeTimer) {
      clearTimeout(emojiPickerPanel._closeTimer);
      emojiPickerPanel._closeTimer = 0;
    }
    emojiPickerOpen = open;
    refreshCounterOpenState();
    if (open) {
      emojiPickerPreviewEpoch += 1;
      cancelIdleWork(emojiPickerDisposeIdle);
      cancelIdleWork(emojiPickerPrebuildIdle);
      emojiPickerDisposeIdle = null;
      emojiPickerPrebuildIdle = null;
      emojiPickerPanel.classList.remove("hidden", "is-closing");
      emojiPickerPanel.classList.add("is-opening");
      rebuildEmojiPicker();
      refreshEmojiPickerState(state.currentIdx);
      let opened = false;
      const finishOpen = () => {
        if (!emojiPickerOpen || opened) return;
        opened = true;
        emojiPickerPanel.classList.remove("is-opening");
        scrollEmojiPickerCurrentIntoView("auto");
        scheduleEmojiPickerWarm(PICKER_WARM_LIMIT);
      };
      requestAnimationFrame(finishOpen);
      setTimeout(finishOpen, 80);
      return;
    }
    emojiPickerPreviewEpoch += 1;
    if (emojiPickerWarmRaf) {
      cancelAnimationFrame(emojiPickerWarmRaf);
      emojiPickerWarmRaf = 0;
    }
    cancelIdleWork(emojiPickerWarmIdle);
    emojiPickerWarmIdle = null;
    if (emojiPickerTrimRaf) {
      cancelAnimationFrame(emojiPickerTrimRaf);
      emojiPickerTrimRaf = 0;
    }
    clearEmojiPickerPreviewQueue();
    emojiPickerPanel.classList.remove("is-opening");
    emojiPickerPanel.classList.add("is-closing");
    const finishClose = (e) => {
      if (e && e.target !== emojiPickerPanel) return;
      if (emojiPickerOpen) return;
      emojiPickerPanel.removeEventListener("transitionend", finishClose);
      if (emojiPickerPanel._closeTimer) clearTimeout(emojiPickerPanel._closeTimer);
      emojiPickerPanel.classList.add("hidden");
      emojiPickerPanel.classList.remove("is-closing");
      emojiPickerPanel._closeTimer = 0;
      scheduleEmojiPickerPreviewCleanup();
    };
    emojiPickerPanel.addEventListener("transitionend", finishClose);
    emojiPickerPanel._closeTimer = setTimeout(finishClose, 240);
  }

  counter?.addEventListener("click", () => setEmojiPickerOpen(!emojiPickerOpen));
  emojiPickerSearch?.addEventListener("input", applyEmojiPickerFilter);
  emojiPickerSearch?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setEmojiPickerOpen(false);
  });
  emojiPickerGrid?.addEventListener("scroll", () => {
    scheduleEmojiPickerTrim();
    scheduleEmojiPickerWarm(PICKER_SCROLL_WARM_LIMIT);
  }, { passive: true });

  function attachEmojiPickerTouchGuard() {
    if (!emojiPickerGrid || emojiPickerGrid._touchGuardHooked) return;
    emojiPickerGrid._touchGuardHooked = true;
    let startY = 0;
    emojiPickerGrid.addEventListener("touchstart", (e) => {
      if (e.touches && e.touches.length === 1) startY = e.touches[0].clientY;
    }, { passive: true });
    emojiPickerGrid.addEventListener("touchmove", (e) => {
      if (!emojiPickerOpen || !e.touches || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = y - startY;
      const atTop = emojiPickerGrid.scrollTop <= 1;
      const atBottom = emojiPickerGrid.scrollTop + emojiPickerGrid.clientHeight >= emojiPickerGrid.scrollHeight - 1;
      if ((atTop && dy > 0) || (atBottom && dy < 0)) {
        e.preventDefault();
      }
      e.stopPropagation();
    }, { passive: false });
  }
  attachEmojiPickerTouchGuard();

  function scheduleEmojiPickerPrebuild() {
    if (!emojiPickerGrid || emojiPickerBuilt || emojiPickerPrebuildIdle) return;
    setTimeout(() => {
      if (emojiPickerBuilt || emojiPickerOpen || !allFiles().length) return;
      emojiPickerPrebuildIdle = {
        type: "timer",
        id: setTimeout(() => {
          emojiPickerPrebuildIdle = null;
          if (!emojiPickerBuilt && !emojiPickerOpen && allFiles().length) {
            rebuildEmojiPicker(false);
          }
        }, 600)
      };
    }, 9000);
  }

  // ── Selection ──────────────────────────────
  async function selectId(id, options = {}) {
    const fromPicker = !!(options && options.fromPicker);
    if (fromPicker && emojiPickerOpen) {
      setEmojiPickerOpen(false);
    }
    state.currentIdx = id;
    loadEditorFromState();
    refreshPreviewToggle();
    syncStripCurrent(id, fromPicker ? "auto" : "smooth");
    if (fromPicker) {
      requestAnimationFrame(() => centerStripOnId(id, "auto"));
      setTimeout(() => centerStripOnId(id, "smooth"), 260);
    }
    refreshStyleBrushTargets(id);
    await renderPreview(id);
    if (!fromPicker) scrollEmojiPickerCurrentIntoView();
    if (gridBuilt) rebuildGrid();
    if (gridNewBuilt) rebuildGridNew();
    // If the layer-colors modal is open while the user navigates, refresh
    // its list against the newly-selected tile so the editor reflects the
    // current emoji's palette and stored remap.
    if (lcmBackdrop && !lcmBackdrop.classList.contains("hidden") && layerColorContext === "main") {
      populateLayerColors();
    }
  }

  // ── User-owned pack bot settings ───────────
  function activePackBotUsername() {
    const u = packBotState && packBotState.configured
      ? String(packBotState.bot_username || "").replace(/^@+/, "")
      : "";
    return u || "swexmakerbot";
  }

  function publicPackBotUsername() {
    return PUBLIC_PACK_BOT_USERNAME;
  }

  function isPackBotReady() {
    return true;
  }

  function packBotStartUrl() {
    const username = activePackBotUsername();
    return username && username !== "swexmakerbot" ? `https://t.me/${username}` : "";
  }

  function updatePackBotButton() {
    const packReady = isPackBotReady();
    if (packBotBtn) {
      packBotBtn.classList.add("hidden");
      packBotBtn.classList.toggle("ready", packReady);
      packBotBtn.title = packReady
        ? `Паки через @${activePackBotUsername()}`
        : "Добавить бота для паков";
      if (packBotDot) packBotDot.setAttribute("aria-hidden", "true");
    }
    if (packBotSettingsBtn) {
      packBotSettingsBtn.classList.add("hidden");
      packBotSettingsBtn.classList.toggle("ready", packReady);
      packBotSettingsBtn.classList.remove("warning");
      packBotSettingsBtn.textContent = "";
    }
    if (packBotHint) {
      packBotHint.textContent = "";
      packBotHint.classList.add("hidden");
    }
    const generateBtn = $("generate");
    if (generateBtn && !buildInFlight) generateBtn.disabled = false;
  }

  async function loadPackBotStatus(checkOwner = false) {
    packBotState = { configured: true, bot_username: PUBLIC_PACK_BOT_USERNAME, can_message_owner: true, needs_start: false };
    updatePackBotButton();
    return packBotState;
  }

  let botAccountModalResolve = null;
  function setBotAccountStatus(text, ok = false) {
    const el = $("bot-account-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("ok", !!ok);
  }

  function refreshBotAccountModal() {
    const current = $("bot-account-current");
    const owner = $("bot-owner-input");
    const token = $("bot-token-input");
    const del = $("bot-account-delete");
    const configured = !!(packBotState && packBotState.configured);
    const startNeeded = configured && !isPackBotReady();
    if (current) {
      current.textContent = isPackBotReady()
        ? `@${activePackBotUsername()} · ${packBotState.token_mask || "токен сохранён"} · ID ${packBotState.owner_user_id || ""}`
        : (startNeeded
          ? `@${activePackBotUsername()} · нужно нажать /start`
          : "Не подключён");
    }
    if (owner && !owner.value) {
      owner.value = configured
        ? String(packBotState.owner_user_id || "")
        : String(tg?.initDataUnsafe?.user?.id || "");
    }
    if (token) token.value = "";
    if (del) del.disabled = !configured;
    const startUrl = packBotStartUrl();
    if (botAccountOpen) {
      botAccountOpen.classList.toggle("hidden", !startNeeded || !startUrl);
      if (startUrl) botAccountOpen.href = startUrl;
      botAccountOpen.textContent = `Открыть @${activePackBotUsername()}`;
    }
    if (botAccountRecheck) {
      botAccountRecheck.classList.toggle("hidden", !startNeeded);
    }
  }

  function openBotAccountModal(resolve) {
    const m = $("bot-account-modal");
    if (!m) return;
    botAccountModalResolve = typeof resolve === "function" ? resolve : null;
    refreshBotAccountModal();
    if (packBotState && packBotState.configured && !isPackBotReady()) {
      setBotAccountStatus(`Нажми /start в @${activePackBotUsername()}, потом вернись и нажми проверку.`);
    } else {
      setBotAccountStatus("");
    }
    m.classList.remove("hidden");
    requestAnimationFrame(() => m.classList.add("show"));
    setTimeout(() => $("bot-token-input")?.focus?.(), 80);
  }

  function closeBotAccountModal(result = false) {
    const m = $("bot-account-modal");
    if (!m) return;
    m.classList.remove("show");
    setTimeout(() => m.classList.add("hidden"), 180);
    const resolve = botAccountModalResolve;
    botAccountModalResolve = null;
    if (resolve) resolve(!!result);
  }

  async function savePackBotFromModal() {
    const tokenInput = $("bot-token-input");
    const ownerInput = $("bot-owner-input");
    const saveBtn = $("bot-account-save");
    const token = String(tokenInput?.value || "").trim();
    const owner = String(ownerInput?.value || "").trim();
    if (!token || !owner) {
      setBotAccountStatus("Заполни токен и owner ID");
      return;
    }
    saveBtn && (saveBtn.disabled = true);
    setBotAccountStatus("Проверяю токен…");
    try {
      const r = await fetch("/api/pack_bot/save", {
        method: "POST",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ bot_token: token, owner_user_id: owner }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setBotAccountStatus(data.error || "Не получилось сохранить");
        return;
      }
      packBotState = data || { configured: true };
      updatePackBotButton();
      refreshBotAccountModal();
      if (isPackBotReady()) {
        setBotAccountStatus(`Готово: @${activePackBotUsername()}`, true);
        setTimeout(() => closeBotAccountModal(true), 280);
      } else {
        setBotAccountStatus(`Токен сохранён. Нажми /start в @${activePackBotUsername()}, потом проверь ещё раз.`);
      }
    } catch (e) {
      setBotAccountStatus("Сеть: " + (e && e.message ? e.message : "ошибка"));
    } finally {
      saveBtn && (saveBtn.disabled = false);
    }
  }

  async function deletePackBotFromModal() {
    const delBtn = $("bot-account-delete");
    delBtn && (delBtn.disabled = true);
    try {
      const r = await fetch("/api/pack_bot/delete", {
        method: "POST",
        headers: apiHeaders(),
      });
      if (r.ok) {
        packBotState = { configured: false };
        updatePackBotButton();
        refreshBotAccountModal();
        setBotAccountStatus("Настройка сброшена");
      } else {
        setBotAccountStatus("Не получилось сбросить");
      }
    } catch (e) {
      setBotAccountStatus("Сеть: " + (e && e.message ? e.message : "ошибка"));
    } finally {
      delBtn && (delBtn.disabled = false);
    }
  }

  async function ensurePackBotConfigured() {
    return true;
  }

  window.SWEX_OPEN_PACK_BOT_MODAL = () => openBotAccountModal();
  packBotBtn?.addEventListener("click", () => openBotAccountModal());
  packBotSettingsBtn?.addEventListener("click", () => openBotAccountModal());
  document.addEventListener("click", (e) => {
    const target = e.target && e.target.closest ? e.target.closest("#pack-bot-settings-btn") : null;
    if (!target) return;
    e.preventDefault();
    openBotAccountModal();
  });
  $("bot-account-save")?.addEventListener("click", savePackBotFromModal);
  $("bot-account-delete")?.addEventListener("click", deletePackBotFromModal);
  $("bot-account-cancel")?.addEventListener("click", () => closeBotAccountModal(false));
  botAccountRecheck?.addEventListener("click", async () => {
    botAccountRecheck.disabled = true;
    setBotAccountStatus("Проверяю /start…");
    try {
      await loadPackBotStatus(true);
      refreshBotAccountModal();
      if (isPackBotReady()) {
        setBotAccountStatus(`Готово: @${activePackBotUsername()}`, true);
        setTimeout(() => closeBotAccountModal(true), 260);
      } else {
        setBotAccountStatus(`Пока не вижу /start. Открой @${activePackBotUsername()} и нажми /start.`);
      }
    } finally {
      botAccountRecheck.disabled = false;
    }
  });
  $("bot-account-modal")?.addEventListener("click", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("bot-account-backdrop")) {
      closeBotAccountModal(false);
    }
  });

  function maybePromptPackBotOnBoot() {
    if (botAccountPromptedOnBoot || isPackBotReady()) return;
    botAccountPromptedOnBoot = true;
    setStatus(
      packBotState && packBotState.configured
        ? `Нажми /start в @${activePackBotUsername()}, чтобы создавать паки.`
        : "Укажи токен бота, чтобы создавать паки."
    );
    setTimeout(() => openBotAccountModal(), 420);
  }

  // ── Generate (HTTP API вместо sendData) ────
  $("generate").addEventListener("click", async () => {
    const initData = tg?.initData || "";
    if (!initData) {
      setStatus("Открой через Telegram (нет initData)"); return;
    }
    // Когда в паке только паспорт(ы) — глобальный ник/лого не применяется
    // ни к одному тайлу. Валидацию пропускаем.
    const ids = (state.pricing && state.pricing.passport_ids) || [];
    const onlyPassports = state.selected.size > 0
      && [...state.selected].every(x => ids.includes(String(x)));
    const hasContent = state.global.kind === "text"
                    || (state.global.kind === "logo" && (
                         state.global.logo_svg_b64 || state.global.logo_png_b64
                       ));
    const hasTileContent = Object.values(state.perEmoji || {}).some(t => t && (
      (typeof t.text === "string" && t.text.trim())
      || !!t.logo_svg_b64
      || !!t.logo_png_b64
    ));
    if (!onlyPassports && !hasContent && !hasTileContent) {
      setStatus("Сначала введи текст или загрузи лого."); return;
    }
    // Перед стартом сборки спрашиваем имя пака (то, что будет перед "by @bot").
    // Дефолт — текущий ник или прошлый pack_title из localStorage.
    const defaultName =
      (state.global.kind === "text" && (state.global.text.trim() || DEFAULT_BRAND_TEXT))
      || (localStorage.getItem("pack_title") || "")
      || "";
    const botReady = await ensurePackBotConfigured();
    if (!botReady) return;
    openNameModal(defaultName, (packName) => {
      try { localStorage.setItem("pack_title", packName); } catch (_) {}
      runBuild(packName);
    });
  });

  async function runBuild(packName) {
    const initData = tg?.initData || "";
    // Чистим transformы без изменений
    const transforms = {};
    Object.keys(state.perEmoji).forEach(k => {
      const t = state.perEmoji[k];
      if (isTransformChanged(t)) {
        const entry = {
          scale:    +(clampScale(t.scale).toFixed(3)),
          offset_x: +t.offset_x,
          offset_y: +t.offset_y,
          rotation: +((t.rotation || 0).toFixed(3)),
          content_color: normalizeHexColor(t.content_color),
        };
        if (hasFiniteAnchorValue(t.anchor_x) && hasFiniteAnchorValue(t.anchor_y)) {
          entry.anchor_x = +(+t.anchor_x).toFixed(2);
          entry.anchor_y = +(+t.anchor_y).toFixed(2);
          if (t.replace_part) entry.replace_part = true;
        }
        if (hasLinesEdit(t.lines)) {
          entry.lines = t.lines
            .map(l => ({
              name:     String(l.name || ""),
              text:     String(l.text || "").slice(0, 30),
              scale:    +(((typeof l.scale === "number") ? l.scale : 1).toFixed(3)),
              color:    String(l.color || "#000000"),
              offset_x: +((typeof l.offset_x === "number") ? l.offset_x : 0),
              offset_y: +((typeof l.offset_y === "number") ? l.offset_y : 0),
            }))
            .filter(l => l.name && (
              l.text.trim() !== ""
              || Math.abs(l.scale - 1) > 1e-3
              || l.color.toLowerCase() !== "#000000"
              || Math.abs(l.offset_x) > 1e-6
              || Math.abs(l.offset_y) > 1e-6
            ));
        }
        if (t.photo_png_b64) {
          entry.photo_png_b64 = String(t.photo_png_b64);
        } else if (t.photo_svg_b64) {
          entry.photo_svg_b64 = String(t.photo_svg_b64);
        }
        if ((t.photo_svg_b64 || t.photo_png_b64) && normalizeHexColor(t.photo_color || "#ffffff") !== "#ffffff") {
          entry.photo_color = normalizeHexColor(t.photo_color);
        }
        if ((t.photo_svg_b64 || t.photo_png_b64) && Math.abs((t.photo_scale || 1) - 1) > 1e-3) {
          entry.photo_scale = +clampPhotoScale(t.photo_scale).toFixed(3);
        }
        const textGradient = activeTextGradient(t.text_gradient);
        if (textGradient) {
          entry.text_gradient = textGradient;
        }
        const font = effectiveFontKey(t.font);
        if (t.font && font !== effectiveFontKey(state.global.font)) {
          entry.font = font;
        }
        const tileText = (typeof t.text === "string" ? t.text.trim() : "");
        if (t.logo_png_b64 && t.kind === "logo") {
          entry.kind = "logo";
          entry.logo_png_b64 = String(t.logo_png_b64);
        } else if (t.logo_svg_b64 && t.kind === "logo") {
          entry.kind = "logo";
          entry.logo_svg_b64 = String(t.logo_svg_b64);
        } else if (tileText) {
          entry.kind = "text";
          entry.text = tileText.slice(0, 30);
        }
        // Per-tile palette overrides — old hex → solid color or gradient.
        // Normalised once here so the server only has to validate.
        if (hasColorRemap(t.color_remap)) {
          const clean = {};
          for (const ok in t.color_remap) {
            const from = normalizeHexColor(ok);
            const spec = normalizeLayerColorSpec(t.color_remap[ok], from);
            const payload = layerColorSpecPayload(spec, from);
            if (payload) clean[from] = payload;
          }
          if (Object.keys(clean).length) entry.color_remap = clean;
        }
        transforms[k] = entry;
      }
    });
    // For sticker mode, validate selection count before sending.
    if (state.format === "sticker") {
      if (state.selected.size === 0) {
        setStatus("Выбери хотя бы один стикер");
        return;
      }
      if (state.selected.size > STICKER_LIMIT) {
        const cta = $("generate");
        cta.classList.add("limit-warn");
        setTimeout(() => cta.classList.remove("limit-warn"), 600);
        setStatus(`Слишком много (${state.selected.size}) — макс ${STICKER_LIMIT}`);
        return;
      }
    }
    // Always send the selection — pricing is based on count + passport.
    const selected = Array.from(state.selected).map(String);
    const payload = {
      format:     state.format,
      global:     {
        kind:         state.global.kind,
        text:         state.global.kind === "text"
                        ? (state.global.text.trim() || DEFAULT_BRAND_TEXT)
                        : "",
        logo_svg_b64: state.global.logo_svg_b64 || "",
        logo_png_b64: state.global.logo_png_b64 || "",
        content_color: "#ffffff",
        content_rotation: 0,
        logo_rotation: 0,
        font: state.global.font || DEFAULT_FONT_KEY,
      },
      per_emoji:  transforms,
      selected,   // null = all (emoji mode); array of ids = sticker subset
      pack_title: String(packName || "").slice(0, 40),
    };
    setStatus("Запускаю сборку…");
    buildInFlight = true;
    $("generate").disabled = true;
    try {
      const r = await fetch("/api/build_pack", {
        method: "POST",
        headers: {
          "Content-Type":          "application/json",
          "X-Telegram-Init-Data":  initData,
        },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (data && data.need_pack_bot) {
          buildInFlight = false;
          updatePackBotButton();
          packBotState = { configured: false };
          updatePackBotButton();
          setStatus("Добавь бота для создания паков.");
          openBotAccountModal();
          return;
        }
        if (data && data.need_stars) {
          buildInFlight = false;
          $("generate").disabled = false;
          setStatus(`Не хватает ⭐: нужно ${data.needed}, у вас ${data.balance}.`);
          setView("profile");
          const ps = $("profile-status");
          if (ps) ps.textContent = `Нужно ${data.needed} ⭐, на балансе ${data.balance} ⭐. Выбери сумму пополнения.`;
          return;
        }
        if (data && data.need_pack_bot_start) {
          buildInFlight = false;
          packBotState = {
            ...(packBotState || {}),
            configured: true,
            bot_username: data.bot_username || (packBotState && packBotState.bot_username) || "",
            owner_user_id: data.owner_user_id || (packBotState && packBotState.owner_user_id) || "",
            can_message_owner: false,
            needs_start: true,
          };
          updatePackBotButton();
          setStatus(`Нажми /start в @${activePackBotUsername()}, потом снова создай пак.`);
          openBotAccountModal();
          return;
        }
        setStatus("Ошибка: " + (data.error || r.status));
        buildInFlight = false;
        updatePackBotButton();
        return;
      }
      setStatus("Перейдите к боту — сборка и прогресс там");
      setTimeout(() => tg?.close?.(), 800);
    } catch (e) {
      setStatus("Сеть: " + e.message);
      buildInFlight = false;
      updatePackBotButton();
    }
  }

  // ── Pack-name modal ─────────────────────────
  function openNameModal(defaultName, onConfirm, onCancel) {
    const m  = $("name-modal");
    const i  = $("name-modal-input");
    const c  = $("name-modal-counter");
    const p  = $("name-modal-preview-text");
    const ok = $("name-modal-ok");
    const cancel = $("name-modal-cancel");
    const botSpans = document.querySelectorAll("#name-modal-bot, .name-modal-bot2");
    const botUsername = publicPackBotUsername();
    botSpans.forEach(s => s.textContent = botUsername);
    i.value = String(defaultName || "").slice(0, 40);
    function refresh() {
      const v = i.value.slice(0, 40);
      const cleanV = v.trim();
      c.textContent = `${v.length}/40`;
      c.classList.toggle("warn", v.length >= 32 && v.length < 40);
      c.classList.toggle("full", v.length >= 40);
      p.textContent = cleanV || "имя пака";
      ok.disabled = cleanV.length === 0;
    }
    refresh();
    function close() {
      m.classList.add("hidden");
      m.classList.remove("show");
      cleanup();
    }
    function cancelModal() {
      close();
      if (typeof onCancel === "function") onCancel();
    }
    function confirm() {
      const v = i.value.trim();
      if (!v) return;
      close();
      onConfirm(v.slice(0, 40));
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); cancelModal(); }
      else if (e.key === "Enter") { e.preventDefault(); confirm(); }
    }
    function onBackdrop(e) {
      if (e.target.classList.contains("name-modal-backdrop")) cancelModal();
    }
    function cleanup() {
      i.removeEventListener("input", refresh);
      ok.removeEventListener("click", confirm);
      cancel.removeEventListener("click", cancelModal);
      m.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    }
    i.addEventListener("input", refresh);
    ok.addEventListener("click", confirm);
    cancel.addEventListener("click", cancelModal);
    m.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    m.classList.remove("hidden");
    requestAnimationFrame(() => {
      m.classList.add("show");
      i.focus();
      i.select();
    });
  }

  async function loadPricing() {
    try {
      const r = await fetch("/api/pricing");
      if (r.ok) state.pricing = await r.json();
    } catch (_) { /* keep defaults */ }
  }

  // ── My Packs view ────────────────────────────────────────────
  const packsState = {
    loaded:    false,
    loading:   false,
    items:     [],          // server response from /api/packs/list
    current:   null,        // currently-open pack detail object
    staged:    new Set(),   // tile ids queued for addition (string keys)
    overrides: new Map(),   // id -> per-tile override (from mini-editor)
    editing:   null,        // currently-edited tile id (or null)
    convertConfirm: null,   // { key, until } for the two-tap paid conversion
  };

  function apiHeaders() {
    return {
      "X-Telegram-Init-Data": tg?.initData || "",
      "Content-Type": "application/json",
    };
  }

  function invalidateEmojiSurfaces() {
    stripBuilt = false;
    if (previewStrip) previewStrip.replaceChildren();
    if (emojiPickerObserver && emojiPickerGrid) {
      emojiPickerGrid.querySelectorAll(".emoji-picker-cell").forEach(cell => {
        try { emojiPickerObserver.unobserve(cell); } catch (_) {}
      });
    }
    if (emojiPickerGrid) emojiPickerGrid.replaceChildren();
    emojiPickerBuilt = false;
    emojiPickerOpen = false;
    if (emojiPickerPanel) emojiPickerPanel.classList.add("hidden");
    refreshCounterOpenState();
  }

  let uploadPollTimer = 0;
  function setUploadModal(open) {
    if (!uploadModal) return;
    uploadModal.classList.toggle("hidden", !open);
    uploadModal.classList.toggle("show", !!open);
  }
  function setUploadStatusText(text, tone) {
    if (uploadStatus) {
      uploadStatus.textContent = text || "";
      uploadStatus.dataset.tone = tone || "";
    }
    if (uploadHint && text) uploadHint.textContent = text;
  }
  async function absorbUploadedEmoji(item) {
    await loadUploads();
    const id = item && item.id;
    invalidateEmojiSurfaces();
    rebuildPreviewStrip();
    if (id && fileById(id)) {
      if (!state.selected.has(id) && state.selected.size < currentLimit()) {
        state.selected.add(id);
      }
      updateSelectionUI();
      rebuildGridSelectionState();
      await selectId(id);
    }
  }
  async function pollUploadStatus() {
    try {
      const r = await fetch("/api/uploads/status", { headers: apiHeaders() });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.status);
      if (data.status === "ready" && data.upload) {
        if (uploadPollTimer) clearInterval(uploadPollTimer);
        uploadPollTimer = 0;
        setUploadStatusText("Готово. Добавляю в каталог...", "ok");
        await absorbUploadedEmoji(data.upload);
        setTimeout(() => setUploadModal(false), 650);
      } else if (data.status === "error" || data.status === "expired") {
        if (uploadPollTimer) clearInterval(uploadPollTimer);
        uploadPollTimer = 0;
        setUploadStatusText(data.error || "Не удалось принять файл.", "err");
      } else {
        setUploadStatusText("Жду эмодзи в чате с ботом...", "");
      }
    } catch (e) {
      setUploadStatusText("Пока не вижу загрузку. Вернись после отправки эмодзи.", "");
    }
  }
  async function startCustomUpload() {
    setView("editor");
    setUploadModal(true);
    setUploadStatusText("Готовлю бота к загрузке...", "");
    try {
      const r = await fetch("/api/uploads/start", {
        method: "POST",
        headers: apiHeaders(),
        body: "{}",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.status);
      setUploadStatusText("Сверни миниапку и отправь боту premium emoji, animated sticker или .tgs.", "");
      if (uploadPollTimer) clearInterval(uploadPollTimer);
      uploadPollTimer = setInterval(pollUploadStatus, 1400);
      pollUploadStatus();
    } catch (e) {
      setUploadStatusText("Открой редактор из Telegram, чтобы бот понял, чей файл ждать.", "err");
    }
  }
  addEmojiBtn?.addEventListener("click", startCustomUpload);
  uploadClose?.addEventListener("click", () => setUploadModal(false));
  uploadCancel?.addEventListener("click", async () => {
    if (uploadPollTimer) clearInterval(uploadPollTimer);
    uploadPollTimer = 0;
    try {
      await fetch("/api/uploads/cancel", {
        method: "POST",
        headers: apiHeaders(),
        body: "{}",
      });
    } catch (_) {}
    setUploadModal(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadUploads().then(() => {
        invalidateEmojiSurfaces();
        rebuildPreviewStrip();
      }).catch(() => {});
      if (uploadModal && !uploadModal.classList.contains("hidden")) pollUploadStatus();
    }
  });

  function setView(name) {
    const home   = $("view-home");
    const editor = $("view-editor");
    const icons  = $("view-icons");
    const packs  = $("view-packs");
    const profile = $("view-profile");
    const target = name === "home" || name === "icons" || name === "packs" || name === "profile" ? name : "editor";
    document.body.classList.toggle("home-mode", target === "home");
    document.querySelectorAll(".topbar-tab").forEach(b => {
      b.classList.toggle("active", b.dataset.view === target);
    });
    if (target === "home") {
      if (home) home.classList.remove("hidden");
      editor.classList.add("hidden");
      if (icons) icons.classList.add("hidden");
      if (packs) packs.classList.add("hidden");
      if (profile) profile.classList.add("hidden");
    } else if (target === "profile") {
      if (home) home.classList.add("hidden");
      editor.classList.add("hidden");
      if (icons) icons.classList.add("hidden");
      if (packs) packs.classList.add("hidden");
      if (profile) profile.classList.remove("hidden");
      loadProfile();
    } else if (target === "packs") {
      if (home) home.classList.add("hidden");
      editor.classList.add("hidden");
      if (icons) icons.classList.add("hidden");
      packs.classList.remove("hidden");
      loadPacksIfNeeded();
    } else if (target === "icons") {
      if (home) home.classList.add("hidden");
      editor.classList.add("hidden");
      packs.classList.add("hidden");
      if (profile) profile.classList.add("hidden");
      if (icons) icons.classList.remove("hidden");
      lockTelegramVerticalSwipes();
    } else {
      if (home) home.classList.add("hidden");
      packs.classList.add("hidden");
      if (icons) icons.classList.add("hidden");
      if (profile) profile.classList.add("hidden");
      editor.classList.remove("hidden");
    }
  }

  document.querySelectorAll(".topbar-tab").forEach(b => {
    b.addEventListener("click", () => {
      if (b.dataset.view === "icons") resetIconsFrameDefault();
      setView(b.dataset.view);
    });
  });
  document.querySelectorAll("[data-swex-open]").forEach(b => {
    b.addEventListener("click", () => {
      const view = b.dataset.swexOpen || "home";
      if (view === "icons") resetIconsFrameDefault();
      setView(view);
      if (view !== "home") window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data || {};
    if (data.type === "swex-close-webapp") {
      [0, 120, 420].forEach((delay) => {
        setTimeout(() => {
          try { tg?.close?.(); } catch (_) {}
          try { window.Telegram?.WebApp?.close?.(); } catch (_) {}
        }, delay);
      });
      return;
    }
    if (data.type === "swex-disable-vertical-swipes") {
      try { tg?.disableVerticalSwipes?.(); } catch (_) {}
      try { window.Telegram?.WebApp?.disableVerticalSwipes?.(); } catch (_) {}
      return;
    }
    if (data.type === "swex-icons-request-pack-name") {
      const source = event.source;
      const requestId = String(data.requestId || "");
      (async () => {
        const botReady = await ensurePackBotConfigured();
        if (!botReady) {
          try {
            source?.postMessage({
              type: "swex-icons-pack-name",
              requestId,
              cancelled: true,
            }, event.origin);
          } catch (_) {}
          return;
        }
        openNameModal(String(data.defaultName || "LeanHustle Icons").slice(0, 40), (packName) => {
          try { localStorage.setItem("icon_pack_title", packName); } catch (_) {}
          try {
            source?.postMessage({
              type: "swex-icons-pack-name",
              requestId,
              packName,
            }, event.origin);
          } catch (_) {}
        }, () => {
          try {
            source?.postMessage({
              type: "swex-icons-pack-name",
              requestId,
              cancelled: true,
            }, event.origin);
          } catch (_) {}
        });
      })().catch(() => {
        try {
          source?.postMessage({
            type: "swex-icons-pack-name",
            requestId,
            cancelled: true,
          }, event.origin);
        } catch (_) {}
      });
      return;
    }
    if (data.type === "swex-icons-add-done") {
      const packId = Number(data.packId || 0);
      (async () => {
        packsState.loaded = false;
        setView("packs");
        await loadPacksIfNeeded(true);
        if (packId) await openPack(packId);
      })().catch((e) => console.error("[icons] add done refresh failed", e));
      return;
    }
    if (data.type !== "swex-icons-height") return;
    const frame = $("icons-frame");
    const height = Math.max(520, Math.min(6000, Number(data.height) || 0));
    if (frame) frame.style.height = `${height}px`;
  });

  async function loadPacksIfNeeded(force = false) {
    if (packsState.loading) return;
    if (packsState.loaded && !force) return;
    packsState.loading = true;
    const list = $("packs-list");
    list.innerHTML = '<div class="packs-skel">Загружаю…</div>';
    try {
      const r = await fetch("/api/packs/list", { headers: apiHeaders() });
      if (!r.ok) throw new Error("http " + r.status);
      packsState.items = await r.json();
      packsState.loaded = true;
      renderPacksList();
    } catch (e) {
      list.innerHTML = `<div class="packs-skel">Ошибка загрузки: ${e.message}</div>`;
    } finally {
      packsState.loading = false;
    }
  }

  function updatePacksCountBadge() {
    const badge = $("packs-count-badge");
    if (!badge) return;
    const n = packsState.items.length;
    badge.textContent = n;
    badge.classList.toggle("hidden", n === 0);
  }

  function renderPacksList() {
    const list = $("packs-list");
    const empty = $("packs-empty");
    const head  = $("packs-head-count");
    updatePacksCountBadge();
    if (!packsState.items.length) {
      list.innerHTML = "";
      list.classList.add("hidden");
      empty.classList.remove("hidden");
      head.textContent = "0";
      return;
    }
    list.classList.remove("hidden");
    empty.classList.add("hidden");
    head.textContent = packsState.items.length + (
      packsState.items.length === 1 ? " пак" : " пак(а/ов)"
    );
    list.innerHTML = "";
    packsState.items.forEach(p => list.appendChild(makePackCard(p)));
  }

  function iconPackPreviewPath(item) {
    const icon = item && item.icon || {};
    if (icon.path) return String(icon.path);
    return "M17.8 5H9.2L5.5 8.9l4 3.1h5.3l-7.6 7H16l3.7-3.8-4-3.2h-5.3L17.8 5Z";
  }

  function renderIconPackThumb(el, item) {
    const design = item && item.design || {};
    const icon = item && item.icon || {};
    el.classList.add("icon-pack-thumb");
    if (icon.svg) el.classList.add("is-custom");
    el.style.setProperty("--ip-bg1", normalizeHexColor(design.bg1 || "#f6f8ff"));
    el.style.setProperty("--ip-bg2", normalizeHexColor(design.bg2 || "#bdc7d8"));
    el.style.setProperty("--ip-ring", normalizeHexColor(design.ring || "#ffffff"));
    el.style.setProperty("--ip-icon", normalizeHexColor(design.iconColor || "#090a0c"));
    if (icon.svg) {
      const viewBox = escapeHtml(icon.viewBox || "0 0 24 24");
      el.innerHTML = `<svg viewBox="${viewBox}" aria-hidden="true">${icon.svg}</svg>`;
    } else {
      const path = escapeHtml(iconPackPreviewPath(item));
      el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
    }
  }

  function openTelegramPackLink(link) {
    if (!link) return;
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(link);
      return;
    }
    window.open(link, "_blank", "noopener");
  }

  function isIconPack(pack) {
    return !!pack && (
      pack.pack_type === "icons"
      || (pack.icon_pack && Array.isArray(pack.icon_pack.items))
      || (Array.isArray(pack.icon_preview) && pack.icon_preview.length > 0)
    );
  }

  function iconPackItems(pack) {
    const data = pack && pack.icon_pack && Array.isArray(pack.icon_pack.items)
      ? pack.icon_pack.items
      : (pack && Array.isArray(pack.icon_preview) ? pack.icon_preview : []);
    return data.filter(item => item && typeof item === "object");
  }

  function iconPackExistingIds(pack) {
    const ids = new Set();
    iconPackItems(pack).forEach(item => {
      if (item && item.id != null) ids.add(String(item.id));
    });
    (pack && pack.included || []).forEach(raw => {
      const s = String(raw);
      ids.add(s.startsWith("icon:") ? s.slice(5) : s);
    });
    return ids;
  }

  function iconPackCount(pack) {
    return iconPackExistingIds(pack).size || iconPackItems(pack).length || 0;
  }

  function iconPackPrice() {
    const _iap = state.pricing ? (state.pricing.icon_addition_price_rub ?? state.pricing.addition_price_rub) : 0; return Number(_iap) || 0;
  }

  function setIconsFrameSrc(src) {
    const frame = $("icons-frame");
    if (!frame) return;
    const current = frame.getAttribute("src") || "";
    if (current !== src) frame.setAttribute("src", src);
  }

  function resetIconsFrameDefault() {
    setIconsFrameSrc("/static/icons.html?v=18");
  }

  function openIconAppendEditor(pack) {
    if (!isIconPack(pack)) return;
    const existing = Array.from(iconPackExistingIds(pack));
    const params = new URLSearchParams({
      mode: "append",
      pack_id: String(pack.id),
      title: String(pack.title || "LeanHustle Icons").slice(0, 40),
      format: pack.format === "sticker" ? "sticker" : "emoji",
      cap: String(pack.cap || (pack.format === "sticker" ? STICKER_LIMIT : EMOJI_LIMIT)),
      existing: existing.join(","),
      add_price: String(iconPackPrice()),
    });
    setIconsFrameSrc(`/static/icons.html?v=18&${params.toString()}`);
    setView("icons");
  }

  function makePackCard(pack) {
    const card = document.createElement("div");
    card.className = "pack-card";
    card.dataset.id = String(pack.id);

    const thumbs = document.createElement("div");
    thumbs.className = "pack-card-thumbs";
    const iconMode = isIconPack(pack);
    const first4 = iconMode ? iconPackItems(pack).slice(0, 4) : pack.included.slice(0, 4);
    for (let i = 0; i < 4; i++) {
      const t = document.createElement("div");
      t.className = "pack-card-thumb";
      const id = first4[i];
      if (iconMode && id != null) {
        renderIconPackThumb(t, id);
      } else if (id != null) {
        const anim = document.createElement("div");
        anim.className = "pct-anim";
        t.appendChild(anim);
        const fb = document.createElement("span");
        fb.className = "pct-fallback";
        const f = fileById(id);
        fb.textContent = f ? (f.emoji || "·") : "·";
        t.appendChild(fb);
        // Stash params on the thumb element; lazy observer renders on view.
        t._pctPack = pack;
        t._pctId = id;
        ensurePctObserver().observe(t);
      }
      thumbs.appendChild(t);
    }
    card.appendChild(thumbs);

    const info = document.createElement("div");
    info.className = "pack-card-info";
    const title = document.createElement("div");
    title.className = "pack-card-title";
    title.textContent = pack.title || "(без названия)";
    info.appendChild(title);
    const suffix = document.createElement("div");
    suffix.className = "pack-card-suffix";
    suffix.textContent = "by @" + publicPackBotUsername();
    info.appendChild(suffix);
    const meta = document.createElement("div");
    meta.className = "pack-card-meta";
    const badge = document.createElement("span");
    badge.className = "pack-card-badge format-" + (iconMode ? "icons" : (pack.format || "emoji"));
    badge.textContent = iconMode ? "Иконки" : (pack.format === "sticker" ? "Стикер" : "Эмодзи");
    meta.appendChild(badge);
    const cnt = document.createElement("span");
    cnt.textContent = `${pack.count}/${pack.cap}`;
    meta.appendChild(cnt);
    info.appendChild(meta);
    card.appendChild(info);

    const chev = document.createElement("div");
    chev.className = "pack-card-chev";
    chev.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">'
      + '<path d="M9 5 L16 12 L9 19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>';
    card.appendChild(chev);

    card.addEventListener("click", () => {
      openPack(pack.id);
    });
    return card;
  }

  function botUsernameGuess(pack) {
    // short_name ends with "_by_<bot_username>" by build_pack convention.
    const m = (pack && pack.short_name || "").match(/_by_([A-Za-z0-9_]+)$/);
    return m ? m[1] : "";
  }

  // Lazy-render the 4 mini-thumbs on each pack card. Tile is rendered with
  // pack.global + per_emoji baseline so the user sees how the pack actually
  // looks (nick / logo / colors / transforms) — not the bare master.
  let pctObserver = null;
  function ensurePctObserver() {
    if (pctObserver) return pctObserver;
    pctObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const el = e.target;
          pctObserver.unobserve(el);
          renderPackCardThumb(el);
        }
      }
    }, { rootMargin: "200px" });
    return pctObserver;
  }

  async function renderPackCardThumb(thumb) {
    if (thumb._pctLoaded) return;
    thumb._pctLoaded = true;
    const pack = thumb._pctPack;
    const id   = thumb._pctId;
    if (!pack || id == null) return;
    try {
      const data = await loadLottie(id);
      const container = thumb.querySelector(".pct-anim");
      if (!container) return;
      let animationData;
      if (window.SwexReplacer) {
        try {
          const eff = packTileEffectiveOverride(id, pack);
          await loadFontKey(eff.font, fontTextForOverride(eff));
          animationData = SwexReplacer.applyToLottie(data, eff);
        } catch (e) {
          console.error("[packs] card applyToLottie failed:", e);
          animationData = JSON.parse(JSON.stringify(data));
        }
      } else {
        animationData = JSON.parse(JSON.stringify(data));
      }
      // SVG renderer keeps the nick/logo crisp at thumbnail sizes — canvas
      // rasterises and small glyphs turn into mush.
      const anim = lottie.loadAnimation({
        container,
        renderer: "svg",
        loop: false,
        autoplay: false,
        animationData,
      });
      anim.addEventListener("DOMLoaded", () => {
        anim.goToAndStop(0, true);
        const fb = thumb.querySelector(".pct-fallback");
        if (fb) fb.style.display = "none";
      });
    } catch (e) {
      console.error("[packs] pack card thumb failed for", id, e);
    }
  }

  async function openPack(id) {
    packsState.staged.clear();
    packsState.overrides.clear();
    packsState.editing = null;
    closeTileEdit();  // make sure editor isn't visible if user re-enters
    $("packs-list-view").classList.add("hidden");
    $("pack-detail-view").classList.remove("hidden");
    setPdStatus("Загружаю пак…");
    try {
      const r = await fetch(`/api/packs/${id}`, { headers: apiHeaders() });
      if (!r.ok) throw new Error("http " + r.status);
      const pack = await r.json();
      packsState.current = pack;
      renderPackDetail(pack);
      setPdStatus("");
    } catch (e) {
      setPdStatus("Не удалось загрузить пак: " + e.message);
    }
  }

  function backToPacksList() {
    $("pack-detail-view").classList.add("hidden");
    $("packs-list-view").classList.remove("hidden");
    packsState.current = null;
  }

  $("pd-back").addEventListener("click", backToPacksList);
  $("pd-template")?.addEventListener("click", useCurrentPackTemplate);
  $("pd-convert")?.addEventListener("click", convertCurrentPack);

  function setPdStatus(msg) {
    const el = $("pd-status");
    if (el) el.textContent = msg || "";
  }

  function setPdTemplateStatus(msg, type) {
    const el = $("pd-template-status");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("ok", type === "ok");
    el.classList.toggle("err", type === "err");
  }

  function setPdConvertStatus(msg, type) {
    const el = $("pd-convert-status");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("ok", type === "ok");
    el.classList.toggle("err", type === "err");
  }

  function cloneJson(value, fallback) {
    if (value == null) return fallback;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  function cloneTemplateTransform(raw) {
    const src = cloneJson(raw, {}) || {};
    const t = defaultTransform();
    if ("scale" in src) t.scale = clampScale(src.scale);
    if ("offset_x" in src) t.offset_x = +src.offset_x || 0;
    if ("offset_y" in src) t.offset_y = +src.offset_y || 0;
    if (hasFiniteAnchorValue(src.anchor_x)) t.anchor_x = +src.anchor_x;
    if (hasFiniteAnchorValue(src.anchor_y)) t.anchor_y = +src.anchor_y;
    if (src.replace_part) t.replace_part = true;
    if ("rotation" in src) t.rotation = +src.rotation || 0;
    if ("content_color" in src) t.content_color = normalizeHexColor(src.content_color);
    if (Array.isArray(src.lines)) {
      t.lines = src.lines
        .filter(l => l && typeof l === "object" && l.name)
        .map(l => ({
          name: String(l.name || ""),
          text: String(l.text || ""),
          scale: typeof l.scale === "number" ? l.scale : (+l.scale || 1),
          color: normalizeHexColor(l.color || "#000000"),
          offset_x: typeof l.offset_x === "number" ? l.offset_x : (+l.offset_x || 0),
          offset_y: typeof l.offset_y === "number" ? l.offset_y : (+l.offset_y || 0),
        }));
    }
    if (src.photo_svg_b64) t.photo_svg_b64 = String(src.photo_svg_b64);
    else if (src.photo_png_b64) t.photo_png_b64 = String(src.photo_png_b64);
    if (src.photo_scale != null) t.photo_scale = clampPhotoScale(src.photo_scale);
    if (src.photo_color) t.photo_color = normalizeHexColor(src.photo_color);
    const gradient = normalizeTextGradient(src.text_gradient);
    t.text_gradient = gradient.enabled ? gradient : null;
    if (src.font) t.font = effectiveFontKey(src.font);
    if (src.pack_style && packStyleByKey(src.pack_style)) t.pack_style = String(src.pack_style);
    if (hasColorRemap(src.color_remap)) {
      t.color_remap = cloneJson(src.color_remap, null);
    }
    return t;
  }

  function normalizeTemplateTileId(raw) {
    const s = String(raw);
    if (s.startsWith("new:")) return fileById(s) ? s : null;
    if (s.startsWith("upload:")) return fileById(s) ? s : null;
    if (/^\d+$/.test(s)) {
      const n = +s;
      return fileById(n) ? n : null;
    }
    return null;
  }

  function makeTemplateSelection(pack) {
    const out = new Set();
    (pack.included || []).forEach(raw => {
      const id = normalizeTemplateTileId(raw);
      if (id != null) out.add(id);
    });
    if (out.size) return out;
    return pack.format === "sticker"
      ? pickDefaultStickerSelection()
      : pickDefaultSelection(DEFAULT_EMOJI_SELECTION);
  }

  function makeTemplateTransforms(pack) {
    const out = {};
    const per = pack.template_per_emoji || pack.per_emoji || {};
    const perNew = pack.template_new_per_emoji || pack.new_per_emoji || {};
    const perUpload = pack.template_upload_per_emoji || pack.upload_per_emoji || {};
    Object.entries(per).forEach(([key, value]) => {
      const id = normalizeTemplateTileId(key);
      if (id != null) out[id] = cloneTemplateTransform(value);
    });
    Object.entries(perNew).forEach(([key, value]) => {
      const id = String(key).startsWith("new:") ? String(key) : `new:${key}`;
      if (fileById(id)) out[id] = cloneTemplateTransform(value);
    });
    Object.entries(perUpload).forEach(([key, value]) => {
      const id = String(key).startsWith("upload:") ? String(key) : `upload:${key}`;
      if (fileById(id)) out[id] = cloneTemplateTransform(value);
    });
    return out;
  }

  function renderIconPackDetailGrid(pack) {
    const grid = $("pd-grid");
    grid.innerHTML = "";
    const items = iconPackItems(pack);
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "pd-grid-empty";
      empty.innerHTML = "<b>Пак иконок пуст.</b><br>Добавь иконки через редактор.";
      grid.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const cell = document.createElement("div");
      cell.className = "pd-cell in-pack icon-detail-cell";
      cell.dataset.id = String(item.id || index + 1);
      const thumb = document.createElement("div");
      thumb.className = "pack-card-thumb";
      renderIconPackThumb(thumb, item);
      cell.appendChild(thumb);
      const idx = document.createElement("span");
      idx.className = "pd-idx";
      idx.textContent = String(index + 1);
      cell.appendChild(idx);
      grid.appendChild(cell);
    });
  }

  function updateIconPackAddButton(pack) {
    const wrap = $("pd-add-wrap");
    const btn = $("pd-add");
    const chip = $("pd-stage-chip");
    if (chip) chip.classList.add("hidden");
    const count = iconPackCount(pack);
    const cap = pack && pack.cap || EMOJI_LIMIT;
    const slack = Math.max(0, cap - count);
    if (!wrap || !btn) return;
    wrap.classList.toggle("hidden", slack <= 0);
    btn.disabled = slack <= 0;
    btn.textContent = slack > 0
      ? (iconPackPrice() > 0 ? `Добавить иконки · ${iconPackPrice()}₽/шт` : "Добавить иконки")
      : "Пак заполнен";
  }

  async function useCurrentPackTemplate() {
    const pack = packsState.current;
    if (!pack) return;
    const btn = $("pd-template");
    if (btn) btn.disabled = true;
    setPdTemplateStatus("Переношу настройки...", "");
    try {
      const g = pack.global || {};
      const kind = g.kind === "logo" ? "logo" : "text";
      state.global = {
        kind,
        text: "",
        logo_svg_b64: "",
        content_rotation: 0,
        content_color: normalizeHexColor(g.content_color || "#ffffff"),
        font: effectiveFontKey(g.font || DEFAULT_FONT_KEY),
      };
      state.mode = kind;
      state.format = pack.format === "sticker" ? "sticker" : "emoji";
      document.querySelectorAll(".fmt-seg .seg-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.format === state.format);
      });
      state.selected = makeTemplateSelection(pack);
      state.perEmoji = makeTemplateTransforms(pack);
      state.passportRevealed = false;
      applyStickerMode();
      setView("editor");
      const firstId = state.selected.size
        ? Array.from(state.selected)[0]
        : (allFiles()[0] && allFiles()[0].id);
      if (firstId != null) {
        await selectId(firstId);
      } else {
        loadEditorFromState();
        updateSelectionUI();
      }
      const hint = kind === "logo"
        ? "Шаблон применён. Загрузи новый логотип."
        : "Шаблон применён. Введи новый ник.";
      setStatus(hint);
      setPdTemplateStatus("Шаблон перенесён в редактор", "ok");
    } catch (e) {
      console.error("[packs] template apply failed", e);
      setPdTemplateStatus("Не получилось применить шаблон", "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderPackDetail(pack) {
    const iconMode = isIconPack(pack);
    $("pd-title").textContent = pack.title || "(без названия)";
    const suffix = "by @" + publicPackBotUsername();
    $("pd-suffix").textContent = suffix;
    $("pd-open").href = pack.link || "#";
    $("pd-format").textContent = pack.format === "sticker" ? "Стикер-пак" : "Эмодзи-пак";
    $("pd-have").textContent = iconMode ? iconPackCount(pack) : pack.included.length;
    $("pd-cap").textContent  = pack.cap;
    setPdTemplateStatus("", "");
    setPdConvertStatus("", "");
    $("pd-convert")?.closest(".pd-convert-box")?.classList.toggle("hidden", iconMode);
    $("pd-template")?.closest(".pd-template-box")?.classList.toggle("hidden", iconMode);
    if (iconMode) {
      packsState.staged.clear();
      packsState.overrides.clear();
      $("pd-format").textContent = "Иконки";
      updateIconPackAddButton(pack);
      renderIconPackDetailGrid(pack);
    } else {
      updatePackConvertButton(pack);
      updateStagedChip();
      renderPackGrid(pack);
    }
  }

  function conversionTargetFormat(pack) {
    return pack && pack.format === "sticker" ? "emoji" : "sticker";
  }

  function packIncludedCount(pack) {
    if (!pack) return 0;
    if (Array.isArray(pack.included)) return pack.included.length;
    const n = Number(pack.count ?? pack.included_count ?? pack.have ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function updatePackConvertButton(pack) {
    const btn = $("pd-convert");
    const title = $("pd-convert-title");
    const sub = $("pd-convert-sub");
    if (!btn || !title || !sub) return;
    const target = conversionTargetFormat(pack);
    const price = +(state.pricing && state.pricing.conversion_price_rub) || 0;
    const count = packIncludedCount(pack);
    const parts = target === "sticker" ? Math.max(1, Math.ceil(count / STICKER_LIMIT)) : 1;
    title.textContent = target === "sticker"
      ? "Сделать стикеры"
      : "Сделать эмодзи";
    sub.textContent = target === "sticker" && parts > 1
      ? `${count} ⭐ · ${parts} пака`
      : `${count} ⭐ · ссылка придёт в бота`;
    btn.disabled = !pack;
  }

  async function convertCurrentPack() {
    const pack = packsState.current;
    if (!pack) return;
    const btn = $("pd-convert");
    const target = conversionTargetFormat(pack);
    const price = +(state.pricing && state.pricing.conversion_price_rub) || 0;
    const targetLabel = target === "sticker" ? "стикер-пак" : "эмодзи-пак";
    const count = packIncludedCount(pack);
    const parts = target === "sticker"
      ? Math.max(1, Math.ceil(count / STICKER_LIMIT))
      : 1;
    const confirmKey = `${pack.id}:${target}:${count}`;
    const now = Date.now();
    if (!packsState.convertConfirm
        || packsState.convertConfirm.key !== confirmKey
        || packsState.convertConfirm.until < now) {
      packsState.convertConfirm = { key: confirmKey, until: now + 4500 };
      const label = parts > 1 ? `${parts} стикер-пака` : targetLabel;
      setPdConvertStatus(price > 0 ? `Ещё раз нажми: ${label} за ${price}₽` : `Ещё раз нажми: ${label} (бесплатно)`, "ok");
      try { tg?.HapticFeedback?.impactOccurred?.("light"); } catch (_) {}
      return;
    }
    packsState.convertConfirm = null;
    if (btn) btn.disabled = true;
    setPdConvertStatus("Создаю пак…", "");
    try {
      const r = await fetch(`/api/packs/${pack.id}/convert`, {
        method: "POST",
        headers: apiHeaders(),
        body: "{}",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ("http " + r.status));
      const suffix = data.parts && data.parts > 1 ? ` (${data.parts} части)` : "";
      setPdConvertStatus(`Запущено${suffix}. Ссылка придёт в бота.`, "ok");
      setTimeout(() => setPdConvertStatus("", ""), 5000);
    } catch (e) {
      setPdConvertStatus("Ошибка: " + e.message, "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function updateStagedChip() {
    const chip = $("pd-stage-chip");
    const cnt  = $("pd-stage-count");
    const cost = $("pd-stage-cost");
    const btn  = $("pd-add");
    const wrap = $("pd-add-wrap");
    const n = packsState.staged.size;
    cnt.textContent = n;
    const perEmoji = +(state.pricing && state.pricing.addition_price_rub) || 0;
    const rub = n * perEmoji;
    cost.textContent = rub > 0 ? rub + "₽" : "бесплатно";
    chip.classList.toggle("hidden", n === 0);
    btn.disabled = n === 0;
    btn.textContent = n === 0
      ? "Добавить эмодзи"
      : (rub > 0 ? `Добавить ${n} эмодзи · ${rub}₽` : `Добавить ${n} эмодзи`);
    // Sticky CTA: show only when there's something staged AND user isn't
    // inside the per-tile mini-editor (which has its own sticky CTA).
    if (wrap) {
      const editing = packsState.editing != null;
      wrap.classList.toggle("hidden", n === 0 || editing);
    }
  }

  // Separate Lottie observer scoped to the pack-detail grid.
  let pdObserver = null;
  function ensurePdObserver() {
    if (pdObserver) return pdObserver;
    pdObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const cell = e.target;
          pdObserver.unobserve(cell);
          renderPdCellPreview(cell, parseCellId(cell.dataset.id));
        }
      }
    }, { rootMargin: "160px" });
    return pdObserver;
  }

  async function renderPdCellPreview(cell, id) {
    if (cell._pdLoaded) return;
    cell._pdLoaded = true;
    try {
      const data = await loadLottie(id);
      const container = cell.querySelector(".pd-anim");
      if (!container) return;

      // For in-pack and staged tiles, render WITH the pack's customisation
      // (nick / logo / color / transforms) so the user sees what's actually
      // sitting in their Telegram pack, not the bare master tile. Missing
      // tiles render the raw master — CSS desaturates them.
      const pack = packsState.current;
      const includedSet = new Set((pack ? pack.included : []).map(String));
      const inPack = includedSet.has(String(id));
      const staged = packsState.staged.has(String(id));
      let animationData;
      if ((inPack || staged) && window.SwexReplacer) {
        try {
          const eff = packTileEffectiveOverride(id);
          await loadFontKey(eff.font, fontTextForOverride(eff));
          animationData = SwexReplacer.applyToLottie(data, eff);
        } catch (e) {
          console.error("[packs] grid applyToLottie failed for", id, e);
          animationData = JSON.parse(JSON.stringify(data));
        }
      } else {
        animationData = JSON.parse(JSON.stringify(data));
      }

      const anim = lottie.loadAnimation({
        container,
        renderer: "canvas",
        loop: false,
        autoplay: false,
        animationData,
      });
      cell._pdAnim = anim;
      anim.addEventListener("DOMLoaded", () => {
        anim.goToAndStop(0, true);
        const fb = cell.querySelector(".pd-fallback");
        if (fb) fb.style.display = "none";
      });
    } catch (e) {
      console.error("[packs] pd preview failed for", id, e);
    }
  }

  function renderPackGrid(pack) {
    const grid = $("pd-grid");
    grid.innerHTML = "";
    const includedSet = new Set(pack.included.map(String));
    const cap = pack.cap;
    const slack = Math.max(0, cap - pack.included.length);

    // Sort: in-pack first (by original order), then missing.
    const all = allFiles();
    const ordered = [
      ...all.filter(f => includedSet.has(String(f.id))),
      ...all.filter(f => !includedSet.has(String(f.id))),
    ];

    if (slack === 0 && includedSet.size >= all.length) {
      const empty = document.createElement("div");
      empty.className = "pd-grid-empty";
      empty.innerHTML = "<b>Все эмодзи уже в паке.</b><br>Можно только переименовать.";
      grid.appendChild(empty);
      return;
    }

    const obs = ensurePdObserver();
    ordered.forEach(f => {
      const cell = document.createElement("div");
      cell.className = "pd-cell";
      cell.dataset.id = String(f.id);
      const inPack = includedSet.has(String(f.id));
      cell.classList.toggle("in-pack", inPack);
      cell.classList.toggle("missing", !inPack);

      const anim = document.createElement("div");
      anim.className = "pd-anim";
      cell.appendChild(anim);
      const fb = document.createElement("span");
      fb.className = "pd-fallback";
      fb.textContent = f.emoji || "·";
      cell.appendChild(fb);
      const idx = document.createElement("span");
      idx.className = "pd-idx";
      idx.textContent = tileBadge(f.id);
      cell.appendChild(idx);

      if (!inPack) {
        cell.addEventListener("click", () => openTileEdit(f.id));
      }
      if (packsState.staged.has(String(f.id))) cell.classList.add("staged");

      grid.appendChild(cell);
      obs.observe(cell);
    });
  }

  // ── Per-tile mini-editor (inside pack detail) ──────────────
  let pdeAnim = null;
  let pdeRenderToken = 0;
  let pdeKind = "text";              // "text" | "logo"
  let pdeLogoB64 = "";               // base64 SVG for the currently-edited tile
  let pdePngB64 = "";                // base64 PNG for the currently-edited tile
  let pdeColorRemapDraft = null;      // live layer-colour edits for the tile
  let pdeFontKey = DEFAULT_FONT_KEY;
  const pdeFontPicker = $("pde-font-picker");
  const pdeFontToggle = $("pde-font-toggle");
  const pdeFontMenu = $("pde-font-menu");
  const pdeFontCurrent = $("pde-font-current");

  function setPdeStatus(msg) {
    const el = $("pde-status");
    if (el) el.textContent = msg || "";
  }

  function packTileEffectiveOverride(tileId, packArg) {
    const pack = packArg || packsState.current;
    if (!pack) return {};
    const g = pack.global || {};

    // Saved baseline from the pack's per_emoji (slim form from server).
    const isNewTile = typeof tileId === "string" && tileId.startsWith("new:");
    const isUploadTile = typeof tileId === "string" && tileId.startsWith("upload:");
    const slimBaseline = isUploadTile
      ? ((pack.upload_per_emoji || {})[String(tileId).slice(7)] || {})
      : (isNewTile
        ? ((pack.new_per_emoji || {})[String(tileId).slice(4)] || {})
        : ((pack.per_emoji     || {})[String(tileId)]          || {}));
    const storedBaseline = isUploadTile
      ? ((pack.template_upload_per_emoji || {})[String(tileId).slice(7)] || {})
      : (isNewTile
        ? ((pack.template_new_per_emoji || {})[String(tileId).slice(4)] || {})
        : ((pack.template_per_emoji     || {})[String(tileId)]          || {}));
    const baseline = { ...slimBaseline, ...storedBaseline };

    // Live override is only relevant for the currently-open pack while the
    // user is staging additions. For pack-card thumbs (other packs) skip it.
    const isCurrent = pack === packsState.current;
    const liveOv = isCurrent ? packsState.overrides.get(String(tileId)) : null;
    const ov = liveOv || baseline || {};

    const f = fileById(tileId);
    const isPassport = !!(f && Array.isArray(f.passport_lines) && f.passport_lines.length);

    // Per-tile kind: explicit ov.kind > implied by ov.logo_svg_b64/logo_png_b64 > pack global.
    let kind;
    if (ov.kind === "text" || ov.kind === "logo") {
      kind = ov.kind;
    } else if (ov.logo_svg_b64 || ov.logo_png_b64) {
      kind = "logo";
    } else {
      kind = g.kind || "text";
    }

    let text = (ov.text != null && String(ov.text).length > 0)
                  ? String(ov.text) : (g.text || "");
    // Per-tile logo wins; otherwise pack global. PNG takes priority over
    // SVG when a tile somehow has both (mirrors services/webapp_server.py
    // _hydrate_per_emoji — video mode is all-or-nothing per pack anyway).
    const ownPng = ov.logo_png_b64 || "";
    const ownSvg = ov.logo_svg_b64 || "";
    let png_b64 = ownPng || (!ownSvg ? (g.logo_png_b64 || "") : "");
    let logo_b64 = ownPng ? "" : (ownSvg || (!png_b64 ? (g.logo_svg_b64 || "") : ""));

    if (kind === "logo" && !logo_b64 && !png_b64) kind = "text";
    if (kind === "text" && !String(text || "").trim()) text = DEFAULT_BRAND_TEXT;
    if (isPassport) { kind = "text"; text = ""; logo_b64 = ""; png_b64 = ""; }
    return {
      kind, text, logo_svg_b64: logo_b64, logo_png_b64: png_b64,
      content_color: normalizeHexColor(ov.content_color || g.content_color || "#ffffff"),
      scale:    ov.scale    != null ? +ov.scale    : 1,
      offset_x: ov.offset_x != null ? +ov.offset_x : 0,
      offset_y: ov.offset_y != null ? +ov.offset_y : 0,
      anchor_x: hasFiniteAnchorValue(ov.anchor_x) ? +ov.anchor_x : null,
      anchor_y: hasFiniteAnchorValue(ov.anchor_y) ? +ov.anchor_y : null,
      replace_part: !!ov.replace_part,
      rotation: ov.rotation != null ? +ov.rotation : 0,
      lines: null,
      photo_svg_b64: "",
      photo_scale: 1.0,
      photo_color: "#ffffff",
      letter_expand: isNewTile ? 2.5 : 1.0,
      allow_fallback: !isNewTile,
      text_gradient: activeTextGradient(ov.text_gradient),
      font: effectiveFontKey(ov.font || g.font || DEFAULT_FONT_KEY),
      color_remap: hasColorRemap(ov.color_remap) ? ov.color_remap : null,
    };
  }

  function applyPdeMode(mode) {
    pdeKind = (mode === "logo") ? "logo" : "text";
    document.querySelectorAll(".pde-seg .seg-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.pdeKind === pdeKind);
    });
    const editor = $("pd-edit");
    if (editor) {
      editor.classList.toggle("mode-text", pdeKind === "text");
      editor.classList.toggle("mode-logo", pdeKind === "logo");
    }
    $("pde-text-row").classList.toggle("hidden", pdeKind !== "text");
    $("pde-logo-row").classList.toggle("hidden", pdeKind !== "logo");
    $("pde-gradient-row")?.classList.toggle("hidden", pdeKind !== "text");
    pdeFontPicker?.classList.toggle("hidden", pdeKind !== "text");
  }

  function renderPdeFontMenu() {
    if (!pdeFontMenu) return;
    const activeKey = effectiveFontKey(pdeFontKey);
    pdeFontMenu.innerHTML = "";
    state.fonts.forEach(f => {
      const btn = document.createElement("button");
      btn.className = "font-option";
      btn.type = "button";
      btn.dataset.font = f.key;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", f.key === activeKey ? "true" : "false");
      btn.innerHTML = `
        <span class="font-sample">${escapeHtml(f.sample || "Lean")}</span>
        <span class="font-name">${escapeHtml(f.label)}</span>
      `;
      btn.style.fontFamily = `"${fontCssName(f.key)}", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      btn.classList.toggle("active", f.key === activeKey);
      btn.addEventListener("click", () => setPdeFont(f.key));
      pdeFontMenu.appendChild(btn);
    });
    updatePdeFontUi();
  }

  function updatePdeFontUi() {
    const f = fontByKey(effectiveFontKey(pdeFontKey));
    if (pdeFontCurrent) {
      pdeFontCurrent.textContent = f.label || "Seymour One";
      pdeFontCurrent.style.fontFamily = `"${fontCssName(f.key)}", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    }
    if (pdeFontMenu) {
      pdeFontMenu.querySelectorAll(".font-option").forEach(btn => {
        const active = btn.dataset.font === f.key;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
  }

  function setPdeFontMenuOpen(open) {
    if (!pdeFontPicker || !pdeFontMenu || !pdeFontToggle) return;
    pdeFontPicker.classList.toggle("open", open);
    pdeFontMenu.classList.toggle("hidden", !open);
    pdeFontToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  async function setPdeFont(key) {
    pdeFontKey = effectiveFontKey(key);
    updatePdeFontUi();
    setPdeFontMenuOpen(false);
    await ensureFont(pdeFontKey, $("pde-text")?.value || "");
    setPdeOverrideFromControls();
    rerenderPdeSoon();
  }

  function syncPdeGradientUi(value) {
    const g = normalizeTextGradient(value);
    const toggle = $("pde-gradient-toggle");
    const controls = $("pde-gradient-controls");
    const from = $("pde-gradient-from");
    const to = $("pde-gradient-to");
    if (toggle) {
      toggle.classList.toggle("active", g.enabled);
      toggle.setAttribute("aria-pressed", g.enabled ? "true" : "false");
    }
    if (controls) controls.classList.toggle("hidden", !g.enabled);
    if (from) from.value = g.from;
    if (to) to.value = g.to;
  }

  function readPdeGradientUi() {
    return normalizeTextGradient({
      enabled: $("pde-gradient-toggle")?.classList.contains("active"),
      from: $("pde-gradient-from")?.value,
      to: $("pde-gradient-to")?.value,
    });
  }

  function updatePdeGradient(partial) {
    const cur = readPdeGradientUi();
    const next = normalizeTextGradient({
      ...cur,
      ...partial,
      from: (partial && partial.from) || cur.from,
      to: (partial && partial.to) || cur.to,
    });
    syncPdeGradientUi(next);
    setPdeOverrideFromControls();
    rerenderPdeSoon();
  }

  async function renderPdePreview(id) {
    const token = ++pdeRenderToken;
    if (pdeAnim) { try { pdeAnim.destroy(); } catch (_) {} pdeAnim = null; }
    const container = $("pde-preview");
    container.innerHTML = "";
    try {
      const original = await loadLottie(id);
      if (token !== pdeRenderToken) return;
      const eff = packTileEffectiveOverride(id);
      let data;
      let layeredPngPreview = false;
      try {
        await loadFontKey(eff.font, fontTextForOverride(eff));
        if (eff.kind === "logo" && eff.logo_png_b64 && !isUploadId(id)) {
          const layered = await loadLayeredPngPreview(id, eff);
          if (token !== pdeRenderToken) return;
          data = SwexReplacer.applyToLottie(layered, {
            ...eff,
            logo_png_b64: "",
            logo_svg_b64: "",
          });
          layeredPngPreview = true;
        } else {
          data = SwexReplacer.applyToLottie(original, eff);
        }
      }
      catch (e) {
        if (eff.kind === "logo" && eff.logo_png_b64) {
          console.info("[packs] no layered PNG slot for", id, e?.message || e);
        } else {
          console.error("[packs] applyToLottie failed:", e);
        }
        data = SwexReplacer.applyToLottie(original, eff);
      }
      pdeAnim = lottie.loadAnimation({
        container, renderer: "svg", loop: true, autoplay: true,
        animationData: data,
      });
      // PNG logos can't be inserted as vector shapes in the Lottie preview
      // (only the real pack build composites the raster onto rendered
      // frames) — overlay the raw image instead, positioned/scaled the
      // same way as the main editor's preview (see renderPreview above).
      if (ENABLE_FLAT_PNG_PREVIEW_FALLBACK
          && eff.kind === "logo" && eff.logo_png_b64 && !layeredPngPreview) {
        const overlay = document.createElement("img");
        overlay.className = "preview-png-overlay";
        overlay.src = "data:image/png;base64," + eff.logo_png_b64;
        const f = fileById(id);
        const staticBox = f && Array.isArray(f.logo_box) && f.logo_box.length === 4
          ? f.logo_box : null;
        let liveLocalBBox = null;
        try {
          const containers = SwexReplacer.findSwexContainers(original);
          if (containers && containers.length) liveLocalBBox = containers[0].bbox;
        } catch (_) { liveLocalBBox = null; }

        const positionOverlay = (frameNum) => {
          let box = staticBox;
          if (liveLocalBBox) {
            const xform = SwexReplacer.swexCanvasXformAtFrame(original, frameNum);
            if (xform) {
              const [xsx, xsy, xox, xoy] = xform;
              const [lx0, ly0, lx1, ly1] = liveLocalBBox;
              const cx0 = xox + xsx * lx0, cx1 = xox + xsx * lx1;
              const cy0 = xoy + xsy * ly0, cy1 = xoy + xsy * ly1;
              box = [
                Math.min(cx0, cx1), Math.min(cy0, cy1),
                Math.max(cx0, cx1), Math.max(cy0, cy1),
              ];
            }
          }
          if (!box) return;
          const cw = Number(original.w) || 512;
          const ch = Number(original.h) || 512;
          const pw = container.clientWidth || 220;
          const ph = container.clientHeight || 220;
          // Mirror services/pack_builder.py:_scale_png_box (position/size)
          // and its hard 1.3x cap — same reasoning as the main preview.
          const bscale = Math.max(0.3, Math.min(1.3, +eff.scale || 1));
          const bx = +eff.offset_x || 0;
          const by = +eff.offset_y || 0;
          const bcx = (box[0] + box[2]) / 2 + bx;
          const bcy = (box[1] + box[3]) / 2 + by;
          const bhw = (box[2] - box[0]) / 2 * bscale;
          const bhh = (box[3] - box[1]) / 2 * bscale;
          const sx = pw / cw, sy = ph / ch;
          overlay.style.left = ((bcx - bhw) * sx) + "px";
          overlay.style.top = ((bcy - bhh) * sy) + "px";
          overlay.style.width = (bhw * 2 * sx) + "px";
          overlay.style.height = (bhh * 2 * sy) + "px";
          overlay.style.transform = "none";
          overlay.style.maxWidth = "none";
          overlay.style.maxHeight = "none";
        };
        positionOverlay(0);
        if (pdeAnim) {
          pdeAnim.addEventListener("enterFrame", () => {
            if (!overlay.isConnected) return;
            positionOverlay(pdeAnim.currentFrame);
          });
        }
        container.appendChild(overlay);
      }
    } catch (e) {
      container.textContent = "✗ " + e.message;
    }
  }

  let pdeRerenderTimer = null;
  function rerenderPdeSoon() {
    if (pdeRerenderTimer) clearTimeout(pdeRerenderTimer);
    const current = packsState.editing != null
      ? packTileEffectiveOverride(packsState.editing)
      : null;
    const delay = current && current.logo_png_b64 ? 280 : 90;
    pdeRerenderTimer = setTimeout(() => {
      pdeRerenderTimer = null;
      if (packsState.editing != null) renderPdePreview(packsState.editing);
    }, delay);
  }

  function loadEditorFromOverride(id) {
    const pack = packsState.current;
    const isNew = typeof id === "string" && id.startsWith("new:");
    const isUpload = typeof id === "string" && id.startsWith("upload:");
    // Pre-fill priority: live override (if any) → saved baseline → defaults.
    const slimBaseline = isUpload
      ? ((pack.upload_per_emoji || {})[String(id).slice(7)] || {})
      : (isNew
        ? ((pack.new_per_emoji || {})[String(id).slice(4)] || {})
        : ((pack.per_emoji     || {})[String(id)]          || {}));
    const storedBaseline = isUpload
      ? ((pack.template_upload_per_emoji || {})[String(id).slice(7)] || {})
      : (isNew
        ? ((pack.template_new_per_emoji || {})[String(id).slice(4)] || {})
        : ((pack.template_per_emoji     || {})[String(id)]          || {}));
    const baseline = { ...slimBaseline, ...storedBaseline };
    const liveOv = packsState.overrides.get(String(id));
    const ov = liveOv || baseline;
    pdeColorRemapDraft = hasColorRemap(ov.color_remap)
      ? JSON.parse(JSON.stringify(ov.color_remap))
      : null;

    const text = ov.text != null ? String(ov.text) : "";
    $("pde-text").value = text.slice(0, 20);
    $("pde-text-counter").textContent = $("pde-text").value.length + "/20";

    const color = normalizeHexColor(
      ov.content_color || (pack.global && pack.global.content_color) || "#ffffff"
    );
    $("pde-color").value = color;
    $("pde-color-val").textContent = color.toUpperCase();
    syncPdeGradientUi(ov.text_gradient);
    pdeFontKey = effectiveFontKey(ov.font || (pack.global && pack.global.font) || DEFAULT_FONT_KEY);
    updatePdeFontUi();

    const rot = Math.round(+(ov.rotation || 0));
    $("pde-rotation").value = rot;
    $("pde-rotation-val").textContent = rot + "°";

    const scalePct = Math.round((+ov.scale || 1) * 100);
    $("pde-scale").value = scalePct;
    $("pde-scale-val").textContent = scalePct + "%";

    const ox = Math.round(+ov.offset_x || 0);
    $("pde-offset-x").value = ox;
    $("pde-offset-x-val").textContent = ox;

    const oy = Math.round(+ov.offset_y || 0);
    $("pde-offset-y").value = oy;
    $("pde-offset-y-val").textContent = oy;

    // Full saved settings are returned separately from the slim grid payload,
    // so a reopened editor keeps the original PNG/SVG through later changes.
    pdeLogoB64 = typeof ov.logo_svg_b64 === "string" ? ov.logo_svg_b64 : "";
    pdePngB64 = typeof ov.logo_png_b64 === "string" ? ov.logo_png_b64 : "";
    const hasOwnLogo = !!(pdeLogoB64 || pdePngB64);
    const hasBaselineLogo = !liveOv && (
      baseline.has_logo === true || !!baseline.logo_svg_b64 || !!baseline.logo_png_b64
    );
    const lbl = $("pde-logo-label");
    if (lbl) {
      if (pdePngB64) {
        lbl.textContent = "Фото загружено ✓";
      } else if (pdeLogoB64) {
        lbl.textContent = "Лого загружено ✓";
      } else if (hasBaselineLogo) {
        lbl.textContent = "Лого из пака · можно заменить";
      } else {
        lbl.textContent = "Загрузить SVG или фото";
      }
    }
    $("pde-logo-clear").classList.toggle("hidden", !hasOwnLogo);
    const pngHint = $("pde-logo-png-hint");
    if (pngHint) pngHint.classList.toggle("hidden", !pdePngB64);

    // Mode resolution: explicit ov.kind > implied by ov.logo > baseline kind > pack global.
    let mode = ov.kind;
    if (mode !== "text" && mode !== "logo") {
      if (hasOwnLogo || hasBaselineLogo) mode = "logo";
      else mode = (pack.global && pack.global.kind) === "logo" ? "logo" : "text";
    }
    applyPdeMode(mode);
  }

  function readEditorOverride() {
    const gradient = readPdeGradientUi();
    const ov = {
      scale:         (+$("pde-scale").value) / 100,
      offset_x:      +$("pde-offset-x").value,
      offset_y:      +$("pde-offset-y").value,
      rotation:      +$("pde-rotation").value,
      content_color: normalizeHexColor($("pde-color").value),
      text:          $("pde-text").value.slice(0, 20),
      kind:          pdeKind,
      font:          effectiveFontKey(pdeFontKey),
      text_gradient: (pdeKind === "text" && gradient.enabled)
        ? gradient
        : { enabled: false },
    };
    const prev = packsState.editing != null
      ? packsState.overrides.get(String(packsState.editing))
      : null;
    const remap = hasColorRemap(pdeColorRemapDraft)
      ? pdeColorRemapDraft
      : (prev && hasColorRemap(prev.color_remap) ? prev.color_remap : null);
    if (remap) ov.color_remap = remap;
    // PNG takes priority when a tile somehow has both — mirrors the
    // server-side _hydrate_per_emoji priority (video mode is all-or-
    // nothing per pack, so there's no meaningful "use both" case).
    if (pdePngB64) ov.logo_png_b64 = pdePngB64;
    else if (pdeLogoB64) ov.logo_svg_b64 = pdeLogoB64;
    return ov;
  }

  function setPdeOverrideFromControls() {
    const id = packsState.editing;
    if (id == null) return null;
    const ov = readEditorOverride();
    packsState.overrides.set(String(id), ov);
    return ov;
  }

  function getPdeOverride(id = packsState.editing) {
    if (id == null) return null;
    const key = String(id);
    let ov = packsState.overrides.get(key);
    if (!ov) {
      ov = readEditorOverride();
      packsState.overrides.set(key, ov);
    }
    return ov;
  }

  function openTileEdit(id) {
    const pack = packsState.current;
    if (!pack) return;
    packsState.editing = id;

    loadEditorFromOverride(id);

    const f = fileById(id);
    const label = f && f.emoji ? f.emoji + "  " : "";
    $("pde-title").textContent = label + "Эмодзи #" + id;
    const isStaged = packsState.staged.has(String(id));
    $("pde-sub").textContent = isStaged
      ? "Уже в очереди — отредактируй и сохрани"
      : "Настрой как тебе нравится";
    $("pde-remove").classList.toggle("hidden", !isStaged);
    $("pde-save").textContent = isStaged ? "Сохранить" : "Добавить в очередь";
    setPdeStatus("");

    $("pd-grid-wrap").classList.add("hidden");
    $("pd-edit").classList.remove("hidden");
    updateStagedChip();  // hides FAB while editor is open

    // Save user's *live* edits into overrides immediately so the preview
    // reflects them; final stage happens on Save button.
    setPdeOverrideFromControls();
    renderPdePreview(id);

    // Bring the editor's top into view (mini-app scrolls inside Telegram).
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeTileEdit() {
    if (!$("pd-edit")) return;
    if (layerColorContext === "pde") closeLayerColorsModal();
    // If the tile being edited wasn't staged, drop its provisional override
    // so re-opening starts from baseline rather than partial state.
    if (packsState.editing != null
        && !packsState.staged.has(String(packsState.editing))) {
      packsState.overrides.delete(String(packsState.editing));
    }
    pdeColorRemapDraft = null;
    packsState.editing = null;
    if (pdeAnim) { try { pdeAnim.destroy(); } catch (_) {} pdeAnim = null; }
    const prev = $("pde-preview");
    if (prev) prev.innerHTML = "";
    $("pd-edit").classList.add("hidden");
    $("pd-grid-wrap").classList.remove("hidden");
    updateStagedChip();  // re-show FAB if there's still anything staged
  }

  function pulseStagedCell(id) {
    const sel = `.pd-cell[data-id="${String(id).replace(/"/g, '\\"')}"]`;
    const cell = $("pd-grid").querySelector(sel);
    if (!cell) return;
    cell.classList.remove("just-staged");
    void cell.offsetWidth;
    cell.classList.add("just-staged");
    setTimeout(() => cell.classList.remove("just-staged"), 500);
  }

  function saveTileEdit() {
    const id = packsState.editing;
    if (id == null) return;
    const pack = packsState.current;
    const slack = Math.max(0, pack.cap - pack.included.length);
    const wasStaged = packsState.staged.has(String(id));
    if (!wasStaged && packsState.staged.size >= slack) {
      setPdeStatus(`Лимит пака: максимум ${pack.cap} эмодзи.`);
      return;
    }
    packsState.staged.add(String(id));
    setPdeOverrideFromControls();
    // Mark as "finalised" — don't let closeTileEdit drop the override.
    const justEdited = id;
    packsState.editing = null;
    closeTileEditCommitted();
    renderPackGrid(pack);
    pulseStagedCell(justEdited);
    updateStagedChip();
  }

  // Like closeTileEdit but preserves override (called after explicit save).
  function closeTileEditCommitted() {
    if (layerColorContext === "pde") closeLayerColorsModal();
    pdeColorRemapDraft = null;
    packsState.editing = null;
    if (pdeAnim) { try { pdeAnim.destroy(); } catch (_) {} pdeAnim = null; }
    const prev = $("pde-preview");
    if (prev) prev.innerHTML = "";
    $("pd-edit").classList.add("hidden");
    $("pd-grid-wrap").classList.remove("hidden");
    updateStagedChip();
  }

  function removeFromStage(id) {
    packsState.staged.delete(String(id));
    packsState.overrides.delete(String(id));
    packsState.editing = null;
    closeTileEditCommitted();
    renderPackGrid(packsState.current);
    updateStagedChip();
  }

  // ── Editor controls (sliders / inputs / buttons) ───────────
  function bindPdeSlider(id, valId, fmt) {
    const sl = $(id), val = $(valId);
    const handler = () => {
      val.textContent = fmt(sl.value);
      const eid = packsState.editing;
      if (eid != null) setPdeOverrideFromControls();
      rerenderPdeSoon();
    };
    sl.addEventListener("input", handler);
    sl.addEventListener("change", handler);
  }
  bindPdeSlider("pde-scale",    "pde-scale-val",    v => v + "%");
  bindPdeSlider("pde-offset-x", "pde-offset-x-val", v => v + "");
  bindPdeSlider("pde-offset-y", "pde-offset-y-val", v => v + "");
  bindPdeSlider("pde-rotation", "pde-rotation-val", v => v + "°");

  $("pde-text").addEventListener("input", () => {
    const v = $("pde-text").value.slice(0, 20);
    $("pde-text-counter").textContent = v.length + "/20";
    const eid = packsState.editing;
    if (eid != null) setPdeOverrideFromControls();
    rerenderPdeSoon();
  });
  $("pde-color").addEventListener("input", () => {
    const c = normalizeHexColor($("pde-color").value);
    $("pde-color").value = c;
    $("pde-color-val").textContent = c.toUpperCase();
    const eid = packsState.editing;
    if (eid != null) setPdeOverrideFromControls();
    rerenderPdeSoon();
  });
  pdeFontToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    setPdeFontMenuOpen(pdeFontMenu.classList.contains("hidden"));
  });
  document.addEventListener("click", (e) => {
    if (pdeFontPicker && !pdeFontPicker.contains(e.target)) setPdeFontMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setPdeFontMenuOpen(false);
  });
  pdeLcmOpenBtn?.addEventListener("click", () => {
    setPdeOverrideFromControls();
    openLayerColorsModal("pde");
  });
  $("pde-gradient-toggle")?.addEventListener("click", () => {
    const cur = readPdeGradientUi();
    const baseColor = normalizeHexColor($("pde-color")?.value || "#ffffff");
    updatePdeGradient({
      enabled: !cur.enabled,
      from: cur.from || baseColor,
      to: cur.to || "#30d158",
    });
  });
  $("pde-gradient-from")?.addEventListener("input", () => {
    updatePdeGradient({ enabled: true, from: normalizeHexColor($("pde-gradient-from").value) });
  });
  $("pde-gradient-to")?.addEventListener("input", () => {
    updatePdeGradient({ enabled: true, to: normalizeHexColor($("pde-gradient-to").value) });
  });

  $("pde-back").addEventListener("click", closeTileEdit);
  $("pde-save").addEventListener("click", saveTileEdit);
  $("pde-remove").addEventListener("click", () => {
    if (packsState.editing != null) removeFromStage(packsState.editing);
  });

  // Text/Logo mode toggle
  document.querySelectorAll(".pde-seg .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      applyPdeMode(btn.dataset.pdeKind);
      const eid = packsState.editing;
      if (eid != null) setPdeOverrideFromControls();
      rerenderPdeSoon();
    });
  });

  // SVG stays vector; raster PNG/JPEG/WebP is normalized and embedded in TGS.
  $("pde-logo-input").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const isRaster = isRasterImageFile(f);
    const isSvg = /\.svg$/i.test(f.name) || f.type === "image/svg+xml";
    if (isRaster) {
      let b64;
      try { b64 = await rasterFileToPngBase64(f); }
      catch (err) { setPdeStatus(err?.message || "Не удалось прочитать изображение"); e.target.value = ""; return; }
      pdePngB64 = b64;
      pdeLogoB64 = "";
      $("pde-logo-label").textContent = f.name + " ✓";
      $("pde-logo-png-hint")?.classList.remove("hidden");
    } else if (isSvg) {
      if (f.size > 256 * 1024) {
        setPdeStatus("SVG > 256KB — слишком большой");
        e.target.value = "";
        return;
      }
      let txt;
      try { txt = await f.text(); }
      catch (err) { setPdeStatus("Не получилось прочитать файл"); return; }
      if (!/<svg/i.test(txt)) {
        setPdeStatus("Не похоже на SVG");
        e.target.value = "";
        return;
      }
      pdeLogoB64 = btoa(unescape(encodeURIComponent(txt)));
      pdePngB64 = "";
      $("pde-logo-label").textContent = f.name + " ✓";
      $("pde-logo-png-hint")?.classList.add("hidden");
    } else {
      setPdeStatus("Поддерживаются PNG, JPG, WEBP и SVG");
      e.target.value = "";
      return;
    }
    $("pde-logo-clear").classList.remove("hidden");
    setPdeStatus("");
    const eid = packsState.editing;
    if (eid != null) setPdeOverrideFromControls();
    rerenderPdeSoon();
    e.target.value = "";
  });

  $("pde-logo-clear").addEventListener("click", () => {
    pdeLogoB64 = "";
    pdePngB64 = "";
    $("pde-logo-input").value = "";
    $("pde-logo-label").textContent = "Загрузить SVG или фото";
    $("pde-logo-clear").classList.add("hidden");
    $("pde-logo-png-hint")?.classList.add("hidden");
    const eid = packsState.editing;
    if (eid != null) {
      // Explicit empty string tells the server to wipe a previously-saved
      // per-tile logo (and revert to pack global on logo mode).
      const ov = readEditorOverride();
      ov.logo_svg_b64 = "";
      ov.logo_png_b64 = "";
      packsState.overrides.set(String(eid), ov);
    }
    rerenderPdeSoon();
  });
  $("pde-reset").addEventListener("click", () => {
    const pack = packsState.current;
    const color = (pack && pack.global && pack.global.content_color) || "#ffffff";
    $("pde-text").value = "";
    $("pde-text-counter").textContent = "0/20";
    $("pde-color").value = normalizeHexColor(color);
    $("pde-color-val").textContent = $("pde-color").value.toUpperCase();
    $("pde-rotation").value = 0;
    $("pde-rotation-val").textContent = "0°";
    $("pde-scale").value = 100;
    $("pde-scale-val").textContent = "100%";
    $("pde-offset-x").value = 0;
    $("pde-offset-x-val").textContent = "0";
    $("pde-offset-y").value = 0;
    $("pde-offset-y-val").textContent = "0";
    pdeLogoB64 = "";
    pdePngB64 = "";
    $("pde-logo-input").value = "";
    $("pde-logo-label").textContent = "Загрузить SVG или фото";
    $("pde-logo-clear").classList.add("hidden");
    $("pde-logo-png-hint")?.classList.add("hidden");
    pdeColorRemapDraft = null;
    pdeFontKey = effectiveFontKey(pack && pack.global && pack.global.font);
    updatePdeFontUi();
    syncPdeGradientUi(null);
    // Fall back to pack global mode.
    const packMode = (pack && pack.global && pack.global.kind) === "logo" ? "logo" : "text";
    applyPdeMode(packMode);
    const eid = packsState.editing;
    if (eid != null) {
      packsState.overrides.delete(String(eid));
      setPdeOverrideFromControls();
    }
    rerenderPdeSoon();
  });

  // Inline rename
  $("pd-rename").addEventListener("click", () => {
    const titleEl = $("pd-title");
    const inputEl = $("pd-title-input");
    const pack = packsState.current;
    if (!pack) return;
    inputEl.value = pack.title || "";
    titleEl.classList.add("hidden");
    inputEl.classList.remove("hidden");
    inputEl.focus();
    inputEl.select();
  });

  $("pd-title-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
  });
  $("pd-title-input").addEventListener("blur", () => {
    // Brief delay: lets the click on a button finish first.
    setTimeout(commitRename, 60);
  });

  function cancelRename() {
    $("pd-title-input").classList.add("hidden");
    $("pd-title").classList.remove("hidden");
  }

  async function commitRename() {
    const inputEl = $("pd-title-input");
    if (inputEl.classList.contains("hidden")) return;
    const pack = packsState.current;
    if (!pack) return;
    const newTitle = inputEl.value.trim().slice(0, 40);
    inputEl.classList.add("hidden");
    $("pd-title").classList.remove("hidden");
    if (!newTitle || newTitle === pack.title) return;
    setPdStatus("Переименовываю…");
    try {
      const r = await fetch(`/api/packs/${pack.id}/rename`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ title: newTitle }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ("http " + r.status));
      pack.title = data.title;
      $("pd-title").textContent = pack.title;
      // Update the list cache so going back shows the new name.
      const lc = packsState.items.find(p => p.id === pack.id);
      if (lc) lc.title = pack.title;
      setPdStatus("Готово ✓");
      setTimeout(() => setPdStatus(""), 1600);
    } catch (e) {
      setPdStatus("Ошибка: " + e.message);
    }
  }

  $("pd-add").addEventListener("click", async () => {
    const pack = packsState.current;
    if (!pack) return;
    if (isIconPack(pack)) {
      openIconAppendEditor(pack);
      return;
    }
    if (!packsState.staged.size) return;
    const ids = Array.from(packsState.staged);
    const overrides = {};
    ids.forEach(s => {
      const ov = packsState.overrides.get(s);
      if (ov && Object.keys(ov).length) overrides[s] = ov;
    });
    const btn = $("pd-add");
    btn.disabled = true;
    setPdStatus("Дозаливаю в пак…");
    try {
      const r = await fetch(`/api/packs/${pack.id}/add_tiles`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ tile_ids: ids, overrides }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ("http " + r.status));
      // Merge added ids into included.
      const addedSet = new Set((data.added || []).map(String));
      const orig = pack.included.map(String);
      ids.forEach(s => { if (addedSet.has(s) && !orig.includes(s)) orig.push(s); });
      pack.included = orig.map(s => /^\d+$/.test(s) ? +s : s);
      pack.per_emoji = pack.per_emoji || {};
      pack.new_per_emoji = pack.new_per_emoji || {};
      pack.upload_per_emoji = pack.upload_per_emoji || {};
      ids.forEach(s => {
        if (!addedSet.has(s)) return;
        const ov = overrides[s];
        if (!ov || !Object.keys(ov).length) return;
        if (String(s).startsWith("new:")) {
          pack.new_per_emoji[String(s).slice(4)] = ov;
        } else if (String(s).startsWith("upload:")) {
          pack.upload_per_emoji[String(s).slice(7)] = ov;
        } else {
          pack.per_emoji[String(s)] = ov;
        }
      });
      // Drop successfully-added from stage + overrides; keep failed ones so
      // user can retry without re-customising.
      [...packsState.staged].forEach(s => {
        if (addedSet.has(s)) {
          packsState.staged.delete(s);
          packsState.overrides.delete(s);
        }
      });
      // Update list cache count.
      const lc = packsState.items.find(p => p.id === pack.id);
      if (lc) { lc.count = pack.included.length; lc.included = pack.included.slice(); }
      // Re-render grid + chip.
      renderPackDetail(pack);
      const failed = (data.errors || []).length;
      if (failed > 0) {
        setPdStatus(`Добавлено ${data.added.length}, не получилось ${failed}.`);
      } else {
        setPdStatus(`Готово ✓ Добавил ${data.added.length}.`);
        setTimeout(() => setPdStatus(""), 2000);
      }
    } catch (e) {
      setPdStatus("Ошибка: " + e.message);
    } finally {
      $("pd-add").disabled = packsState.staged.size === 0;
    }
  });

  // ── Profile & Telegram Stars ──────────────────
  function setProfileStatus(text) {
    const el = $("profile-status");
    if (el) el.textContent = text || "";
  }
  async function loadProfile() {
    try {
      const r = await fetch("/api/profile", { headers: apiHeaders() });
      if (!r.ok) throw new Error("http " + r.status);
      const p = await r.json();
      if ($("profile-balance")) $("profile-balance").textContent = p.balance_stars ?? 0;
      if ($("profile-packs")) $("profile-packs").textContent = p.packs_made ?? p.packs_count ?? 0;
      if ($("profile-stickers")) $("profile-stickers").textContent = p.stickers_made ?? 0;
      if ($("profile-topup-total")) $("profile-topup-total").textContent = p.total_topup_stars ?? 0;
      if ($("profile-username")) {
        $("profile-username").textContent = p.username ? "@" + p.username : (p.first_name || "");
      }
      return p;
    } catch (e) {
      setProfileStatus("Не удалось загрузить профиль. Открой приложение из Telegram.");
      return null;
    }
  }
  document.querySelectorAll(".topup-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".topup-chip").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const input = $("topup-amount");
      if (input) input.value = btn.dataset.topupAmount || "";
    });
  });
  $("topup-btn")?.addEventListener("click", async () => {
    const raw = parseInt(($("topup-amount")?.value || "").replace(/\D+/g, ""), 10);
    if (!Number.isFinite(raw) || raw < 1 || raw > 500) {
      setProfileStatus("Укажи сумму от 1 до 500 ⭐");
      return;
    }
    const btn = $("topup-btn");
    if (btn) btn.disabled = true;
    setProfileStatus("Создаю счёт в Telegram…");
    try {
      const r = await fetch("/api/billing/invoice", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ amount: raw }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.invoice_url) throw new Error(data.error || ("http " + r.status));
      const done = async (status) => {
        if (btn) btn.disabled = false;
        if (status === "paid") {
          setProfileStatus("Оплата прошла! Обновляю баланс…");
          await loadProfile();
          setProfileStatus("Баланс пополнен. Можно собирать пак!");
        } else if (status === "cancelled" || status === "canceled") {
          setProfileStatus("Оплата отменена.");
        } else {
          setProfileStatus("Статус оплаты: " + status);
          await loadProfile();
        }
      };
      if (tg && typeof tg.openInvoice === "function") {
        tg.openInvoice(data.invoice_url, (status) => { done(status); });
      } else {
        window.open(data.invoice_url, "_blank");
        setProfileStatus("Счёт открыт. После оплаты вернись и обнови профиль.");
        if (btn) btn.disabled = false;
      }
    } catch (e) {
      if (btn) btn.disabled = false;
      setProfileStatus("Ошибка: " + e.message);
    }
  });

  // ── Boot ───────────────────────────────────
  applyModeUI("text");
  async function bootEditor() {
    try {
      setSplashProgress(18, "Загружаем шаблоны");
      await Promise.all([
        loadMaster().then(() => setSplashProgress(44, "Готовим эмодзи")),
        loadNew().then(() => setSplashProgress(56, "Подключаем новые")),
        loadPricing().then(() => setSplashProgress(64, "Считаем пак")),
        loadFonts().then(() => setSplashProgress(72, "Готовим шрифты")),
      ]);
      setSplashProgress(78, "Собираем ленту");
      // Seed the default selection capped at the emoji-pack hard limit so
      // the user lands inside Telegram's 200-emoji cap on first open (was
      // 243-overflow, forcing 43 manual deselects before they could build).
      state.selected = pickDefaultSelection(DEFAULT_EMOJI_SELECTION);
      // Selection bar visible from the start (count + price).
      selectBar.classList.remove("hidden");
      updateSelectionUI();
      rebuildPreviewStrip();
      setSplashProgress(88, "Рисуем превью");
      if (state.masterFiles.length) await selectId(state.masterFiles[0].id);
      setSplashProgress(95, "Открываем редактор");
      scheduleEmojiPickerPrebuild();
      const newTab = document.querySelector('.tab[data-tab="new"]');
      if (state.newFiles.length && newTab) {
        newTab.classList.add("has-content");
      }
      // Pre-fetch user's packs in background so the topbar badge populates
      // before the user clicks "Мои паки".
      loadPacksIfNeeded().catch(() => {});
      finishSplash();
      maybePromptPackBotOnBoot();
    } catch (e) {
      setStatus("Не удалось загрузить эмодзи: " + e.message);
      failSplash("Не удалось загрузить редактор");
    }
  }
  bootEditor();
})();
