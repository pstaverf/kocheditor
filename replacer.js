// JS-порт services/swex/replacer.py + services/swex/glyphs.py + services/svg_to_lottie.py.
// Заменяет swex-буквы внутри Lottie JSON на пользовательский текст или SVG-лого
// и оборачивает в gr с tr для per-emoji масштаба/позиции/поворота.
// Используется для живого превью в редакторе.

window.SwexReplacer = (() => {
  const LETTER_NAMES = new Set(["s", "w", "e", "x"]);

  // ─────────────────── Tree walk: containers ───────────────────
  function findSwexContainers(tree) {
    /** Возвращает [{parentList, idxs, bbox}] для каждой группы, в которой
     *  есть siblings с nm in {s,w,e,x}.  parentList — JS-массив (мутируем).  */
    const out = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      for (const key of Object.keys(node)) {
        const v = node[key];
        if ((key === "layers" || key === "assets" || key === "shapes" || key === "it")
            && Array.isArray(v)) {
          const indicesByName = {};
          for (let i = 0; i < v.length; i++) {
            const child = v[i];
            if (child && typeof child === "object") {
              const nm = child.nm;
              if (LETTER_NAMES.has(nm) && !(nm in indicesByName)) {
                indicesByName[nm] = i;
              }
            }
          }
          if (Object.keys(indicesByName).length === 4) {
            const idxs = Object.values(indicesByName).sort((a, b) => a - b);
            const bboxes = idxs.map(i => shapeBBox(v[i])).filter(b => b);
            if (bboxes.length) {
              const xmin = Math.min(...bboxes.map(b => b[0]));
              const ymin = Math.min(...bboxes.map(b => b[1]));
              const xmax = Math.max(...bboxes.map(b => b[2]));
              const ymax = Math.max(...bboxes.map(b => b[3]));
              out.push({ parentList: v, idxs, bbox: [xmin, ymin, xmax, ymax] });
            }
          }
          for (const child of v) visit(child);
        }
      }
    }
    visit(tree);
    return out;
  }

  function shapeBBox(node) {
    /** Bbox по всем 'sh'-вершинам внутри узла. */
    const pts = [];
    function visit(n) {
      if (!n || typeof n !== "object") return;
      if (n.ty === "sh") {
        const ks = n.ks && n.ks.k;
        if (ks && Array.isArray(ks.v)) {
          for (const v of ks.v) pts.push([v[0], v[1]]);
        }
      }
      for (const key of Object.keys(n)) {
        if (key === "it" || key === "shapes") {
          const arr = n[key];
          if (Array.isArray(arr)) for (const c of arr) visit(c);
        }
      }
    }
    visit(node);
    if (!pts.length) return null;
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  // ─────────────────── Wrap-in-transform ───────────────────
  function hasTransform(t) {
    if (!t) return false;
    return Math.abs((t.scale || 1) - 1) > 1e-6
        || Math.abs(t.offset_x || 0) > 1e-6
        || Math.abs(t.offset_y || 0) > 1e-6
        || Math.abs(t.rotation || 0) > 1e-6;
  }
  function shapesBBox(shapes) {
    const pts = [];
    for (const sh of shapes || []) {
      const k = sh && sh.ks && sh.ks.k;
      if (!k || !Array.isArray(k.v)) continue;
      for (const v of k.v) pts.push([v[0], v[1]]);
    }
    if (!pts.length) return null;
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  function wrapInTransform(shapes, t, parentList) {
    const bbox = shapesBBox(shapes);
    const anchor = bbox
      ? [+( (bbox[0] + bbox[2]) / 2 ).toFixed(2), +( (bbox[1] + bbox[3]) / 2 ).toFixed(2)]
      : [0, 0];
    // Copy fill only from parent list to inherit styling.
    const fillStroke = [];
    if (parentList && Array.isArray(parentList)) {
      for (const item of parentList) {
        if (item && item.ty === "fl") {
          fillStroke.push({ ...item });
        }
      }
    }
    const result = {
      ty: "gr",
      nm: "swex_override",
      it: [
        ...shapes,
        ...fillStroke,
        {
          ty: "tr",
          p: { a: 0, k: [+(t.offset_x || 0), +(t.offset_y || 0)] },
          a: { a: 0, k: anchor },
          s: { a: 0, k: [100 * (t.scale || 1), 100 * (t.scale || 1)] },
          r: { a: 0, k: +(t.rotation || 0) },
          o: { a: 0, k: 100 },
          sk: { a: 0, k: 0 },
          sa: { a: 0, k: 0 },
        },
      ],
    };
    return result;
  }

  // ─────────────────── Glyph rendering (opentype.js) ───────────────────
  function glyphToLottieSubpaths(glyph) {
    /** Строим Lottie-контуры напрямую из opentype commands.
     *  Не используем toPathData(): в WebView он может выдавать path-строки,
     *  которые плохо парсятся и превращают буквы в точки/черточки. */
    const path = glyph.path;
    if (!path || !Array.isArray(path.commands)) return [];
    const subpaths = [];
    let cur = null;
    let first = null;

    function ensure() {
      if (!cur) cur = { v: [], i: [], o: [], c: false };
      return cur;
    }
    function pushPoint(x, y, inTan = [0, 0]) {
      const sp = ensure();
      sp.v.push([x, -y]);
      sp.i.push([inTan[0], -inTan[1]]);
      sp.o.push([0, 0]);
    }
    function closeCurrent() {
      if (!cur) return;
      if (first && cur.v.length >= 2) {
        const last = cur.v[cur.v.length - 1];
        if (Math.abs(last[0] - first[0]) < 1e-6 && Math.abs(last[1] - first[1]) < 1e-6) {
          cur.i[0] = cur.i[cur.i.length - 1];
          cur.v.pop(); cur.i.pop(); cur.o.pop();
        }
      }
      cur.c = true;
      subpaths.push(cur);
      cur = null;
      first = null;
    }

    for (const c of path.commands) {
      if (c.type === "M") {
        if (cur) subpaths.push(cur);
        cur = { v: [], i: [], o: [], c: false };
        first = [c.x, -c.y];
        pushPoint(c.x, c.y);
      } else if (c.type === "L") {
        pushPoint(c.x, c.y);
      } else if (c.type === "C") {
        const sp = ensure();
        if (!sp.v.length) pushPoint(c.x, c.y);
        else {
          const prev = sp.v[sp.v.length - 1];
          sp.o[sp.o.length - 1] = [c.x1 - prev[0], -(c.y1 + prev[1])];
          pushPoint(c.x, c.y, [c.x2 - c.x, c.y2 - c.y]);
        }
      } else if (c.type === "Q") {
        const sp = ensure();
        if (!sp.v.length) pushPoint(c.x, c.y);
        else {
          const prev = sp.v[sp.v.length - 1];
          const prevY = -prev[1];
          const c1x = prev[0] + (2 / 3) * (c.x1 - prev[0]);
          const c1y = prevY + (2 / 3) * (c.y1 - prevY);
          const c2x = c.x + (2 / 3) * (c.x1 - c.x);
          const c2y = c.y + (2 / 3) * (c.y1 - c.y);
          sp.o[sp.o.length - 1] = [c1x - prev[0], -(c1y - prevY)];
          pushPoint(c.x, c.y, [c2x - c.x, c2y - c.y]);
        }
      } else if (c.type === "Z") {
        closeCurrent();
      }
    }
    if (cur) subpaths.push(cur);
    return subpaths;
  }

  function commandsToPathData(cmds) {
    /** Fallback на случай если нужно отладить opentype commands как SVG path. */
    const out = [];
    for (const c of cmds) {
      if (c.type === "M")      out.push(`M${c.x} ${c.y}`);
      else if (c.type === "L") out.push(`L${c.x} ${c.y}`);
      else if (c.type === "C") out.push(`C${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x} ${c.y}`);
      else if (c.type === "Q") out.push(`Q${c.x1} ${c.y1} ${c.x} ${c.y}`);
      else if (c.type === "Z") out.push("Z");
    }
    return out.join(" ");
  }

  function fontStack(font) {
    return (Array.isArray(font) ? font : [font]).filter(Boolean);
  }
  function primaryFont(font) {
    const stack = fontStack(font);
    return stack[0] || null;
  }
  function fontUnits(font) {
    return (font && (font.unitsPerEm || (font.tables && font.tables.head && font.tables.head.unitsPerEm))) || 1000;
  }
  function fontXHeight(font) {
    const os2 = (font && font.tables && font.tables.os2) || {};
    return os2.sxHeight || os2.sCapHeight || fontUnits(font) * 0.5;
  }
  function glyphRecordForChar(fonts, ch) {
    const stack = fontStack(fonts);
    const primary = stack[0];
    const primaryX = fontXHeight(primary);
    for (const font of stack) {
      let idx = null;
      try {
        idx = font.charToGlyphIndex ? font.charToGlyphIndex(ch) : null;
      } catch (_) {
        idx = null;
      }
      if (idx == null || idx === 0) continue;
      const glyph = font.glyphs && font.glyphs.get ? font.glyphs.get(idx) : font.charToGlyph(ch);
      if (!glyph || !glyph.path || !glyph.path.commands || !glyph.path.commands.length) continue;
      const scale = font === primary ? 1 : primaryX / Math.max(1, fontXHeight(font));
      return { font, glyph, scale };
    }
    return null;
  }
  function scaleSubpaths(subpaths, scale) {
    if (!subpaths || Math.abs(scale - 1) < 1e-6) return;
    for (const sp of subpaths) {
      for (const arrName of ["v", "i", "o"]) {
        for (const p of sp[arrName] || []) {
          p[0] *= scale;
          p[1] *= scale;
        }
      }
    }
  }

  function layoutText(font, text) {
    /** Раскладывает текст в Lottie-координатах: {glyphs: [{subpaths,bbox,advance}], width, xHeight}. */
    let cursor = 0;
    let allYmin = 0, allYmax = 0;
    const out = [];
    for (const ch of text) {
      const g = font.charToGlyph(ch);
      if (!g || !g.path || !g.path.commands || !g.path.commands.length) {
        cursor += font.unitsPerEm / 4;
        continue;
      }
      const subs = glyphToLottieSubpaths(g);
      // translate by cursor in X (только v, не tangents)
      for (const sp of subs) {
        for (const v of sp.v) v[0] += cursor;
      }
      // bbox этого глифа уже в Y-flipped
      const xs = [], ys = [];
      for (const sp of subs) for (const v of sp.v) { xs.push(v[0]); ys.push(v[1]); }
      const bbox = xs.length
        ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        : [0, 0, 0, 0];
      if (xs.length) {
        allYmin = Math.min(allYmin, bbox[1]);
        allYmax = Math.max(allYmax, bbox[3]);
      }
      out.push({ subpaths: subs, advance: g.advanceWidth || 0, bbox, char: ch });
      cursor += g.advanceWidth || 0;
    }
    // x_height — для масштаба
    const os2 = font.tables.os2 || {};
    const xHeight = os2.sxHeight || os2.sCapHeight || font.tables.head.unitsPerEm * 0.5;
    return { glyphs: out, width: cursor, xHeight, height: allYmax - allYmin, allYmin, allYmax };
  }

  function layoutText(font, text) {
    const fonts = fontStack(font);
    const baseFont = fonts[0];
    if (!baseFont) return { glyphs: [], width: 0, xHeight: 1, height: 0, allYmin: 0, allYmax: 0 };
    const baseUnits = fontUnits(baseFont);
    let cursor = 0;
    let allYmin = 0, allYmax = 0;
    const out = [];
    for (const ch of text) {
      const rec = glyphRecordForChar(fonts, ch);
      if (!rec) {
        cursor += baseUnits / 4;
        continue;
      }
      const subs = glyphToLottieSubpaths(rec.glyph);
      scaleSubpaths(subs, rec.scale);
      for (const sp of subs) {
        for (const v of sp.v) v[0] += cursor;
      }
      const xs = [], ys = [];
      for (const sp of subs) for (const v of sp.v) { xs.push(v[0]); ys.push(v[1]); }
      const bbox = xs.length
        ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        : [0, 0, 0, 0];
      if (xs.length) {
        allYmin = Math.min(allYmin, bbox[1]);
        allYmax = Math.max(allYmax, bbox[3]);
      }
      const advance = (rec.glyph.advanceWidth || 0) * rec.scale;
      out.push({ subpaths: subs, advance, bbox, char: ch });
      cursor += advance;
    }
    return {
      glyphs: out,
      width: cursor,
      xHeight: fontXHeight(baseFont),
      height: allYmax - allYmin,
      allYmin,
      allYmax,
    };
  }

  function renderTextToShapes(font, text, targetBbox) {
    /** Текст → массив Lottie 'sh' shape items, вписанных в targetBbox. */
    if (!text || !text.length || !font) return [];
    const layout = layoutText(font, text);
    if (layout.width <= 0) return [];
    const [tx0, ty0, tx1, ty1] = targetBbox;
    const tw = tx1 - tx0, th = ty1 - ty0;
    const naturalScale = th / layout.xHeight;
    const naturalWidth = layout.width * naturalScale;
    let scale = naturalWidth > tw ? tw / layout.width : naturalScale;
    if (layout.height > 0) scale = Math.min(scale, (th * 1.12) / layout.height);
    const finalW = layout.width * scale;
    const offX = tx0 + (tw - finalW) / 2;
    const textH = layout.height * scale;
    const offY = (ty0 + ty1) / 2 + textH / 2 - layout.allYmax * scale;
    const R = 2;
    const shapes = [];
    for (const g of layout.glyphs) {
      for (const sp of g.subpaths) {
        const v = sp.v.map(p => [+(p[0] * scale + offX).toFixed(R), +(p[1] * scale + offY).toFixed(R)]);
        const i = sp.i.map(p => [+(p[0] * scale).toFixed(R), +(p[1] * scale).toFixed(R)]);
        const o = sp.o.map(p => [+(p[0] * scale).toFixed(R), +(p[1] * scale).toFixed(R)]);
        shapes.push({
          ty: "sh",
          ks: { a: 0, k: { v, i, o, c: !!sp.c } },
        });
      }
    }
    return shapes;
  }

  function renderTextToShapeGroups(font, text, targetBbox) {
    /** Same fitting as renderTextToShapes, grouped by visible glyph for gradients. */
    if (!text || !text.length || !font) return [];
    const layout = layoutText(font, text);
    if (layout.width <= 0) return [];
    const [tx0, ty0, tx1, ty1] = targetBbox;
    const tw = tx1 - tx0, th = ty1 - ty0;
    const naturalScale = th / layout.xHeight;
    const naturalWidth = layout.width * naturalScale;
    let scale = naturalWidth > tw ? tw / layout.width : naturalScale;
    if (layout.height > 0) scale = Math.min(scale, (th * 1.12) / layout.height);
    const finalW = layout.width * scale;
    const offX = tx0 + (tw - finalW) / 2;
    const textH = layout.height * scale;
    const offY = (ty0 + ty1) / 2 + textH / 2 - layout.allYmax * scale;
    const R = 2;
    const groups = [];
    for (const g of layout.glyphs) {
      const group = [];
      for (const sp of g.subpaths) {
        const v = sp.v.map(p => [+(p[0] * scale + offX).toFixed(R), +(p[1] * scale + offY).toFixed(R)]);
        const i = sp.i.map(p => [+(p[0] * scale).toFixed(R), +(p[1] * scale).toFixed(R)]);
        const o = sp.o.map(p => [+(p[0] * scale).toFixed(R), +(p[1] * scale).toFixed(R)]);
        group.push({
          ty: "sh",
          ks: { a: 0, k: { v, i, o, c: !!sp.c } },
        });
      }
      if (group.length) groups.push(group);
    }
    return groups;
  }

  // ─────────────────── SVG → Lottie shapes ───────────────────
  function parseSvgPathD(d) {
    /** Простой парсер SVG path d → массив команд {type, args[]} абсолютных координат.
     *  Поддерживает M/m, L/l, H/h, V/v, C/c, S/s, Q/q, T/t, A/a, Z/z. */
    const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
    const cmds = [];
    let m;
    let cx = 0, cy = 0;        // current point
    let startX = 0, startY = 0;
    let lastCtrl = null, lastQCtrl = null;
    let prevType = null;
    while ((m = re.exec(d)) !== null) {
      const type = m[1];
      const argsStr = m[2].trim();
      const args = argsStr.length
        ? (argsStr.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [])
            .map(Number)
            .filter(n => !Number.isNaN(n))
        : [];
      const upper = type.toUpperCase();
      const rel = type !== upper;

      // Z
      if (upper === "Z") {
        cmds.push({ type: "Z" });
        cx = startX; cy = startY;
        prevType = "Z"; lastCtrl = null; lastQCtrl = null;
        continue;
      }

      let i = 0;
      // M — first pair is moveto, rest is implicit lineto
      if (upper === "M") {
        let first = true;
        while (i + 1 < args.length) {
          let x = args[i], y = args[i+1]; i += 2;
          if (rel) { x += cx; y += cy; }
          if (first) {
            cmds.push({ type: "M", x, y });
            startX = x; startY = y;
            first = false;
          } else {
            cmds.push({ type: "L", x, y });
          }
          cx = x; cy = y;
        }
      } else if (upper === "L") {
        while (i + 1 < args.length) {
          let x = args[i], y = args[i+1]; i += 2;
          if (rel) { x += cx; y += cy; }
          cmds.push({ type: "L", x, y });
          cx = x; cy = y;
        }
      } else if (upper === "H") {
        while (i < args.length) {
          let x = args[i++]; if (rel) x += cx;
          cmds.push({ type: "L", x, y: cy });
          cx = x;
        }
      } else if (upper === "V") {
        while (i < args.length) {
          let y = args[i++]; if (rel) y += cy;
          cmds.push({ type: "L", x: cx, y });
          cy = y;
        }
      } else if (upper === "C") {
        while (i + 5 < args.length) {
          let x1=args[i],y1=args[i+1],x2=args[i+2],y2=args[i+3],x=args[i+4],y=args[i+5]; i += 6;
          if (rel) { x1+=cx;y1+=cy;x2+=cx;y2+=cy;x+=cx;y+=cy; }
          cmds.push({ type: "C", x1, y1, x2, y2, x, y });
          lastCtrl = [x2, y2]; cx = x; cy = y; lastQCtrl = null;
        }
      } else if (upper === "S") {
        while (i + 3 < args.length) {
          let x2=args[i],y2=args[i+1],x=args[i+2],y=args[i+3]; i += 4;
          if (rel) { x2+=cx;y2+=cy;x+=cx;y+=cy; }
          let x1, y1;
          if (lastCtrl && (prevType === "C" || prevType === "S")) {
            x1 = 2*cx - lastCtrl[0]; y1 = 2*cy - lastCtrl[1];
          } else { x1 = cx; y1 = cy; }
          cmds.push({ type: "C", x1, y1, x2, y2, x, y });
          lastCtrl = [x2, y2]; cx = x; cy = y;
        }
      } else if (upper === "Q") {
        while (i + 3 < args.length) {
          let x1=args[i],y1=args[i+1],x=args[i+2],y=args[i+3]; i += 4;
          if (rel) { x1+=cx;y1+=cy;x+=cx;y+=cy; }
          cmds.push({ type: "Q", x1, y1, x, y });
          lastQCtrl = [x1, y1]; cx = x; cy = y; lastCtrl = null;
        }
      } else if (upper === "T") {
        while (i + 1 < args.length) {
          let x=args[i],y=args[i+1]; i += 2;
          if (rel) { x+=cx;y+=cy; }
          let x1, y1;
          if (lastQCtrl && (prevType === "Q" || prevType === "T")) {
            x1 = 2*cx - lastQCtrl[0]; y1 = 2*cy - lastQCtrl[1];
          } else { x1 = cx; y1 = cy; }
          cmds.push({ type: "Q", x1, y1, x, y });
          lastQCtrl = [x1, y1]; cx = x; cy = y;
        }
      } else if (upper === "A") {
        // Arc — конвертим в линию (упрощённо для превью).
        while (i + 6 < args.length) {
          i += 5;
          let x = args[i], y = args[i+1]; i += 2;
          if (rel) { x += cx; y += cy; }
          cmds.push({ type: "L", x, y });
          cx = x; cy = y;
        }
      }
      prevType = upper;
    }
    return cmds;
  }

  function svgPathToLottieSubpaths(d) {
    /** Парсим path d → конвертим в Lottie sh (без Y-flip — SVG и Lottie оба Y-down). */
    const cmds = parseSvgPathD(d);
    const subpaths = [];
    let cur = null;
    let firstPt = null;
    for (const c of cmds) {
      if (c.type === "M") {
        if (cur) subpaths.push(cur);
        cur = { v: [], i: [], o: [], c: false };
        firstPt = [c.x, c.y];
        cur.v.push([c.x, c.y]);
        cur.i.push([0, 0]); cur.o.push([0, 0]);
      } else if (c.type === "L") {
        if (!cur) continue;
        cur.v.push([c.x, c.y]);
        cur.i.push([0, 0]); cur.o.push([0, 0]);
      } else if (c.type === "C") {
        if (!cur) continue;
        const prev = cur.v[cur.v.length - 1];
        cur.o[cur.o.length - 1] = [c.x1 - prev[0], c.y1 - prev[1]];
        cur.v.push([c.x, c.y]);
        cur.i.push([c.x2 - c.x, c.y2 - c.y]);
        cur.o.push([0, 0]);
      } else if (c.type === "Q") {
        if (!cur) continue;
        const prev = cur.v[cur.v.length - 1];
        const c1 = [prev[0] + 2/3 * (c.x1 - prev[0]), prev[1] + 2/3 * (c.y1 - prev[1])];
        const c2 = [c.x + 2/3 * (c.x1 - c.x), c.y + 2/3 * (c.y1 - c.y)];
        cur.o[cur.o.length - 1] = [c1[0] - prev[0], c1[1] - prev[1]];
        cur.v.push([c.x, c.y]);
        cur.i.push([c2[0] - c.x, c2[1] - c.y]);
        cur.o.push([0, 0]);
      } else if (c.type === "Z") {
        if (!cur) continue;
        const last = cur.v[cur.v.length - 1];
        if (firstPt && cur.v.length >= 2 && last[0] === firstPt[0] && last[1] === firstPt[1]) {
          cur.i[0] = cur.i[cur.i.length - 1];
          cur.v.pop(); cur.i.pop(); cur.o.pop();
        }
        cur.c = true;
        subpaths.push(cur); cur = null;
      }
    }
    if (cur) { cur.c = false; subpaths.push(cur); }
    return subpaths;
  }

  // ── SVG helpers ──────────────────────────
  function parseSvgNumber(v, def) {
    const n = parseFloat(v);
    return Number.isNaN(n) ? def : n;
  }
  function rectToPath(x, y, w, h, rx, ry) {
    x = parseSvgNumber(x, 0); y = parseSvgNumber(y, 0);
    w = parseSvgNumber(w, 0); h = parseSvgNumber(h, 0);
    rx = parseSvgNumber(rx, 0); ry = parseSvgNumber(ry, rx || 0);
    if (!w || !h) return "";
    if (rx <= 0 && ry <= 0) {
      return `M${x} ${y}h${w}v${h}h${-w}Z`;
    }
    const r = Math.min(rx, w / 2);
    const r2 = Math.min(ry, h / 2);
    return `M${x + r} ${y}`
      + `h${w - 2 * r}a${r} ${r2} 0 0 1 ${r} ${r2}v${h - 2 * r2}`
      + `a${r} ${r2} 0 0 1 ${-r} ${r2}h${-(w - 2 * r)}`
      + `a${r} ${r2} 0 0 1 ${-r} ${-r2}v${-(h - 2 * r2)}`
      + `a${r} ${r2} 0 0 1 ${r} ${-r2}Z`;
  }
  function circleToPath(cx, cy, r) {
    cx = parseSvgNumber(cx, 0); cy = parseSvgNumber(cy, 0); r = parseSvgNumber(r, 0);
    if (!r) return "";
    return `M${cx} ${cy - r}a${r} ${r} 0 1 0 0 ${2 * r}a${r} ${r} 0 1 0 0 ${-2 * r}Z`;
  }
  function ellipseToPath(cx, cy, rx, ry) {
    cx = parseSvgNumber(cx, 0); cy = parseSvgNumber(cy, 0);
    rx = parseSvgNumber(rx, 0); ry = parseSvgNumber(ry, 0);
    if (!rx || !ry) return "";
    return `M${cx} ${cy - ry}a${rx} ${ry} 0 1 0 0 ${2 * ry}a${rx} ${ry} 0 1 0 0 ${-2 * ry}Z`;
  }
  function lineToPath(x1, y1, x2, y2) {
    x1 = parseSvgNumber(x1, 0); y1 = parseSvgNumber(y1, 0);
    x2 = parseSvgNumber(x2, 0); y2 = parseSvgNumber(y2, 0);
    return `M${x1} ${y1}L${x2} ${y2}`;
  }
  function polyToPath(points, close) {
    const pts = (points || "").trim().split(/[\s,]+/).map(parseFloat).filter(n => !Number.isNaN(n));
    if (pts.length < 4) return "";
    let d = `M${pts[0]} ${pts[1]}`;
    for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
    if (close) d += "Z";
    return d;
  }

  function identityMatrix() {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
  function parseTransformArgs(raw) {
    return String(raw || "")
      .trim()
      .split(/[\s,]+/)
      .map(parseFloat)
      .filter(n => !Number.isNaN(n));
  }
  function parseTransformMatrix(el) {
    /** Возвращает {a,b,c,d,e,f} матрицу трансформации (по умолчанию identity). */
    let m = identityMatrix();
    const t = (el.getAttribute && el.getAttribute("transform")) || "";
    if (!t) return m;
    const ops = String(t).match(/[a-zA-Z]+\([^)]*\)/g) || [];
    for (const op of ops) {
      const mm = op.match(/^([a-zA-Z]+)\(([^)]*)\)$/);
      if (!mm) continue;
      const kind = mm[1].toLowerCase();
      const args = parseTransformArgs(mm[2]);
      let cur = identityMatrix();
      if (kind === "matrix" && args.length >= 6) {
        cur = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
      } else if (kind === "translate" && args.length >= 1) {
        cur.e = args[0];
        cur.f = args.length >= 2 ? args[1] : 0;
      } else if (kind === "scale" && args.length >= 1) {
        cur.a = args[0];
        cur.d = args.length >= 2 ? args[1] : args[0];
      } else if (kind === "rotate" && args.length >= 1) {
        const ang = args[0] * Math.PI / 180;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        cur = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
        if (args.length >= 3) {
          const cx = args[1], cy = args[2];
          cur.e = cx - cx * cos + cy * sin;
          cur.f = cy - cx * sin - cy * cos;
        }
      } else if (kind === "skewx" && args.length >= 1) {
        cur.c = Math.tan(args[0] * Math.PI / 180);
      } else if (kind === "skewy" && args.length >= 1) {
        cur.b = Math.tan(args[0] * Math.PI / 180);
      } else {
        continue;
      }
      m = multiplyMatrix(m, cur);
    }
    return m;
  }
  function multiplyMatrix(a, b) {
    return {
      a: a.a * b.a + a.c * b.b,
      b: a.b * b.a + a.d * b.b,
      c: a.a * b.c + a.c * b.d,
      d: a.b * b.c + a.d * b.d,
      e: a.a * b.e + a.c * b.f + a.e,
      f: a.b * b.e + a.d * b.f + a.f,
    };
  }
  function applyMatrixToSubpaths(subpaths, m) {
    if (!m || (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0)) return;
    for (const sp of subpaths) {
      for (const pt of sp.v) {
        const x = pt[0], y = pt[1];
        pt[0] = +(m.a * x + m.c * y + m.e).toFixed(3);
        pt[1] = +(m.b * x + m.d * y + m.f).toFixed(3);
      }
      for (const arr of [sp.i, sp.o]) {
        for (const pt of arr) {
          const x = pt[0], y = pt[1];
          pt[0] = +(m.a * x + m.c * y).toFixed(3);
          pt[1] = +(m.b * x + m.d * y).toFixed(3);
        }
      }
    }
  }

  function svgToLottieShapes(svgText) {
    /** SVG-text → {shapes: [Lottie sh...], bbox: [xmin,ymin,xmax,ymax]}.
     *  Учитывает viewBox, width/height, transform и базовые shape-элементы. */
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = doc.documentElement;

    // ViewBox scaling
    const vb = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(parseFloat).filter(n => !Number.isNaN(n));
    let scaleX = 1, scaleY = 1, offX = 0, offY = 0;
    if (vb.length === 4) {
      const [, , vbW, vbH] = vb;
      const w = parseSvgNumber(root.getAttribute("width"), vbW);
      const h = parseSvgNumber(root.getAttribute("height"), vbH);
      if (vbW > 0 && w > 0) scaleX = w / vbW;
      if (vbH > 0 && h > 0) scaleY = h / vbH;
      offX = vb[0];
      offY = vb[1];
    }
    const svgMatrix = { a: scaleX, b: 0, c: 0, d: scaleY, e: -offX * scaleX, f: -offY * scaleY };

    const subpaths = [];
    const allPts = [];

    function walk(el, parentMatrix) {
      if (!el || el.nodeType !== 1) return;
      const tag = (el.tagName || "").toLowerCase();
      let d = "";
      if (tag === "path") {
        d = el.getAttribute("d") || "";
      } else if (tag === "rect") {
        d = rectToPath(el.getAttribute("x"), el.getAttribute("y"),
                       el.getAttribute("width"), el.getAttribute("height"),
                       el.getAttribute("rx"), el.getAttribute("ry"));
      } else if (tag === "circle") {
        d = circleToPath(el.getAttribute("cx"), el.getAttribute("cy"), el.getAttribute("r"));
      } else if (tag === "ellipse") {
        d = ellipseToPath(el.getAttribute("cx"), el.getAttribute("cy"),
                          el.getAttribute("rx"), el.getAttribute("ry"));
      } else if (tag === "line") {
        d = lineToPath(el.getAttribute("x1"), el.getAttribute("y1"),
                       el.getAttribute("x2"), el.getAttribute("y2"));
      } else if (tag === "polyline") {
        d = polyToPath(el.getAttribute("points"), false);
      } else if (tag === "polygon") {
        d = polyToPath(el.getAttribute("points"), true);
      }

      if (d) {
        const sps = svgPathToLottieSubpaths(d);
        const localMatrix = multiplyMatrix(parentMatrix, parseTransformMatrix(el));
        applyMatrixToSubpaths(sps, localMatrix);
        for (const sp of sps) {
          subpaths.push(sp);
          for (const v of sp.v) allPts.push(v);
        }
      }

      for (const child of el.children || []) walk(child, multiplyMatrix(parentMatrix, parseTransformMatrix(el)));
    }
    walk(root, svgMatrix);

    let bbox;
    if (allPts.length) {
      const xs = allPts.map(p => p[0]);
      const ys = allPts.map(p => p[1]);
      bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    } else {
      bbox = [0, 0, 1, 1];
    }
    const shapes = subpaths.map(sp => ({
      ty: "sh",
      ks: { a: 0, k: { v: sp.v, i: sp.i, o: sp.o, c: !!sp.c } },
    }));
    return { shapes, bbox };
  }

  function transformShapes(shapes, t, bbox) {
    /** Применяет rotation, scale и offset напрямую к координатам vertices.
     *  Избегает проблем с anchor point в Lottie transform-группе. */
    const cx = (bbox[0] + bbox[2]) / 2;
    const cy = (bbox[1] + bbox[3]) / 2;
    const scale = t.scale || 1;
    const rot = (t.rotation || 0) * Math.PI / 180;
    const offsetX = t.offset_x || 0;
    const offsetY = t.offset_y || 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const R = 2;
    return shapes.map(sh => {
      const k = sh.ks && sh.ks.k;
      if (!k || !Array.isArray(k.v)) return sh;
      const newV = k.v.map(v => {
        let x = (v[0] - cx) * scale;
        let y = (v[1] - cy) * scale;
        const xr = x * cos - y * sin;
        const yr = x * sin + y * cos;
        return [+(xr + cx + offsetX).toFixed(R), +(yr + cy + offsetY).toFixed(R)];
      });
      const tx = (pt) => {
        let x = pt[0] * scale;
        let y = pt[1] * scale;
        const xr = x * cos - y * sin;
        const yr = x * sin + y * cos;
        return [+xr.toFixed(R), +yr.toFixed(R)];
      };
      return {
        ty: "sh",
        ks: { a: 0, k: { v: newV, i: k.i.map(tx), o: k.o.map(tx), c: !!k.c } },
      };
    });
  }

  function placeLogoInBox(logoShapes, logoBbox, centerLocal, targetW, targetH, fitRatio) {
    /** Скейлит и центрирует SVG-лого в локальной системе координат группы. */
    const [lxmin, lymin, lxmax, lymax] = logoBbox;
    const lw = Math.max(1e-3, lxmax - lxmin);
    const lh = Math.max(1e-3, lymax - lymin);
    const sx = (targetW * fitRatio) / lw;
    const sy = (targetH * fitRatio) / lh;
    const s = Math.min(sx, sy);
    const finalW = lw * s, finalH = lh * s;
    const offX = centerLocal[0] - finalW / 2 - lxmin * s;
    const offY = centerLocal[1] - finalH / 2 - lymin * s;
    const R = 2;
    const out = [];
    for (const sh of logoShapes) {
      const k = sh.ks.k;
      out.push({
        ty: "sh",
        ks: { a: 0, k: {
          v: k.v.map(v => [+(v[0]*s + offX).toFixed(R), +(v[1]*s + offY).toFixed(R)]),
          i: k.i.map(t => [+(t[0]*s).toFixed(R), +(t[1]*s).toFixed(R)]),
          o: k.o.map(t => [+(t[0]*s).toFixed(R), +(t[1]*s).toFixed(R)]),
          c: !!k.c,
        }},
      });
    }
    return out;
  }

  function hexToLottieColor(hex) {
    const s = String(hex || "").trim();
    const m = s.match(/^#([0-9a-fA-F]{6})$/);
    if (!m) return { a: 0, k: [1, 1, 1, 1] };
    const raw = m[1];
    return {
      a: 0,
      k: [
        parseInt(raw.slice(0, 2), 16) / 255,
        parseInt(raw.slice(2, 4), 16) / 255,
        parseInt(raw.slice(4, 6), 16) / 255,
        1,
      ],
    };
  }

  function contrastStrokeHex(hex) {
    const h = normHex(hex) || "#ffffff";
    const raw = h.slice(1);
    const r = parseInt(raw.slice(0, 2), 16) / 255;
    const g = parseInt(raw.slice(2, 4), 16) / 255;
    const b = parseInt(raw.slice(4, 6), 16) / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luma >= 0.58 ? "#000000" : "#ffffff";
  }

  function textStrokeColorFor(hex, fallbackColor) {
    const h = normHex(hex);
    return h ? hexToLottieColor(contrastStrokeHex(h)) : fallbackColor;
  }

  function normalizeTextGradient(gradient) {
    if (!gradient || typeof gradient !== "object" || !gradient.enabled) return null;
    const from = normHex(gradient.from) || "#ffffff";
    const to = normHex(gradient.to) || "#30d158";
    return { from, to };
  }

  function mixHexColor(from, to, t) {
    const a = (normHex(from) || "#ffffff").slice(1);
    const b = (normHex(to) || "#30d158").slice(1);
    const vals = [];
    const pct = Math.max(0, Math.min(1, +t || 0));
    for (let i = 0; i < 6; i += 2) {
      const av = parseInt(a.slice(i, i + 2), 16);
      const bv = parseInt(b.slice(i, i + 2), 16);
      vals.push(Math.round(av + (bv - av) * pct));
    }
    return "#" + vals.map(v => v.toString(16).padStart(2, "0")).join("");
  }

  function identityTrItem() {
    return {
      ty: "tr",
      p: { a: 0, k: [0, 0] },
      a: { a: 0, k: [0, 0] },
      s: { a: 0, k: [100, 100] },
      r: { a: 0, k: 0 },
      o: { a: 0, k: 100 },
      sk: { a: 0, k: 0 },
      sa: { a: 0, k: 0 },
    };
  }

  function styleItemsWithColor(fillStroke, color) {
    const out = [];
    let hasFill = false;
    for (const item of fillStroke || []) {
      if (!item) continue;
      if (item.ty === "fl") {
        hasFill = true;
        out.push({ ...JSON.parse(JSON.stringify(item)), c: color });
      }
    }
    if (!hasFill) {
      out.push({
        ty: "fl",
        c: color,
        o: { a: 0, k: 100 },
        r: 1,
        bm: 0,
        nm: "Fill",
      });
    }
    return out;
  }

  function regroupShapes(flat, lengths) {
    const out = [];
    let pos = 0;
    for (const len of lengths) {
      out.push(flat.slice(pos, pos + len));
      pos += len;
    }
    return out;
  }

  function gradientShapeGroups(shapeGroups, fillStroke, gradient) {
    const spec = normalizeTextGradient(gradient);
    const visible = (shapeGroups || []).filter(g => g && g.length);
    if (!spec || !visible.length) return null;
    const last = Math.max(1, visible.length - 1);
    return visible.map((group, idx) => {
      const phase = idx / last;
      const hex = mixHexColor(spec.from, spec.to, phase);
      const color = hexToLottieColor(hex);
      return {
        ty: "gr",
        nm: "swex_gradient_glyph",
        it: [
          ...group,
          ...styleItemsWithColor(fillStroke, color),
          identityTrItem(),
        ],
      };
    });
  }

  function applyColorToNode(node, color) {
    /** Рекурсивно применяет цвет ко всем fill (ty=fl) и stroke (ty=st) в узле. */
    if (!node || typeof node !== "object") return;
    if (node.ty === "fl" && node.c) node.c = color;
    if (node.ty === "st" && node.c) node.c = color;
    if (Array.isArray(node.it)) for (const child of node.it) applyColorToNode(child, color);
    if (Array.isArray(node.shapes)) for (const child of node.shapes) applyColorToNode(child, color);
  }

  // ─────────────────── swex_text_* line overrides (passport) ───────────────────
  function findSwexTextGroups(tree) {
    /** Возвращает [{parent, idx, gr, nm}] для каждого gr с nm='swex_text_*'. */
    const out = [];
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== "object") return;
      for (const k of ["layers", "assets", "shapes", "it"]) {
        const v = node[k];
        if (Array.isArray(v)) {
          v.forEach((c, i) => {
            if (c && typeof c === "object" && c.ty === "gr"
                && typeof c.nm === "string"
                && c.nm.startsWith("swex_text_")) {
              out.push({ parent: v, idx: i, gr: c, nm: c.nm });
            }
          });
          v.forEach(visit);
        }
      }
    }
    visit(tree);
    return out;
  }

  function grTextBBox(gr) {
    const pts = [];
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== "object") return;
      if (node.ty === "sh") {
        const k = node.ks && node.ks.k;
        if (k && Array.isArray(k.v)) for (const v of k.v) pts.push([v[0], v[1]]);
      }
      for (const kk of ["it", "shapes"]) {
        if (Array.isArray(node[kk])) for (const c of node[kk]) visit(c);
      }
    }
    visit(gr);
    if (!pts.length) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  function shapesLeftmostX(shapes) {
    let out = null;
    for (const sh of shapes) {
      const k = sh.ks && sh.ks.k;
      if (!k || !Array.isArray(k.v)) continue;
      for (const v of k.v) {
        const x = +v[0];
        out = (out === null) ? x : Math.min(out, x);
      }
    }
    return out;
  }
  function shiftShapesX(shapes, dx) {
    if (Math.abs(dx) < 1e-6) return;
    for (const sh of shapes) {
      const k = sh.ks && sh.ks.k;
      if (!k || !Array.isArray(k.v)) continue;
      for (const v of k.v) v[0] += dx;
    }
  }

  function applyLinesOverride(tree, lines, font, contentColor) {
    if (!Array.isArray(lines) || !lines.length || !font) return;
    const lineMap = {};
    const styles = {};
    for (const l of lines) {
      if (!l || !l.name) continue;
      if (typeof l.text === "string" && l.text.trim() !== "") {
        lineMap[l.name] = l.text;
      }
      if (typeof l.scale === "number" || typeof l.color === "string"
          || typeof l.offset_x === "number" || typeof l.offset_y === "number") {
        styles[l.name] = {
          scale:    (typeof l.scale === "number") ? l.scale : 1,
          color:    (typeof l.color === "string") ? l.color : null,
          offset_x: (typeof l.offset_x === "number") ? l.offset_x : 0,
          offset_y: (typeof l.offset_y === "number") ? l.offset_y : 0,
        };
      }
    }
    if (!Object.keys(lineMap).length) return;
    const lineStyle = (nm) => styles[nm] || null;
    const groups = findSwexTextGroups(tree);
    if (!groups.length) return;
    const rows = [];
    for (const g of groups) {
      const bbox = grTextBBox(g.gr);
      if (bbox) rows.push({ ...g, bbox });
    }
    if (!rows.length) return;
    // Anchor each row to its OWN local bbox[0] — different rows have
    // different lefts that the designer tuned to align visually on
    // canvas given their layer transforms. Per-line offset_x slider is
    // the user's manual override.
    const xHeight = fontXHeight(primaryFont(font)) || 500;
    for (const r of rows) {
      const newText = lineMap[r.nm];
      if (newText == null) continue;
      const bb = r.bbox;
      const cy = (bb[1] + bb[3]) / 2;
      const rowLeft = bb[0];
      const bakedText = r.nm.replace(/^swex_text_/, "");
      const lb = layoutText(font, bakedText);
      const bakedH = (lb && lb.height > 0) ? lb.height : xHeight;
      const bakedScale = (bb[3] - bb[1]) / Math.max(1, bakedH);
      const targetH = bakedScale * xHeight;
      const target = [-600, cy - targetH / 2, 600, cy + targetH / 2];
      const shapes = renderTextToShapes(font, newText, target);
      if (!shapes.length) continue;
      const curLeft = shapesLeftmostX(shapes);
      if (curLeft !== null) shiftShapesX(shapes, rowLeft - curLeft);
      // Per-line scale (anchored on rowLeft, cy of the row).
      const line = (typeof lineStyle === "function") ? lineStyle(r.nm) : null;
      const perScale = (line && typeof line.scale === "number") ? line.scale : 1;
      if (Math.abs(perScale - 1) > 1e-6) {
        for (const sh of shapes) {
          const k = sh.ks && sh.ks.k;
          if (!k) continue;
          if (Array.isArray(k.v)) {
            for (const v of k.v) {
              v[0] = rowLeft + (v[0] - rowLeft) * perScale;
              v[1] = cy + (v[1] - cy) * perScale;
            }
          }
          for (const arrName of ["i", "o"]) {
            if (Array.isArray(k[arrName])) for (const t of k[arrName]) {
              t[0] *= perScale; t[1] *= perScale;
            }
          }
        }
      }
      // Per-line position offset (translates every vertex; tangents are
      // deltas so they're unchanged).
      const perOx = (line && typeof line.offset_x === "number") ? line.offset_x : 0;
      const perOy = (line && typeof line.offset_y === "number") ? line.offset_y : 0;
      if (Math.abs(perOx) > 1e-6 || Math.abs(perOy) > 1e-6) {
        for (const sh of shapes) {
          const k = sh.ks && sh.ks.k;
          if (!k || !Array.isArray(k.v)) continue;
          for (const v of k.v) { v[0] += perOx; v[1] += perOy; }
        }
      }
      const lineColor = (line && typeof line.color === "string")
        ? hexToLottieColor(line.color)
        : contentColor;
      r.parent[r.idx] = {
        ty: "gr",
        nm: r.nm,
        it: [
          ...shapes,
          { ty: "fl", c: lineColor, o: { a: 0, k: 100 }, r: 1, bm: 0, nm: "Fill" },
          { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 },
            o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } },
        ],
      };
    }
  }

  function findQmarkGroups(tree) {
    const out = [];
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== "object") return;
      for (const k of ["layers", "assets", "shapes", "it"]) {
        const v = node[k];
        if (Array.isArray(v)) {
          v.forEach((c, i) => {
            if (c && c.ty === "gr" && c.nm === "swex_qmark") {
              out.push({ parent: v, idx: i, gr: c });
            }
          });
          v.forEach(visit);
        }
      }
    }
    visit(tree);
    return out;
  }

  function applyQmarkCleanup(tree, font, photoSvgB64, photoScale, photoColorHex) {
    const groups = findQmarkGroups(tree);
    if (!groups.length) return;
    // SVG-photo path: parse once, fit inside every qmark group's bbox.
    let svgData = null;
    if (photoSvgB64) {
      try {
        const svgText = decodeURIComponent(escape(atob(photoSvgB64)));
        const parsed = svgToLottieShapes(svgText);
        if (parsed && parsed.shapes && parsed.shapes.length) svgData = parsed;
      } catch (_) { svgData = null; }
    }
    if (!font && !svgData) return;
    const scale = Math.max(0.3, Math.min(3.0, +photoScale || 1.0));
    const photoColor = hexToLottieColor(normHex(photoColorHex) || "#ffffff");
    for (const g of groups) {
      const bb = grTextBBox(g.gr);
      if (!bb) continue;
      const cx = (bb[0] + bb[2]) / 2;
      const cy = (bb[1] + bb[3]) / 2;
      if (svgData) {
        const size = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 1.05 * scale;
        const shapes = placeLogoInBox(svgData.shapes, svgData.bbox,
                                      [cx, cy], size, size, 0.9);
        const extras = [];
        for (const it of g.gr.it || []) {
          if (it && it.ty === "tr") extras.push(it);
        }
        if (!extras.length) {
          extras.push({ ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] },
                        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 },
                        o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } });
        }
        g.parent[g.idx] = { ty: "gr", nm: "swex_qmark", it: [
          ...shapes,
          { ty: "fl", c: photoColor, o: { a: 0, k: 100 }, r: 1, bm: 0, nm: "Fill" },
          ...extras,
        ]};
        continue;
      }
      const size = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 1.35;
      const target = [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2];
      const shapes = renderTextToShapes(font, "?", target);
      if (!shapes.length) continue;
      // Recentre — the font's '?' isn't symmetric.
      const pts = [];
      for (const sh of shapes) {
        const k = sh.ks && sh.ks.k;
        if (k && Array.isArray(k.v)) for (const v of k.v) pts.push(v);
      }
      if (pts.length) {
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const newCx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const newCy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const dx = cx - newCx, dy = cy - newCy;
        if (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3) {
          for (const sh of shapes) {
            const k = sh.ks && sh.ks.k;
            if (k && Array.isArray(k.v)) for (const v of k.v) { v[0] += dx; v[1] += dy; }
          }
        }
      }
      // Keep existing fl/st/tr items (white fill, identity tr).
      const extras = [];
      for (const it of g.gr.it || []) {
        if (it && (it.ty === "fl" || it.ty === "st" || it.ty === "tr")) extras.push(it);
      }
      if (!extras.some(e => e.ty === "fl")) {
        extras.push({ ty: "fl", c: { a: 0, k: [1, 1, 1, 1] },
                      o: { a: 0, k: 100 }, r: 1, bm: 0, nm: "Fill" });
      }
      if (!extras.some(e => e.ty === "tr")) {
        extras.push({ ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] },
                      s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 },
                      o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } });
      }
      g.parent[g.idx] = { ty: "gr", nm: "swex_qmark", it: [...shapes, ...extras] };
    }
  }

  // ─────────────────── Apply override to Lottie tree ───────────────────
  function passportHeaderLine(override) {
    const lines = override && Array.isArray(override.lines) ? override.lines : [];
    return lines.find(l => l && l.name === "__header__") || null;
  }

  function choosePassportHeaderContainer(containers) {
    const list = (containers || []).filter(c => c && Array.isArray(c.idxs) && c.bbox);
    if (!list.length) return null;
    return list.slice().sort((a, b) => {
      const ay = +a.bbox[1] || 0;
      const by = +b.bbox[1] || 0;
      if (Math.abs(ay - by) > 1e-6) return ay - by;
      return (+a.bbox[0] || 0) - (+b.bbox[0] || 0);
    })[0];
  }

  function sameContainer(a, b) {
    return !!(a && b && a.parentList === b.parentList
      && JSON.stringify(a.idxs || []) === JSON.stringify(b.idxs || []));
  }

  function removeContainerLetters(container) {
    if (!container || !Array.isArray(container.parentList)) return;
    const sortedDesc = [...(container.idxs || [])].sort((a, b) => b - a);
    for (const i of sortedDesc) container.parentList.splice(i, 1);
  }

  function nextLayerInd(json) {
    const layers = Array.isArray(json.layers) ? json.layers : [];
    let maxInd = 0;
    for (const layer of layers) {
      const n = Number(layer && layer.ind);
      if (Number.isFinite(n)) maxInd = Math.max(maxInd, n);
    }
    return maxInd + 1;
  }

  function customOverlayLayer(json, items, name) {
    return {
      ddd: 0,
      ind: nextLayerInd(json),
      ty: 4,
      nm: name || "swex_custom_overlay",
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [0, 0, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [{ ty: "gr", nm: "swex_custom_group", it: items }],
      ip: 0,
      op: Number(json.op) || 180,
      st: 0,
      bm: 0,
    };
  }

  function staticScale(prop) {
    if (!prop || typeof prop !== "object") return [1, 1];
    if (prop.a === 0) {
      const k = prop.k;
      if (Array.isArray(k) && k.length >= 2) return [Number(k[0]) / 100 || 1, Number(k[1]) / 100 || 1];
      return [1, 1];
    }
    const frames = Array.isArray(prop.k) ? prop.k : [];
    let best = null;
    let bestMag = -1;
    for (const frame of frames) {
      const s = frame && frame.s;
      if (!Array.isArray(s) || s.length < 2) continue;
      const sx = Number(s[0]) / 100 || 1;
      const sy = Number(s[1]) / 100 || 1;
      const mag = Math.abs(sx) + Math.abs(sy);
      if (mag > bestMag) {
        bestMag = mag;
        best = [sx, sy];
      }
    }
    return best || [1, 1];
  }

  function staticPos(prop) {
    if (!prop || typeof prop !== "object") return [0, 0];
    if (prop.a === 0) {
      const k = prop.k;
      if (Array.isArray(k) && k.length >= 2) return [Number(k[0]) || 0, Number(k[1]) || 0];
      return [0, 0];
    }
    const frames = Array.isArray(prop.k) ? prop.k : [];
    const xs = [];
    const ys = [];
    for (const frame of frames) {
      const s = frame && frame.s;
      if (!Array.isArray(s) || s.length < 2) continue;
      xs.push(Number(s[0]) || 0);
      ys.push(Number(s[1]) || 0);
    }
    if (!xs.length) return [0, 0];
    return [
      xs.reduce((a, b) => a + b, 0) / xs.length,
      ys.reduce((a, b) => a + b, 0) / ys.length,
    ];
  }

  function applyXform(ksOrTr, xform) {
    if (!ksOrTr || typeof ksOrTr !== "object") return xform;
    const [sx, sy, ox, oy] = xform;
    const [lsx, lsy] = staticScale(ksOrTr.s || {});
    const [lpx, lpy] = staticPos(ksOrTr.p || {});
    const [lax, lay] = staticPos(ksOrTr.a || {});
    return [
      sx * lsx,
      sy * lsy,
      ox + sx * (lpx - lsx * lax),
      oy + sy * (lpy - lsy * lay),
    ];
  }

  // ─────────── Per-frame variants (live preview animation) ───────────
  // staticScale/staticPos above collapse an animated property to one
  // "representative" value (picked/averaged) — good enough for a single
  // rest-state badge box. To make the PNG-logo preview overlay actually
  // track the sticker's own animation, these instead linearly interpolate
  // the property AT a given frame (bezier ease curves ignored — a close
  // enough approximation for an overlay, not the final render).
  function keyframeValueAt(frames, frame) {
    if (!Array.isArray(frames) || !frames.length) return null;
    for (let i = 0; i < frames.length; i++) {
      const kf = frames[i];
      const next = frames[i + 1];
      if (!kf || !Array.isArray(kf.s)) continue;
      if (!next) return kf.s;
      const t0 = Number(kf.t) || 0;
      const t1 = Number(next.t) || t0;
      if (frame <= t1) {
        if (kf.h || !Array.isArray(next.s)) return kf.s;
        const span = Math.max(1e-6, t1 - t0);
        const frac = Math.max(0, Math.min(1, (frame - t0) / span));
        return kf.s.map((v, idx) => {
          const v1 = next.s[idx];
          return v1 == null ? v : v + (v1 - v) * frac;
        });
      }
    }
    const last = frames[frames.length - 1];
    return last && Array.isArray(last.s) ? last.s : null;
  }
  function scaleAtFrame(prop, frame) {
    if (!prop || typeof prop !== "object") return [1, 1];
    if (prop.a === 0) {
      const k = prop.k;
      if (Array.isArray(k) && k.length >= 2) return [Number(k[0]) / 100 || 1, Number(k[1]) / 100 || 1];
      return [1, 1];
    }
    const v = keyframeValueAt(prop.k, frame);
    if (!Array.isArray(v) || v.length < 2) return [1, 1];
    return [Number(v[0]) / 100 || 1, Number(v[1]) / 100 || 1];
  }
  function posAtFrame(prop, frame) {
    if (!prop || typeof prop !== "object") return [0, 0];
    if (prop.a === 0) {
      const k = prop.k;
      if (Array.isArray(k) && k.length >= 2) return [Number(k[0]) || 0, Number(k[1]) || 0];
      return [0, 0];
    }
    const v = keyframeValueAt(prop.k, frame);
    if (!Array.isArray(v) || v.length < 2) return [0, 0];
    return [Number(v[0]) || 0, Number(v[1]) || 0];
  }
  function applyXformAtFrame(ksOrTr, xform, frame) {
    if (!ksOrTr || typeof ksOrTr !== "object") return xform;
    const [sx, sy, ox, oy] = xform;
    const [lsx, lsy] = scaleAtFrame(ksOrTr.s || {}, frame);
    const [lpx, lpy] = posAtFrame(ksOrTr.p || {}, frame);
    const [lax, lay] = posAtFrame(ksOrTr.a || {}, frame);
    return [
      sx * lsx,
      sy * lsy,
      ox + sx * (lpx - lsx * lax),
      oy + sy * (lpy - lsy * lay),
    ];
  }
  // Mirror of services/swex/replacer.py:_swex_canvas_xform_candidates,
  // evaluated at a specific animation frame instead of picking one
  // "rest-state" candidate. Returns the first (sx, sy, ox, oy) reached
  // while walking to a shape named in `targetNames` (default: the swex
  // letters), resolving precomp refIds and layer parenting the same way.
  function swexCanvasXformAtFrame(tree, frame, targetNames) {
    const names = targetNames || LETTER_NAMES;
    const assets = {};
    for (const asset of tree.assets || []) {
      if (asset && asset.id) assets[asset.id] = asset;
    }
    let found = null;
    function walkShape(shape, xform, depth) {
      if (found || depth > 24 || !shape || typeof shape !== "object") return;
      const nm = shape.nm || "";
      if (names.has(nm)) { found = xform; return; }
      if (shape.ty === "gr") {
        const it = Array.isArray(shape.it) ? shape.it : [];
        const tr = it.find(c => c && c.ty === "tr") || null;
        const childXform = tr ? applyXformAtFrame(tr, xform, frame) : xform;
        for (const c of it) {
          if (c === tr) continue;
          walkShape(c, childXform, depth + 1);
          if (found) return;
        }
      }
    }
    function walkComposition(layers, outerXform, depth) {
      if (found || !Array.isArray(layers) || depth > 24) return;
      const byInd = {};
      for (const L of layers) {
        if (L && L.ind != null) byInd[L.ind] = L;
      }
      const cache = {};
      const resolving = new Set();
      function resolve(layer) {
        const ind = layer.ind;
        if (ind in cache) return cache[ind];
        if (resolving.has(ind)) return outerXform;
        resolving.add(ind);
        const parentInd = layer.parent;
        const parentXform = (parentInd != null && byInd[parentInd])
          ? resolve(byInd[parentInd]) : outerXform;
        const myXform = applyXformAtFrame(layer.ks, parentXform, frame);
        resolving.delete(ind);
        cache[ind] = myXform;
        return myXform;
      }
      for (const L of layers) {
        if (found) return;
        if (!L || typeof L !== "object") continue;
        const layerXform = resolve(L);
        if (L.ty === 0) {
          const asset = assets[L.refId];
          if (asset) walkComposition(asset.layers || [], layerXform, depth + 1);
        } else if (L.ty === 4) {
          for (const shape of L.shapes || []) {
            walkShape(shape, layerXform, 0);
            if (found) break;
          }
        }
      }
    }
    walkComposition(tree.layers || [], [1, 1, 0, 0], 0);
    return found;
  }

  function mergeBBox(a, b) {
    if (!a) return b;
    if (!b) return a;
    return [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3]),
    ];
  }

  function shapeCanvasBBox(node, xform, depth = 0) {
    if (!node || typeof node !== "object" || depth > 24) return null;
    if (node.hd) return null;
    if (node.ty === "sh") {
      const k = node.ks && node.ks.k;
      if (!k || !Array.isArray(k.v)) return null;
      const pts = k.v.map(v => [xform[2] + xform[0] * Number(v[0]), xform[3] + xform[1] * Number(v[1])])
        .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (!pts.length) return null;
      const xs = pts.map(p => p[0]);
      const ys = pts.map(p => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    if (node.ty === "gr") {
      const items = Array.isArray(node.it) ? node.it : [];
      const tr = items.find(c => c && c.ty === "tr") || null;
      const childXform = tr ? applyXform(tr, xform) : xform;
      let out = null;
      for (const item of items) {
        if (item === tr) continue;
        out = mergeBBox(out, shapeCanvasBBox(item, childXform, depth + 1));
      }
      return out;
    }
    return null;
  }

  function itemsCanvasBBox(items, xform) {
    let out = null;
    for (const item of items || []) {
      if (!item || item.ty === "tr") continue;
      out = mergeBBox(out, shapeCanvasBBox(item, xform));
    }
    return out;
  }

  function findLegacyWordmarkTargets(json) {
    const assets = {};
    for (const asset of json.assets || []) {
      if (asset && asset.id) assets[asset.id] = asset;
    }
    const targets = [];
    const seen = new Set();
    const structuralCandidates = [];

    function add(parentList, index, group) {
      if (!Array.isArray(parentList) || !group
          || (group.ty !== "gr" && group.ty !== 4) || seen.has(group)) return;
      const bbox = shapeBBox(group);
      if (!bbox) return;
      seen.add(group);
      targets.push({ parentList, index, group, bbox });
    }

    function rememberCandidate(parentList, index, node, xform) {
      const items = node && node.ty === 4 ? node.shapes : node && node.it;
      if (!Array.isArray(items)) return;
      const directPaths = items.filter(child => child && child.ty === "sh").length;
      const hasFill = items.some(child => child && (child.ty === "fl" || child.ty === "gf"));
      if (directPaths !== 6 || !hasFill) return;
      const box = node.ty === 4 ? itemsCanvasBBox(items, xform) : shapeCanvasBBox(node, xform);
      if (!box) return;
      const width = Math.abs(box[2] - box[0]);
      const height = Math.abs(box[3] - box[1]);
      if (width < 1 || height < 1) return;
      structuralCandidates.push({
        parentList, index, group: node, bbox: shapeBBox(node),
        aspect: width / Math.max(height, 1e-6),
      });
    }

    function walkGroups(items, xform, depth) {
      if (!Array.isArray(items) || depth > 24) return;
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (!item || item.ty !== "gr" || item.hd) continue;
        const inner = Array.isArray(item.it) ? item.it : [];
        const directPaths = inner.filter(child => child && child.ty === "sh").length;
        if (directPaths === 6) {
          rememberCandidate(items, index, item, xform);
          const box = shapeCanvasBBox(item, xform);
          if (box) {
            const width = Math.abs(box[2] - box[0]);
            const height = Math.abs(box[3] - box[1]);
            const aspect = width / Math.max(height, 1e-6);
            if (width >= 20 && width <= 360 && height >= 5 && height <= 110
                && aspect >= 4.2 && aspect <= 5.2) {
              add(items, index, item);
              continue;
            }
          }
        }
        const tr = inner.find(child => child && child.ty === "tr") || null;
        const childXform = tr ? applyXform(tr, xform) : xform;
        walkGroups(inner, childXform, depth + 1);
      }
    }

    function walkComposition(layers, outerXform, depth) {
      if (!Array.isArray(layers) || depth > 24) return;
      const byInd = {};
      for (const layer of layers) if (layer && layer.ind != null) byInd[layer.ind] = layer;
      const cache = {};
      const resolving = new Set();
      function resolve(layer) {
        const ind = layer && layer.ind;
        if (cache[ind]) return cache[ind];
        if (resolving.has(ind)) return outerXform;
        resolving.add(ind);
        const parentLayer = byInd[layer && layer.parent];
        const parentXform = parentLayer ? resolve(parentLayer) : outerXform;
        const value = applyXform(layer && layer.ks, parentXform);
        resolving.delete(ind);
        cache[ind] = value;
        return value;
      }
      for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
        const layer = layers[layerIndex];
        if (!layer || layer.hd) continue;
        const layerXform = resolve(layer);
        if (layer.ty === 4) {
          rememberCandidate(layers, layerIndex, layer, layerXform);
          walkGroups(layer.shapes || [], layerXform, depth + 1);
        }
        else if (layer.ty === 0 && assets[layer.refId]) {
          walkComposition(assets[layer.refId].layers || [], layerXform, depth + 1);
        }
      }
    }
    walkComposition(json.layers || [], [1, 1, 0, 0], 0);

    const metadataTargets = (((json.metadata || {}).emoji_v7 || {}).text_targets || []);
    for (const target of metadataTargets) {
      if (!target || typeof target !== "object") continue;
      const compId = String(target.comp_id || "__root__");
      const layers = compId === "__root__"
        ? (json.layers || [])
        : ((assets[compId] && assets[compId].layers) || []);
      const layerIndex = Number(target.layer_index);
      if (!Number.isInteger(layerIndex) || layerIndex < 0 || layerIndex >= layers.length) continue;
      const layer = layers[layerIndex];
      let parentList = layer && layer.shapes;
      let node = null;
      let nodeIndex = -1;
      const path = Array.isArray(target.path) ? target.path : [];
      for (let depth = 0; depth < path.length; depth++) {
        const index = Number(path[depth]);
        if (!Array.isArray(parentList) || !Number.isInteger(index)
            || index < 0 || index >= parentList.length) {
          node = null;
          break;
        }
        node = parentList[index];
        nodeIndex = index;
        if (depth < path.length - 1) parentList = (node && (node.it || node.shapes)) || null;
      }
      if (node && node.ty === "gr") add(parentList, nodeIndex, node);
    }
    if (!targets.length && structuralCandidates.length) {
      structuralCandidates.sort((a, b) =>
        Math.abs(Math.log(Math.max(1e-6, a.aspect) / 4.7))
        - Math.abs(Math.log(Math.max(1e-6, b.aspect) / 4.7)));
      const best = structuralCandidates[0];
      if (best && best.bbox) {
        seen.add(best.group);
        targets.push({
          parentList: best.parentList,
          index: best.index,
          group: best.group,
          bbox: best.bbox,
        });
      }
    }
    return targets;
  }

  function replaceLegacyWordmarkText(json, override, font, contentColor) {
    const text = String((override && override.text) || "").trim();
    if (!text || !font) return 0;
    const targets = findLegacyWordmarkTargets(json);
    let replaced = 0;
    for (const target of targets) {
      const { parentList, index, group, bbox } = target;
      if (!Array.isArray(parentList) || parentList[index] !== group) continue;
      let shapeGroups = null;
      let shapes = [];
      const gradient = normalizeTextGradient(override.text_gradient);
      if (gradient) {
        shapeGroups = renderTextToShapeGroups(font, text, bbox);
        shapes = shapeGroups.flat();
      } else {
        shapes = renderTextToShapes(font, text, bbox);
      }
      if (!shapes.length) continue;
      const t = {
        scale: +override.scale || 1,
        offset_x: +override.offset_x || 0,
        offset_y: +override.offset_y || 0,
        rotation: +override.rotation || 0,
      };
      if (hasTransform(t)) {
        const lengths = shapeGroups ? shapeGroups.map(items => items.length) : null;
        shapes = transformShapes(shapes, t, bbox);
        if (shapeGroups && lengths) shapeGroups = regroupShapes(shapes, lengths);
      }
      const itemsKey = group.ty === 4 ? "shapes" : "it";
      const originalItems = Array.isArray(group[itemsKey]) ? group[itemsKey] : [];
      const fills = originalItems.filter(item => item && item.ty === "fl")
        .map(item => contentColor ? { ...item, c: contentColor } : { ...item });
      if (!fills.length) {
        fills.push({
          ty: "fl", c: contentColor || hexToLottieColor("#ffffff"),
          o: { a: 0, k: 100 }, r: 1, bm: 0, nm: "Fill",
        });
      }
      const transforms = originalItems.filter(item => item && item.ty === "tr")
        .map(item => JSON.parse(JSON.stringify(item)));
      const gradientGroups = gradientShapeGroups(shapeGroups, fills, override.text_gradient);
      parentList[index] = {
        ...group,
        nm: "swex_replaced_wordmark_text",
        [itemsKey]: [
          ...(gradientGroups || shapes),
          ...(gradientGroups ? [] : fills),
          ...(transforms.length ? transforms : [identityTrItem()]),
        ],
      };
      replaced++;
    }
    return replaced;
  }

  function replaceLegacyWordmarkLogo(json, override, logoData, contentColor) {
    if (!logoData || !Array.isArray(logoData.shapes) || !logoData.shapes.length) return 0;
    const targets = findLegacyWordmarkTargets(json);
    let replaced = 0;
    for (const target of targets) {
      const { parentList, index, group, bbox } = target;
      if (!Array.isArray(parentList) || parentList[index] !== group || !bbox) continue;
      const cx = (bbox[0] + bbox[2]) / 2;
      const cy = (bbox[1] + bbox[3]) / 2;
      const letterExpand = +override.letter_expand || 1.0;
      let shapes = placeLogoInBox(
        logoData.shapes,
        logoData.bbox,
        [cx, cy],
        Math.max(1e-3, bbox[2] - bbox[0]) * letterExpand,
        Math.max(1e-3, bbox[3] - bbox[1]) * letterExpand,
        1.0,
      );
      const transform = {
        scale: +override.scale || 1,
        offset_x: +override.offset_x || 0,
        offset_y: +override.offset_y || 0,
        rotation: +override.rotation || 0,
      };
      if (hasTransform(transform)) shapes = transformShapes(shapes, transform, bbox);
      if (!shapes.length) continue;

      const itemsKey = group.ty === 4 ? "shapes" : "it";
      const originalItems = Array.isArray(group[itemsKey]) ? group[itemsKey] : [];
      const styles = originalItems
        .filter(item => item && (item.ty === "fl" || item.ty === "st"))
        .map(item => contentColor ? { ...deepClone(item), c: contentColor } : deepClone(item));
      if (!styles.some(item => item.ty === "fl")) {
        styles.unshift({
          ty: "fl",
          c: contentColor || hexToLottieColor("#ffffff"),
          o: { a: 0, k: 100 },
          r: 1,
          bm: 0,
          nm: "Fill",
        });
      }
      const transforms = originalItems
        .filter(item => item && item.ty === "tr")
        .map(item => deepClone(item));
      parentList[index] = {
        ...group,
        nm: "swex_replaced_wordmark_logo",
        [itemsKey]: [
          ...shapes,
          ...styles,
          ...(transforms.length ? transforms : [identityTrItem()]),
        ],
      };
      replaced++;
    }
    return replaced;
  }

  function attachmentTargets(json) {
    const assets = {};
    for (const asset of json.assets || []) {
      if (asset && asset.id) assets[asset.id] = asset;
    }
    const targets = [];

    function walkShapeGroups(items, xform, depth) {
      if (!Array.isArray(items) || depth > 24) return;
      for (const item of items) {
        if (!item || item.ty !== "gr") continue;
        if (item.hd) continue;
        const inner = Array.isArray(item.it) ? item.it : [];
        const tr = inner.find(c => c && c.ty === "tr") || null;
        const childXform = tr ? applyXform(tr, xform) : xform;
        const bbox = itemsCanvasBBox(inner, childXform);
        if (bbox) targets.push({ parentList: inner, xform: childXform, bbox, depth, kind: "group" });
        walkShapeGroups(inner, childXform, depth + 1);
      }
    }

    function walkComposition(layers, outerXform, depth = 0) {
      if (!Array.isArray(layers) || depth > 24) return;
      const byInd = {};
      for (const layer of layers) {
        if (layer && layer.ind != null) byInd[layer.ind] = layer;
      }
      const cache = {};
      const resolving = new Set();
      function resolve(layer) {
        const ind = layer && layer.ind;
        if (cache[ind]) return cache[ind];
        if (resolving.has(ind)) return outerXform;
        resolving.add(ind);
        const parentLayer = byInd[layer && layer.parent];
        const parentXform = parentLayer ? resolve(parentLayer) : outerXform;
        const next = applyXform(layer && layer.ks, parentXform);
        resolving.delete(ind);
        cache[ind] = next;
        return next;
      }
      for (const layer of layers) {
        if (!layer) continue;
        if (layer.hd) continue;
        const layerXform = resolve(layer);
        if (layer.ty === 4) {
          const shapes = layer.shapes || [];
          const bbox = itemsCanvasBBox(shapes, layerXform);
          if (bbox) targets.push({ parentList: shapes, xform: layerXform, bbox, depth, kind: "layer" });
          walkShapeGroups(shapes, layerXform, depth + 1);
        } else if (layer.ty === 0) {
          const asset = assets[layer.refId];
          if (asset) walkComposition(asset.layers || [], layerXform, depth + 1);
        }
      }
    }

    walkComposition(json.layers || [], [1, 1, 0, 0]);
    return targets;
  }

  function chooseAttachmentTarget(json, anchorX, anchorY, replacePart) {
    const targets = attachmentTargets(json);
    if (!targets.length) return null;
    function score(target) {
      const [xmin, ymin, xmax, ymax] = target.bbox;
      const pad = 18;
      const inside = xmin - pad <= anchorX && anchorX <= xmax + pad && ymin - pad <= anchorY && anchorY <= ymax + pad;
      const dx = xmin <= anchorX && anchorX <= xmax ? 0 : Math.min(Math.abs(anchorX - xmin), Math.abs(anchorX - xmax));
      const dy = ymin <= anchorY && anchorY <= ymax ? 0 : Math.min(Math.abs(anchorY - ymin), Math.abs(anchorY - ymax));
      const dist = Math.hypot(dx, dy);
      const width = Math.abs(xmax - xmin);
      const height = Math.abs(ymax - ymin);
      const area = Math.max(1, Math.abs((xmax - xmin) * (ymax - ymin)));
      const tiny = width < 42 || height < 26 || area < 1400;
      const kindRank = (replacePart ? target.kind === "group" : target.kind === "layer") ? 0 : 1;
      return [inside ? 0 : 1, tiny ? 1 : 0, kindRank, dist, area, -(target.depth || 0)];
    }
    return targets.reduce((best, target) => {
      const a = score(best);
      const b = score(target);
      for (let i = 0; i < a.length; i++) {
        if (b[i] < a[i]) return target;
        if (b[i] > a[i]) return best;
      }
      return best;
    }, targets[0]);
  }

  function insertIndexBeforeTransform(parentList) {
    const idx = (parentList || []).findIndex(item => item && item.ty === "tr");
    return idx >= 0 ? idx : parentList.length;
  }

  function localAnchorBbox(json, target, anchorX, anchorY, widthRatio, heightRatio, maxWidth, maxHeight) {
    const w = Number(json.w) || 512;
    const h = Number(json.h) || 512;
    const [sxRaw, syRaw, ox, oy] = target.xform;
    const sx = Math.abs(sxRaw) > 1e-4 ? sxRaw : (sxRaw >= 0 ? 1 : -1);
    const sy = Math.abs(syRaw) > 1e-4 ? syRaw : (syRaw >= 0 ? 1 : -1);
    const cx = (anchorX - ox) / sx;
    const cy = (anchorY - oy) / sy;
    const bw = Math.min(Math.max(Math.min(w * widthRatio, maxWidth) / Math.max(0.05, Math.abs(sx)), 24), 1200);
    const bh = Math.min(Math.max(Math.min(h * heightRatio, maxHeight) / Math.max(0.05, Math.abs(sy)), 12), 480);
    return { bbox: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], sx, sy };
  }

  function localTargetBbox(target) {
    const [xmin, ymin, xmax, ymax] = target.bbox;
    const [sxRaw, syRaw, ox, oy] = target.xform;
    const sx = Math.abs(sxRaw) > 1e-4 ? sxRaw : (sxRaw >= 0 ? 1 : -1);
    const sy = Math.abs(syRaw) > 1e-4 ? syRaw : (syRaw >= 0 ? 1 : -1);
    const xs = [(xmin - ox) / sx, (xmax - ox) / sx];
    const ys = [(ymin - oy) / sy, (ymax - oy) / sy];
    const lx0 = Math.min(...xs), lx1 = Math.max(...xs);
    const ly0 = Math.min(...ys), ly1 = Math.max(...ys);
    const cx = (lx0 + lx1) / 2;
    const cy = (ly0 + ly1) / 2;
    const bw = Math.min(Math.max(lx1 - lx0, 24), 1200);
    const bh = Math.min(Math.max(ly1 - ly0, 12), 480);
    return { bbox: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], sx, sy };
  }

  function localizedTransform(t, sx, sy) {
    return {
      scale: +t.scale || 1,
      offset_x: (+t.offset_x || 0) / sx,
      offset_y: (+t.offset_y || 0) / sy,
      rotation: +t.rotation || 0,
    };
  }

  function insertAttachedGroup(parentList, name, items, replacePart) {
    if (!Array.isArray(parentList) || !items || !items.length) return false;
    if (replacePart) {
      for (let i = parentList.length - 1; i >= 0; i--) {
        if (!(parentList[i] && parentList[i].ty === "tr")) parentList.splice(i, 1);
      }
    }
    parentList.splice(insertIndexBeforeTransform(parentList), 0, {
      ty: "gr",
      nm: name,
      it: [...items, identityTrItem()],
    });
    return true;
  }

  function insertAttachedTextLayer(json, override, font, contentColor) {
    const rawAx = override && override.anchor_x;
    const rawAy = override && override.anchor_y;
    if (rawAx == null || rawAy == null || rawAx === "" || rawAy === "") return false;
    const ax = Number(rawAx);
    const ay = Number(rawAy);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return false;
    const text = String((override && override.text) || "").trim();
    if (!text || !font) return false;
    const replacePart = !!override.replace_part;
    const target = chooseAttachmentTarget(json, ax, ay, replacePart);
    if (!target) return false;
    const local = replacePart
      ? localTargetBbox(target)
      : localAnchorBbox(json, target, ax, ay, 0.72, 0.18, 370, 96);
    let shapeGroups = null;
    let shapes = [];
    const gradient = normalizeTextGradient(override.text_gradient);
    if (gradient) {
      shapeGroups = renderTextToShapeGroups(font, text, local.bbox);
      shapes = shapeGroups.flat();
    } else {
      shapes = renderTextToShapes(font, text, local.bbox);
    }
    if (!shapes.length) return false;
    const t = localizedTransform(override, local.sx, local.sy);
    if (hasTransform(t)) {
      const lengths = shapeGroups ? shapeGroups.map(group => group.length) : null;
      shapes = transformShapes(shapes, t, local.bbox);
      if (shapeGroups && lengths) shapeGroups = regroupShapes(shapes, lengths);
    }
    const fill = {
      ty: "fl",
      c: contentColor || hexToLottieColor("#ffffff"),
      o: { a: 0, k: 100 },
      r: 1,
      bm: 0,
      nm: "Fill",
    };
    const gradientGroups = gradientShapeGroups(shapeGroups, [fill], override.text_gradient);
    const items = gradientGroups || [...shapes, fill];
    return insertAttachedGroup(target.parentList, replacePart ? "swex_replaced_text" : "swex_attached_text", items, replacePart);
  }

  function insertAttachedLogoLayer(json, logoData, override, contentColor) {
    const rawAx = override && override.anchor_x;
    const rawAy = override && override.anchor_y;
    if (rawAx == null || rawAy == null || rawAx === "" || rawAy === "") return false;
    const ax = Number(rawAx);
    const ay = Number(rawAy);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return false;
    if (!logoData || !logoData.shapes || !logoData.shapes.length) return false;
    const replacePart = !!override.replace_part;
    const target = chooseAttachmentTarget(json, ax, ay, replacePart);
    if (!target) return false;
    const local = replacePart
      ? localTargetBbox(target)
      : localAnchorBbox(json, target, ax, ay, 0.36, 0.36, 190, 190);
    const cx = (local.bbox[0] + local.bbox[2]) / 2;
    const cy = (local.bbox[1] + local.bbox[3]) / 2;
    let shapes = placeLogoInBox(
      logoData.shapes,
      logoData.bbox,
      [cx, cy],
      Math.max(1, local.bbox[2] - local.bbox[0]),
      Math.max(1, local.bbox[3] - local.bbox[1]),
      0.92,
    );
    const t = localizedTransform(override, local.sx, local.sy);
    if (hasTransform(t)) shapes = transformShapes(shapes, t, local.bbox);
    const fill = {
      ty: "fl",
      c: contentColor || hexToLottieColor("#ffffff"),
      o: { a: 0, k: 100 },
      r: 1,
      bm: 0,
      nm: "Fill",
    };
    return insertAttachedGroup(target.parentList, replacePart ? "swex_replaced_logo" : "swex_attached_logo", [...shapes, fill], replacePart);
  }

  function canvasTextBbox(json, override) {
    const w = Number(json.w) || 512;
    const h = Number(json.h) || 512;
    const bw = Math.min(w * 0.72, 370);
    const bh = Math.min(h * 0.18, 96);
    const rawAx = override && override.anchor_x;
    const rawAy = override && override.anchor_y;
    const ax = rawAx != null && rawAx !== "" ? Number(rawAx) : NaN;
    const ay = rawAy != null && rawAy !== "" ? Number(rawAy) : NaN;
    const cx = Number.isFinite(ax) ? Math.max(0, Math.min(w, ax)) : w / 2;
    const cy = Number.isFinite(ay) ? Math.max(0, Math.min(h, ay)) : h / 2;
    return [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2];
  }

  function insertFallbackTextLayer(json, override, font, contentColor) {
    const text = String((override && override.text) || "").trim();
    if (!text || !font) return false;
    const hasAnchor = override && override.anchor_x != null && override.anchor_y != null
      && override.anchor_x !== "" && override.anchor_y !== ""
      && Number.isFinite(+override.anchor_x) && Number.isFinite(+override.anchor_y);
    const attachedOverride = hasAnchor ? override : {
      ...override,
      anchor_x: (Number(json.w) || 512) / 2,
      anchor_y: (Number(json.h) || 512) / 2,
    };
    if (insertAttachedTextLayer(json, attachedOverride, font, contentColor)) return true;
    const bbox = canvasTextBbox(json, override);
    let shapeGroups = null;
    let shapes = [];
    const gradient = normalizeTextGradient(override.text_gradient);
    if (gradient) {
      shapeGroups = renderTextToShapeGroups(font, text, bbox);
      shapes = shapeGroups.flat();
    } else {
      shapes = renderTextToShapes(font, text, bbox);
    }
    if (!shapes.length) return false;
    const t = {
      scale: +override.scale || 1,
      offset_x: +override.offset_x || 0,
      offset_y: +override.offset_y || 0,
      rotation: +override.rotation || 0,
    };
    if (hasTransform(t)) {
      const lengths = shapeGroups ? shapeGroups.map(group => group.length) : null;
      shapes = transformShapes(shapes, t, bbox);
      if (shapeGroups && lengths) shapeGroups = regroupShapes(shapes, lengths);
    }
    const fill = {
      ty: "fl",
      c: contentColor || hexToLottieColor("#ffffff"),
      o: { a: 0, k: 100 },
      r: 1,
      bm: 0,
      nm: "Fill",
    };
    const items = [];
    const gradientGroups = gradientShapeGroups(shapeGroups, [fill], override.text_gradient);
    if (gradientGroups) items.push(...gradientGroups);
    else items.push(...shapes, fill);
    items.push(identityTrItem());
    if (!Array.isArray(json.layers)) json.layers = [];
    json.layers.unshift(customOverlayLayer(json, items, "swex_custom_text"));
    return true;
  }

  function insertFallbackLogoLayer(json, logoData, override, contentColor) {
    if (!logoData || !logoData.shapes || !logoData.shapes.length) return false;
    if (insertAttachedLogoLayer(json, logoData, override, contentColor)) return true;
    const w = Number(json.w) || 512;
    const h = Number(json.h) || 512;
    const scale = Math.max(0.5, Math.min(5, +override.scale || 1));
    const target = Math.min(w, h) * 0.36 * scale;
    const rawAx = override && override.anchor_x;
    const rawAy = override && override.anchor_y;
    const ax = rawAx != null && rawAx !== "" ? Number(rawAx) : NaN;
    const ay = rawAy != null && rawAy !== "" ? Number(rawAy) : NaN;
    const cx = (Number.isFinite(ax) ? Math.max(0, Math.min(w, ax)) : w / 2) + (+override.offset_x || 0);
    const cy = (Number.isFinite(ay) ? Math.max(0, Math.min(h, ay)) : h / 2) + (+override.offset_y || 0);
    const bbox = [cx - target / 2, cy - target / 2, cx + target / 2, cy + target / 2];
    let shapes = placeLogoInBox(logoData.shapes, logoData.bbox, [cx, cy], target, target, 0.92);
    const rot = +override.rotation || 0;
    if (rot) shapes = transformShapes(shapes, { scale: 1, offset_x: 0, offset_y: 0, rotation: rot }, bbox);
    const fill = {
      ty: "fl",
      c: contentColor || hexToLottieColor("#ffffff"),
      o: { a: 0, k: 100 },
      r: 1,
      bm: 0,
      nm: "Fill",
    };
    const items = [...shapes, fill, identityTrItem()];
    if (!Array.isArray(json.layers)) json.layers = [];
    json.layers.unshift(customOverlayLayer(json, items, "swex_custom_logo"));
    return true;
  }

  function applyOverride(lottieJson, override, font) {
    /** Мутирует JSON: удаляет swex-буквы, вставляет текст или лого с per-emoji
     *  трансформом. Если override пустой/нет нужных данных — оставляет как есть.  */
    if (!override) return lottieJson;
    // Apply per-line text edits first (passport-style tiles); their groups
    // are independent of the swex letter containers so it's safe either way.
    if (Array.isArray(override.lines) && override.lines.length) {
      const c = hexToLottieColor(override.content_color || "#000000");
      // passport secondary lines are painted black on the ID card, so default
      // to a black-ish fill unless the user explicitly recolours via the
      // global content_color slider (then we honour it).
      const useBlack = !override.content_color || override.content_color.toLowerCase() === "#ffffff";
      applyLinesOverride(lottieJson, override.lines, font,
                         useBlack ? { a: 0, k: [0, 0, 0, 1] } : c);
    }
    // Always re-render and re-centre the passport '?' (it ships off-centre
    // out of the SeymourOne font glyph). If the user uploaded an SVG photo,
    // fit it into the placeholder instead of the glyph.
    applyQmarkCleanup(
      lottieJson, font,
      override.photo_svg_b64 || null,
      override.photo_scale,
      override.photo_color || "#ffffff",
    );
    let containers = findSwexContainers(lottieJson);
    const headerLine = passportHeaderLine(override);
    if (headerLine) {
      const headerContainer = choosePassportHeaderContainer(containers);
      for (const c of containers) {
        if (!sameContainer(c, headerContainer)) removeContainerLetters(c);
      }
      containers = findSwexContainers(lottieJson);
      const freshHeader = choosePassportHeaderContainer(containers);
      containers = freshHeader ? [freshHeader] : [];
    }
    const hasReplaceAnchor = override.anchor_x != null && override.anchor_y != null
      && override.anchor_x !== "" && override.anchor_y !== ""
      && Number.isFinite(+override.anchor_x) && Number.isFinite(+override.anchor_y);
    if (override.replace_part && hasReplaceAnchor) {
      containers = [];
    }

    let logoData = null;
    if (override.kind === "logo" && override.logo_svg_b64) {
      try {
        const svgText = decodeURIComponent(escape(atob(override.logo_svg_b64)));
        logoData = svgToLottieShapes(svgText);
        if (!logoData.shapes.length) logoData = null;
      } catch (e) { logoData = null; }
    }
    // A PNG logo can't be inserted as vector shapes in the live preview
    // (only the real pack build composites the raster onto rendered
    // video frames) — but the preview must still blank the original swex
    // letters instead of leaving them raw or recolouring them, so
    // uploading a PNG doesn't look like it silently reverted to the
    // un-replaced placeholder.
    const hasPngOnly = override.kind === "logo" && !!override.logo_png_b64 && !logoData;

    const useLogo = !!logoData;
    const useText = !useLogo && !hasPngOnly && override.text && override.text.trim() !== "";
    const useEmpty = !useLogo && !useText; // нет текста/лого — работаем с оригинальными swex-буквами

    const t = {
      scale:    +override.scale || 1,
      offset_x: +override.offset_x || 0,
      offset_y: +override.offset_y || 0,
      rotation: +override.rotation || 0,
      anchor_x: override.anchor_x != null && override.anchor_x !== "" && Number.isFinite(+override.anchor_x)
        ? +override.anchor_x : null,
      anchor_y: override.anchor_y != null && override.anchor_y !== "" && Number.isFinite(+override.anchor_y)
        ? +override.anchor_y : null,
      replace_part: !!override.replace_part,
    };
    const hasExplicitColor = !!(override.content_color && normHex(override.content_color));
    const contentColor = hasExplicitColor ? hexToLottieColor(override.content_color) : null;
    const isNonDefaultColor = hasExplicitColor;

    // New-catalog templates may contain unrelated artwork groups named
    // s/w/e/x. For SVG logos, prefer the real six-path baked wordmark slot,
    // just like the server renderer does, instead of mutating that artwork.
    if (useLogo && override.allow_fallback === false && !override.replace_part
        && replaceLegacyWordmarkLogo(lottieJson, override, logoData, contentColor)) {
      return lottieJson;
    }

    if (!containers.length) {
      if (useText && !override.replace_part
          && replaceLegacyWordmarkText(lottieJson, override, font, contentColor)) {
        return lottieJson;
      }
      if (override.allow_fallback === false) return lottieJson;
      if (useLogo) insertFallbackLogoLayer(lottieJson, logoData, t, contentColor);
      else if (useText) insertFallbackTextLayer(lottieJson, override, font, contentColor);
      return lottieJson;
    }

    function nearbyStyleItems(parentList, idxs) {
      const out = [];
      if (Array.isArray(parentList) && Array.isArray(idxs) && idxs.length) {
        for (const i of idxs) {
          const item = parentList[i];
          if (!item || !Array.isArray(item.it)) continue;
          const local = item.it.filter(x => x && (x.ty === "fl" || x.ty === "st"));
          if (local.length) {
            out.push(...local);
            break;
          }
        }
        const maxIdx = Math.max(...idxs);
        if (!out.length) {
          for (let j = maxIdx + 1; j < parentList.length; j++) {
            const item = parentList[j];
            if (!item) continue;
            if (item.ty === "fl" || item.ty === "st") { out.push(item); continue; }
            if (out.length || item.ty === "tr") break;
          }
        }
        if (!out.length) {
          const minIdx = Math.min(...idxs);
          for (let j = minIdx - 1; j >= 0; j--) {
            const item = parentList[j];
            if (!item) continue;
            if (item.ty === "fl" || item.ty === "st") { out.unshift(item); continue; }
            if (out.length || item.ty === "tr") break;
          }
        }
      }
      return out.length ? out : (Array.isArray(parentList) ? parentList : []);
    }

    for (const c of containers) {
      const { parentList, idxs, bbox } = c;

      // Режим "пустой" — удаляем оригинальные swex-буквы или перекрашиваем их
      if (useEmpty) {
        if (isNonDefaultColor && !hasPngOnly) {
          // Перекрашиваем существующие fill/stroke внутри контейнера (применяем цвет к swex-буквам)
          for (const i of idxs) {
            const el = parentList[i];
            if (!el) continue;
            applyColorToNode(el, contentColor);
          }
          // Также перекрашиваем fill/stroke в parentList
          for (const item of parentList) {
            if (!item) continue;
          if (contentColor && item.ty === "fl") item.c = contentColor;
          if (contentColor && item.ty === "st") item.c = contentColor;
          }
        } else {
          // Дефолтный цвет и нет текста — удаляем swex-буквы (убирает VELORA)
          const sortedDesc = [...idxs].sort((a, b) => b - a);
          for (const i of sortedDesc) parentList.splice(i, 1);
        }
        continue;
      }

      let shapes;
      let shapeGroups = null;
      if (useLogo) {
        const cxLocal = (bbox[0] + bbox[2]) / 2;
        const cyLocal = (bbox[1] + bbox[3]) / 2;
        const letterExpand = +override.letter_expand || 1.0;
        const letterW = Math.max(1e-3, bbox[2] - bbox[0]) * letterExpand;
        const letterH = Math.max(1e-3, bbox[3] - bbox[1]) * letterExpand;
        shapes = placeLogoInBox(logoData.shapes, logoData.bbox,
                                [cxLocal, cyLocal], letterW, letterH, 1.0);
      } else {
        if (!font) { console.error("[replacer] font not loaded, skipping text"); continue; }
        if (normalizeTextGradient(override.text_gradient)) {
          shapeGroups = renderTextToShapeGroups(font, override.text, bbox);
          shapes = shapeGroups.flat();
        } else {
          shapes = renderTextToShapes(font, override.text, bbox);
        }
      }
      if (!shapes.length) continue;

      // Применяем трансформацию напрямую к координатам (без wrap-группы)
      if (hasTransform(t)) {
        const lengths = shapeGroups ? shapeGroups.map(group => group.length) : null;
        shapes = transformShapes(shapes, t, bbox);
        if (shapeGroups && lengths) shapeGroups = regroupShapes(shapes, lengths);
      }

      // Удаляем swex-буквы (по убыванию индексов)
      const sortedDesc = [...idxs].sort((a, b) => b - a);
      for (const i of sortedDesc) parentList.splice(i, 1);
      const insertAt = idxs[0];

      // Копируем fill/stroke из родительской группы
      const fillStroke = [];
      let hasFill = false;
      if (parentList && Array.isArray(parentList)) {
        for (const item of nearbyStyleItems(parentList, idxs)) {
          if (!item) continue;
          if (item.ty === "fl") {
            hasFill = true;
            fillStroke.push(contentColor ? { ...item, c: contentColor } : { ...item });
          }
        }
      }
      if (!hasFill) {
        fillStroke.push({
          ty: "fl",
          c: contentColor || hexToLottieColor("#ffffff"),
          o: { a: 0, k: 100 },
          r: 1,
          bm: 0,
          nm: "Fill",
        });
      }
      // Если stroke отсутствует — добавляем с ровными углами
      const gradientGroups = useLogo ? null : gradientShapeGroups(shapeGroups, fillStroke, override.text_gradient);
      let cursor = insertAt;
      if (gradientGroups) {
        for (let k = 0; k < gradientGroups.length; k++) {
          parentList.splice(cursor + k, 0, gradientGroups[k]);
        }
      } else {
        // Вставляем shapes, затем fill/stroke
        for (let k = 0; k < shapes.length; k++) {
          parentList.splice(cursor + k, 0, shapes[k]);
        }
        for (let k = 0; k < fillStroke.length; k++) {
          parentList.splice(cursor + shapes.length + k, 0, fillStroke[k]);
        }
      }
    }
    return lottieJson;
  }

  // ─────────────────── Public API ───────────────────
  let _fonts = [];
  const _fontCache = {};
  const _fontPromises = {};

  function loadOneFont(url) {
    const key = String(url || "");
    if (_fontCache[key]) {
      return Promise.resolve(_fontCache[key]);
    }
    if (_fontPromises[key]) return _fontPromises[key];
    _fontPromises[key] = new Promise((resolve, reject) => {
      opentype.load(key, (err, font) => {
        if (err) { reject(err); return; }
        _fontCache[key] = font;
        resolve(font);
      });
    });
    return _fontPromises[key];
  }

  async function loadFont(url, fallbackUrls) {
    const urls = [String(url || ""), ...(fallbackUrls || []).map(u => String(u || ""))]
      .filter(Boolean);
    const seen = new Set();
    const unique = urls.filter(u => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
    const fonts = [];
    for (const u of unique) {
      try {
        fonts.push(await loadOneFont(u));
      } catch (e) {
        if (u === unique[0]) throw e;
        console.warn("[replacer] fallback font failed:", u, e);
      }
    }
    _fonts = fonts.filter(Boolean);
    return _fonts[0] || null;
  }

  function deepClone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function applyColorRemap(json, remap) {
    // Walk every static fl/st node; if its colour matches a key in
    // `remap`, repaint it with the mapped value or replace the style item
    // with a linear gradient. Animated colour properties (`c.a == 1`) and
    // existing gradient fills are left alone.
    if (!remap || typeof remap !== "object") return json;
    // Build a normalized lookup table once.
    const table = {};
    let hasAny = false;
    for (const k in remap) {
      if (!Object.prototype.hasOwnProperty.call(remap, k)) continue;
      const from = normHex(k);
      if (!from) continue;
      const raw = remap[k];
      if (raw && typeof raw === "object" && (raw.mode === "gradient" || raw.type === "gradient")) {
        const a = normHex(raw.from) || from;
        const b = normHex(raw.to) || a;
        if (a !== from || b !== from) {
          const target = normalizeRemapTarget(raw.target || raw.apply_to || raw.kind);
          table[from] = { mode: "gradient", from: a, to: b, target };
          hasAny = true;
        }
      } else {
        const to = normHex(raw);
        if (to && to !== from) {
          table[from] = { mode: "solid", color: to };
          hasAny = true;
        }
      }
    }
    if (!hasAny) return json;

    function normalizeRemapTarget(value) {
      const v = String(value || "").trim().toLowerCase();
      if (v === "stroke" || v === "st" || v === "outline") return "stroke";
      if (v === "fill" || v === "fl") return "fill";
      return "";
    }
    function remapAppliesToItem(spec, item) {
      if (!spec || !spec.target) return true;
      if (spec.target === "stroke") return item && item.ty === "st";
      if (spec.target === "fill") return item && item.ty === "fl";
      return true;
    }

    function rgbaToHex(rgba) {
      if (!Array.isArray(rgba) || rgba.length < 3) return null;
      const r = Math.max(0, Math.min(255, Math.round((rgba[0] || 0) * 255)));
      const g = Math.max(0, Math.min(255, Math.round((rgba[1] || 0) * 255)));
      const b = Math.max(0, Math.min(255, Math.round((rgba[2] || 0) * 255)));
      return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
    }
    function hexToRgba(hex, alphaFallback) {
      const a = (typeof alphaFallback === "number") ? alphaFallback : 1;
      return [
        parseInt(hex.slice(1, 3), 16) / 255,
        parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255,
        a,
      ];
    }
    function gradientStops(from, to) {
      const a = hexToRgba(from, 1);
      const b = hexToRgba(to, 1);
      return [0, a[0], a[1], a[2], 1, b[0], b[1], b[2]];
    }
    function gradientPoints(parentArray) {
      const bb = shapeBBox({ it: parentArray || [] });
      if (!bb) return { s: [-256, 0], e: [256, 0] };
      const w = Math.max(1, bb[2] - bb[0]);
      const pad = Math.max(8, w * 0.12);
      const cy = (bb[1] + bb[3]) / 2;
      return {
        s: [+(bb[0] - pad).toFixed(2), +cy.toFixed(2)],
        e: [+(bb[2] + pad).toFixed(2), +cy.toFixed(2)],
      };
    }
    function gradientStyleItem(item, spec, parentArray) {
      const pts = gradientPoints(parentArray);
      const out = {
        ty: item.ty === "st" ? "gs" : "gf",
        o: item.o ? deepClone(item.o) : { a: 0, k: 100 },
        g: { p: 2, k: { a: 0, k: gradientStops(spec.from, spec.to) } },
        s: { a: 0, k: pts.s },
        e: { a: 0, k: pts.e },
        t: 1,
        h: { a: 0, k: 0 },
        a: { a: 0, k: 0 },
        r: item.r !== undefined ? deepClone(item.r) : 1,
        bm: item.bm || 0,
        nm: (item.nm || "Layer") + " gradient",
      };
      if (item.ty === "st") {
        if (item.w !== undefined) out.w = deepClone(item.w);
        if (item.lc !== undefined) out.lc = deepClone(item.lc);
        if (item.lj !== undefined) out.lj = deepClone(item.lj);
        if (item.ml !== undefined) out.ml = deepClone(item.ml);
      }
      return out;
    }

    function visit(n, parentArray, index) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length; i++) visit(n[i], n, i);
        return;
      }
      if (n.ty === "fl" || n.ty === "st") {
        const c = n.c;
        if (c && c.a === 0 && Array.isArray(c.k)) {
          const hex = rgbaToHex(c.k);
          if (hex && table[hex]) {
            const spec = table[hex];
            if (!remapAppliesToItem(spec, n)) return;
            if (spec.mode === "gradient" && parentArray && index != null) {
              parentArray[index] = gradientStyleItem(n, spec, parentArray);
              return;
            }
            const alpha = (c.k.length >= 4) ? c.k[3] : 1;
            c.k = hexToRgba(spec.color, alpha);
          }
        }
      }
      for (const k of ["layers", "assets", "shapes", "it"]) {
        if (Array.isArray(n[k])) visit(n[k], null, null);
      }
    }
    visit(json, null, null);
    return json;
  }

  function normHex(v) {
    const s = String(v || "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return "#" + s.slice(1).split("").map(ch => ch + ch).join("").toLowerCase();
    }
    return null;
  }

  function applyToLottie(originalJson, override) {
    const json = deepClone(originalJson);
    // Layer palette edits belong to the sticker artwork itself. Apply them
    // before inserting the user's text/logo so the text colour control stays
    // independent and palette presets cannot hide the nickname.
    if (override && override.color_remap) {
      applyColorRemap(json, override.color_remap);
    }
    const out = applyOverride(json, override, _fonts);
    return out;
  }

  return {
    loadFont,
    applyToLottie,
    findSwexContainers,
    swexCanvasXformAtFrame,
    _internal: { renderTextToShapes, renderTextToShapeGroups, svgToLottieShapes, wrapInTransform },
  };
})();
