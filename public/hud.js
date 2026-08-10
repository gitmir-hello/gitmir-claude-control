/* =============================================================================
 *  HOLO-HUD ENGINE
 *  Голографический рендер графа на чистом Canvas 2D. Без библиотек.
 *
 *  Движок ничего не знает о предметной области. Что рисовать, он спрашивает у
 *  сцены: она объявляет window.SCENE_FACTORY(HUD) и возвращает описание —
 *  узлы, связи и хуки для листовых элементов (их сводка, жизнь и досье).
 *  Так одна и та же машинерия обслуживает и сеть агентов, и схему бизнес-логики.
 *
 *  Конвейер кадра:
 *      сцена (offscreen)
 *        -> bright-pass (возведение яркости в квадрат)
 *        -> пирамида down/upsample = bloom
 *        -> анаморфный горизонтальный streak
 *        -> разделение RGB + радиальная хроматическая аберрация
 *        -> скан-линии, развёртка, зерно, виньетка
 *        -> экран
 *
 *  Секции файла:
 *      1  математика и утилиты
 *      2  палитра
 *      3  подключение сцены
 *      4  текстовый движок
 *      5  геометрия и раскладка
 *      6  камера
 *      7  render targets
 *      8  примитивы формы
 *      9  фон
 *     10  рёбра
 *     11  узлы
 *     12  экранный HUD
 *     13  постобработка
 *     14  ввод
 *     15  главный цикл
 * ========================================================================== */

/**
 * Mounts the HUD renderer onto a canvas inside a panel.
 *
 *   const hud = HUD_MOUNT(canvasEl, scene, { onPick });
 *   hud.destroy();
 *
 * `scene` is either the scene object or a factory taking the engine API. Every
 * mount is independent: its own graph, camera, buffers and listeners, so two
 * views can be on screen at once without sharing state.
 */
window.HUD_MOUNT = function (view, SCENE_INPUT, OPTS) {
'use strict';
OPTS = OPTS || {};
let stopped = false;
const teardown = [];
const on = (target, type, fn, opts) => {
  target.addEventListener(type, fn, opts);
  teardown.push(() => target.removeEventListener(type, fn, opts));
};

/* =============================================================================
 * 1. МАТЕМАТИКА И УТИЛИТЫ
 * ========================================================================== */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const invLerp = (a, b, v) => (b === a ? 0 : clamp((v - a) / (b - a), 0, 1));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Кадронезависимое приближение к цели: rate — «жёсткость» в 1/сек.
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

// Детерминированный ГПСЧ — картинка воспроизводима между запусками.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Гладкий 1D value-noise — для дрожания голограммы и «живых» показаний.
function makeNoise1D(seed) {
  const rnd = mulberry32(seed);
  const N = 512;
  const tab = new Float32Array(N);
  for (let i = 0; i < N; i++) tab[i] = rnd() * 2 - 1;
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = tab[((i % N) + N) % N];
    const b = tab[(((i + 1) % N) + N) % N];
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  };
}

const noiseA = makeNoise1D(1337);
const noiseB = makeNoise1D(9001);
const noiseC = makeNoise1D(4242);

/* =============================================================================
 * 2. ПАЛИТРА
 * ========================================================================== */

const C = {
  cyan:  [ 96, 232, 255],
  ice:   [186, 246, 255],
  blue:  [ 72, 150, 255],
  deep:  [ 32,  92, 168],
  amber: [255, 178,  78],
  gold:  [255, 214, 130],
  red:   [255,  92, 110],
  green: [ 96, 246, 176],
  paper: [214, 248, 255],
};

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t)),
];

// Типы узлов: цвет + вес свечения.
const KIND = {
  core:    { color: C.amber, accent: C.gold,  glow: 1.35 },
  primary: { color: C.cyan,  accent: C.ice,   glow: 1.00 },
  sub:     { color: C.blue,  accent: C.cyan,  glow: 0.82 },
  data:    { color: C.green, accent: C.ice,   glow: 0.88 },
  alert:   { color: C.red,   accent: C.gold,  glow: 1.10 },
};

/* =============================================================================
 * 3. ПОДКЛЮЧЕНИЕ СЦЕНЫ
 *    Сцена объявляет window.SCENE_FACTORY(HUD) и возвращает:
 *      title, subtitle, ticker[]      — надписи HUD
 *      nodes[], edges[]               — граф верхнего уровня
 *      groupRows()                    — строки сводки для узла-контейнера
 *      leaf.init(src, rnd)            — данные листа (null, если лист пустой)
 *      leaf.rows(data)                — строки сводки листа
 *      leaf.step(data, dt)            — покадровая жизнь листа
 *      leaf.stats(data)               — вклад листа в агрегаты контейнеров
 *      leaf.progress(data)            — 0..1 для строки типа 'bar'
 *      resolveRow(node, row)          — живое значение строки
 *      detail: { w, h, draw(...) }    — раскрытая карточка листа
 *      labels                         — показывать подписи связей по умолчанию
 * ========================================================================== */

const HUD_API = {};                  // заполняется ниже, перед вызовом фабрики
let SCENE = null;

/* =============================================================================
 * 4. ТЕКСТОВЫЙ ДВИЖОК
 *    Моноширинный шрифт + ручной трекинг (letter-spacing есть не везде).
 * ========================================================================== */

const FONT_STACK = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

const HAS_LETTER_SPACING = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d');
    return 'letterSpacing' in c;
  } catch (e) { return false; }
})();

const measureCache = new Map();
const measureCtx = document.createElement('canvas').getContext('2d');

function fontString(size, weight) {
  return `${weight} ${size.toFixed(2)}px ${FONT_STACK}`;
}

function applyFont(ctx, size, weight, tracking) {
  ctx.font = fontString(size, weight);
  if (HAS_LETTER_SPACING) ctx.letterSpacing = `${tracking.toFixed(3)}px`;
}

/**
 * Ширина строки с трекингом — ровно та, что получится при отрисовке.
 * Нативный letterSpacing добавляет зазор и после последнего символа,
 * поэтому его вычитаем: иначе выравнивание вправо «плывёт».
 */
function textWidth(str, size, weight, tracking) {
  const key = `${size}|${weight}|${tracking}|${str}`;
  const cached = measureCache.get(key);
  if (cached !== undefined) return cached;

  measureCtx.font = fontString(size, weight);
  let w;
  if (HAS_LETTER_SPACING && tracking !== 0) {
    measureCtx.letterSpacing = `${tracking.toFixed(3)}px`;
    w = measureCtx.measureText(str).width - tracking;
    measureCtx.letterSpacing = '0px';
  } else {
    w = measureCtx.measureText(str).width + tracking * Math.max(0, str.length - 1);
  }
  if (measureCache.size < 8000) measureCache.set(key, w);
  return w;
}

/* --- отложенная отрисовка текста ----------------------------------------- *
 * Свечение в этом рендере даёт bloom, а он берёт яркость прямо из кадра.
 * Текст — самое яркое, что есть на панели, поэтому вокруг букв набухал ореол
 * и они «плыли». Поэтому текст не рисуется сразу: вызовы копятся в очередь,
 * bloom считается по кадру без единой буквы, и только потом текст ложится
 * сверху — идеально резким. В очереди сохраняем матрицу, прозрачность и
 * область отсечения, чтобы воспроизведение было неотличимо от прямого вызова.
 */
const textQueue = [];
let deferText = true;
let textClip = null;          // {x, y, w, h} — прямоугольник панели или null

function flushText(ctx) {
  if (!textQueue.length) return;
  const wasDeferred = deferText;
  deferText = false;
  for (const it of textQueue) {
    ctx.save();
    ctx.setTransform(it.m);
    ctx.globalAlpha = it.alpha;
    if (it.clip) {
      ctx.beginPath();
      ctx.rect(it.clip.x, it.clip.y, it.clip.w, it.clip.h);
      ctx.clip();
    }
    drawText(ctx, it.str, it.x, it.y, it.opt);
    ctx.restore();
  }
  textQueue.length = 0;
  deferText = wasDeferred;
}

/**
 * Рисует текст с трекингом. align: 'left' | 'center' | 'right'.
 * Возвращает ширину строки (доступна сразу, даже когда отрисовка отложена).
 */
function drawText(ctx, str, x, y, opt) {
  const size = opt.size;
  const weight = opt.weight || 400;
  const tracking = opt.tracking || 0;
  const align = opt.align || 'left';
  const w = textWidth(str, size, weight, tracking);

  if (deferText) {
    textQueue.push({
      str, x, y,
      opt: opt.color ? opt : { ...opt, color: ctx.fillStyle },
      m: ctx.getTransform(),
      alpha: ctx.globalAlpha,
      clip: textClip,
    });
    return w;
  }

  let sx = x;
  if (align === 'center') sx = x - w / 2;
  else if (align === 'right') sx = x - w;

  applyFont(ctx, size, weight, tracking);
  ctx.textAlign = 'left';
  ctx.textBaseline = opt.baseline || 'middle';
  if (opt.color) ctx.fillStyle = opt.color;

  if (HAS_LETTER_SPACING || tracking === 0) {
    ctx.fillText(str, sx, y);
  } else {
    // Фолбэк: посимвольно, чтобы трекинг работал везде одинаково.
    measureCtx.font = fontString(size, weight);
    let cx = sx;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      ctx.fillText(ch, cx, y);
      cx += measureCtx.measureText(ch).width + tracking;
    }
  }
  if (HAS_LETTER_SPACING) ctx.letterSpacing = '0px';
  return w;
}

/* =============================================================================
 * 5. ГЕОМЕТРИЯ УЗЛОВ И РАСКЛАДКА
 * ========================================================================== */

const METRIC = {
  padX: 14,
  headerH: 26,
  rowH: 15,
  footerH: 16,
  minW: 168,
  maxW: 260,
  titleSize: 11.5,
  titleTrack: 1.6,
  tagSize: 8,
  tagTrack: 1.0,
  rowSize: 8.8,
  rowTrack: 0.7,
  colGap: 108,
  rowGap: 42,
};

// Отступы вложенного уровня внутри раскрытого узла.
const NEST = {
  padX: 26,
  padTop: 34,      // под заголовком контейнера
  padBottom: 42,   // с запасом: обходные дуги ныряют ниже панелей
  colGap: 74,      // внутри контейнера панели стоят плотнее, чем на верхнем уровне
  rowGap: 32,
};

const root = { nodes: [], edges: [], cols: null, w: 0, h: 0, parent: null };
const nodes = root.nodes;      // корневой уровень — им пользуется большая часть кода
const edges = root.edges;
const allNodes = [];           // плоский список всех узлов всех уровней
const allEdges = [];

function buildLevel(nodeSpecs, edgeSpecs, rnd, parent) {
  const level = {
    nodes: [], edges: [], cols: null, w: 0, h: 0, parent,
    gapX: parent ? NEST.colGap : METRIC.colGap,
    gapY: parent ? NEST.rowGap : METRIC.rowGap,
  };
  const byId = new Map();

  for (const src of nodeSpecs) {
    const kind = KIND[src.kind] || KIND.primary;
    // Лист сети — агент: строки панели выводим из его состояния.
    // Контейнер — группа: его строки заполняются агрегатом по детям ниже.
    const leafData = SCENE.leaf.init(src, rnd);
    const rows = src.rows || (leafData ? SCENE.leaf.rows(leafData) : SCENE.groupRows());

    // Ширина — по самому длинному содержимому, с ограничением.
    let w = METRIC.minW;
    w = Math.max(w, textWidth(src.title, METRIC.titleSize, 600, METRIC.titleTrack)
                  + textWidth(src.tag, METRIC.tagSize, 400, METRIC.tagTrack)
                  + METRIC.padX * 2 + 26);
    for (const r of rows) {
      const lw = textWidth(r[0], METRIC.rowSize, 400, METRIC.rowTrack);
      const rw = textWidth(r[1] || '', METRIC.rowSize, 600, METRIC.rowTrack);
      w = Math.max(w, lw + rw + METRIC.padX * 2 + 34);
    }
    w = Math.min(METRIC.maxW, Math.round(w));

    const h = METRIC.headerH + rows.length * METRIC.rowH + METRIC.footerH;

    const n = {
      // Keep the scene node itself: it carries the model id, and a click has to
      // be answerable with "which object of the product is this".
      src,
      id: src.id,
      kind: src.kind,
      title: src.title,
      tag: src.tag,
      rows,
      color: kind.color,
      accent: kind.accent,
      glowK: kind.glow,
      // baseW/baseH — свёрнутый размер; w/h — текущий, растёт при раскрытии.
      baseW: w, baseH: h,
      openW: w, openH: h,
      w, h,
      lx: 0, ly: 0,        // локальные координаты внутри своего уровня
      ltx: 0, lty: 0,      // цели, к которым локальные координаты едут
      x: 0, y: 0,          // абсолютные мировые (пересчитываются каждый кадр)
      depth: 0,
      col: 0,
      level: null,         // уровень, которому принадлежит узел
      sub: null,           // вложенный уровень
      expanded: false,
      expandT: 0,          // 0..1 — прогресс раскрытия
      boot: 0,             // 0..1 — прогресс голографической сборки
      bootDelay: 0,
      hover: 0,            // 0..1 — плавная подсветка
      select: 0,
      dim: 1,              // затемнение вне фокуса
      seed: rnd() * 1000,
      load: rnd(),
      inEdges: [],
      outEdges: [],
      // Частицы сборки — сходятся к периметру при появлении узла.
      motes: Array.from({ length: 14 }, () => {
        const a = rnd() * TAU;
        const d = 180 + rnd() * 320;
        return { ax: Math.cos(a) * d, ay: Math.sin(a) * d, t: rnd() * 0.35, s: 0.6 + rnd() * 0.8 };
      }),
    };
    n.level = level;
    n.leaf = leafData;
    level.nodes.push(n);
    allNodes.push(n);
    byId.set(n.id, n);

    // Вложенный уровень строим и раскладываем сразу: его габариты задают
    // размер контейнера, а он нужен раскладке текущего уровня.
    if (src.children && src.children.nodes && src.children.nodes.length) {
      n.sub = buildLevel(src.children.nodes, src.children.edges || [], rnd, n);
      layoutLevel(n.sub, 1.5);
      n.openW = Math.max(n.baseW, n.sub.w + NEST.padX * 2);
      n.openH = n.sub.h + NEST.padTop + NEST.padBottom;
    }
  }

  for (const [from, to, label] of (edgeSpecs || [])) {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) continue;
    const e = {
      a, b,
      label: label || '',
      pts: [],            // полилиния-аппроксимация кривой
      cum: [],            // накопленная длина по точкам
      len: 0,
      dirty: true,
      boot: 0,
      hover: 0,
      dim: 1,
      // Пакеты данных, бегущие по связи.
      packets: Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => ({
        t: rnd(),
        speed: 0.10 + rnd() * 0.16,
        size: 0.7 + rnd() * 0.7,
      })),
      seed: rnd() * 1000,
      level,
    };
    level.edges.push(e);
    allEdges.push(e);
    a.outEdges.push(e);
    b.inEdges.push(e);
  }

  return level;
}

function buildGraph() {
  const rnd = mulberry32(20250803);
  const built = buildLevel(SCENE.nodes, SCENE.edges, rnd, null);
  root.nodes.push(...built.nodes);
  root.edges.push(...built.edges);
  root.cols = built.cols;
  // Узлы корневого уровня должны ссылаться на root, а не на временный объект.
  for (const n of root.nodes) n.level = root;
  for (const e of root.edges) e.level = root;
}

/** Слоистая раскладка: глубина по рёбрам + барицентрическая сортировка. */
function layoutLevel(level, aspectOverride) {
  const nodes = level.nodes;
  const edges = level.edges;
  if (!nodes.length) return level;
  // --- обратные рёбра.
  // В схеме есть циклы обратной связи (телеметрия -> контроллер). Считать по
  // ним уровни нельзя — глубина росла бы бесконечно, поэтому замыкающие рёбра
  // исключаются из расчёта продольной координаты (рисуются они как обычно,
  // просто идут «против течения»).
  //
  // Наивный DFS помечает произвольное ребро цикла — какое попадётся первым при
  // обходе, — и схема разъезжается на лишние колонки. Поэтому используем
  // эвристику Eades–Lin–Smyth: строим линейный порядок узлов, в котором против
  // направления идёт минимум рёбер. Они и есть обратные.
  const outDeg = new Map();
  const inDeg = new Map();
  const alive = new Set(nodes);
  for (const n of nodes) { outDeg.set(n, 0); inDeg.set(n, 0); }
  for (const e of edges) {
    if (e.a === e.b) continue;
    outDeg.set(e.a, outDeg.get(e.a) + 1);
    inDeg.set(e.b, inDeg.get(e.b) + 1);
  }

  const drop = (n) => {
    alive.delete(n);
    for (const e of n.outEdges) if (e.a !== e.b && alive.has(e.b)) inDeg.set(e.b, inDeg.get(e.b) - 1);
    for (const e of n.inEdges) if (e.a !== e.b && alive.has(e.a)) outDeg.set(e.a, outDeg.get(e.a) - 1);
  };

  const head = [];   // источники — уходят в начало порядка
  const tail = [];   // стоки — в конец
  while (alive.size) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const n of Array.from(alive)) {
        if (alive.has(n) && outDeg.get(n) === 0) { tail.unshift(n); drop(n); moved = true; }
      }
      for (const n of Array.from(alive)) {
        if (alive.has(n) && inDeg.get(n) === 0) { head.push(n); drop(n); moved = true; }
      }
    }
    if (!alive.size) break;
    // Остался цикл: жертвуем узлом с максимальным перевесом исходящих связей.
    let best = null;
    let bestVal = -Infinity;
    for (const n of alive) {
      const v = outDeg.get(n) - inDeg.get(n);
      if (v > bestVal) { bestVal = v; best = n; }
    }
    head.push(best);
    drop(best);
  }

  const pos = new Map();
  head.concat(tail).forEach((n, i) => pos.set(n, i));
  for (const e of edges) e.back = e.a === e.b || pos.get(e.a) > pos.get(e.b);

  // --- глубина: длиннейший путь по прямым рёбрам (граф уже ациклический)
  for (const n of nodes) n.depth = 0;
  for (let it = 0; it < nodes.length; it++) {
    let changed = false;
    for (const e of edges) {
      if (e.back || e.a === e.b) continue;
      if (e.b.depth < e.a.depth + 1) { e.b.depth = e.a.depth + 1; changed = true; }
    }
    if (!changed) break;
  }

  // --- ограничение высоты колонки.
  // Без него широкий уровень вытягивает схему в вертикальную ленту, и после
  // вписывания в экран текст становится нечитаемым. Ёмкость подбираем так,
  // чтобы пропорции графа тяготели к пропорциям окна; переполнение сдвигает
  // узел вправо — порядок «слева направо» по прямым рёбрам сохраняется.
  const avgW = nodes.reduce((s, n) => s + n.baseW, 0) / nodes.length + (level.gapX || METRIC.colGap);
  const avgH = nodes.reduce((s, n) => s + n.baseH, 0) / nodes.length + (level.gapY || METRIC.rowGap);
  const aspect = aspectOverride
    || Math.max(0.6, (cssW || 1600) / (cssH || 900));
  const capacity = Math.max(3, Math.round(Math.sqrt((nodes.length * avgW) / (avgH * aspect))));

  const topo = nodes.slice().sort((p, q) => p.depth - q.depth);   // валидный топопорядок
  const fill = [];
  for (const n of topo) {
    let cand = 0;
    for (const e of n.inEdges) {
      if (e.back || e.a === n) continue;
      cand = Math.max(cand, e.a.depth + 1);
    }
    while ((fill[cand] || 0) >= capacity) cand++;
    n.depth = cand;
    fill[cand] = (fill[cand] || 0) + 1;
  }

  // --- группировка по колонкам
  const cols = [];
  for (const n of nodes) {
    (cols[n.depth] || (cols[n.depth] = [])).push(n);
    n.col = n.depth;
  }

  // Первичная расстановка нужна барицентрическим проходам как отправная точка.
  placeLevel(level, cols, true);

  // --- барицентрические проходы: уменьшают пересечения рёбер
  const bary = (n, side) => {
    const list = side === 'in' ? n.inEdges : n.outEdges;
    if (!list.length) return n.lty;
    let s = 0;
    for (const e of list) s += (side === 'in' ? e.a.lty : e.b.lty);
    return s / list.length;
  };

  for (let pass = 0; pass < 6; pass++) {
    const forward = pass % 2 === 0;
    for (let i = 0; i < cols.length; i++) {
      const c = forward ? i : cols.length - 1 - i;
      const list = cols[c];
      if (!list || list.length < 2) continue;
      const key = new Map();
      for (const n of list) key.set(n, bary(n, forward ? 'in' : 'out'));
      list.sort((p, q) => key.get(p) - key.get(q));
      placeLevel(level, cols, true);
    }
  }

  level.cols = cols;

  // --- очерёдность сборки: слева направо, сверху вниз
  const order = nodes.slice().sort((p, q) => (p.col - q.col) || (p.lty - q.lty));
  order.forEach((n, i) => { n.bootDelay = n.col * 0.18 + i * 0.05; });

  return level;
}

/**
 * Расставляет узлы уровня по колонкам, исходя из ТЕКУЩИХ размеров.
 * Вызывается заново каждый раз, когда узел раскрывается или схлопывается —
 * именно отсюда берётся эффект «схема раздвигается»: цели смещаются, а узлы
 * плавно к ним едут. snap=true ставит узлы в цель мгновенно (первичный расчёт).
 */
function placeLevel(level, cols, snap) {
  cols = cols || level.cols;
  if (!cols) return;

  // X колонок: ширина колонки = максимум ширины её узлов
  const gapX = level.gapX || METRIC.colGap;
  const gapY = level.gapY || METRIC.rowGap;

  let x = 0;
  const colX = [];
  for (let c = 0; c < cols.length; c++) {
    const list = cols[c] || [];
    const cw = list.reduce((m, n) => Math.max(m, n.w), METRIC.minW);
    colX[c] = x + cw / 2;
    x += cw + gapX;
  }

  for (let c = 0; c < cols.length; c++) {
    const list = cols[c];
    if (!list) continue;
    let total = 0;
    for (const n of list) total += n.h + gapY;
    total -= gapY;
    let y = -total / 2;
    for (const n of list) {
      n.ltx = colX[c];
      n.lty = y + n.h / 2;
      y += n.h + gapY;
    }
  }

  // Центрируем уровень в собственном начале координат.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of level.nodes) {
    minX = Math.min(minX, n.ltx - n.w / 2); maxX = Math.max(maxX, n.ltx + n.w / 2);
    minY = Math.min(minY, n.lty - n.h / 2); maxY = Math.max(maxY, n.lty + n.h / 2);
  }
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
  for (const n of level.nodes) { n.ltx -= ox; n.lty -= oy; }

  level.w = maxX - minX;
  level.h = maxY - minY;

  if (snap) for (const n of level.nodes) { n.lx = n.ltx; n.ly = n.lty; }
}

/* --- маршрутизация рёбер ------------------------------------------------- */

const EDGE_SEGMENTS = 44;

/** Точки крепления: по горизонтали или вертикали — что естественнее. */
function edgeAnchors(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const horizontal = Math.abs(dx) > Math.abs(dy) * 0.75;

  if (horizontal) {
    const s = dx >= 0 ? 1 : -1;
    return {
      p1x: a.x + (s * a.w) / 2, p1y: a.y, d1x: s, d1y: 0,
      p2x: b.x - (s * b.w) / 2, p2y: b.y, d2x: -s, d2y: 0,
    };
  }
  const s = dy >= 0 ? 1 : -1;
  return {
    p1x: a.x, p1y: a.y + (s * a.h) / 2, d1x: 0, d1y: s,
    p2x: b.x, p2y: b.y - (s * b.h) / 2, d2x: 0, d2y: -s,
  };
}

function rebuildEdge(e) {
  let an, k;

  if (e.back) {
    // Обратная связь идёт против общего течения схемы. Проложенная напрямую,
    // она прошивает насквозь все панели между источником и целью, поэтому
    // уводим её вниз — отдельной шиной, огибающей схему снизу.
    an = {
      p1x: e.a.x, p1y: e.a.y + e.a.h / 2, d1x: 0, d1y: 1,
      p2x: e.b.x, p2y: e.b.y + e.b.h / 2, d2x: 0, d2y: 1,
    };
    k = clamp(Math.abs(e.b.x - e.a.x) * 0.34 + 60, 110, 210);
  } else {
    an = edgeAnchors(e.a, e.b);
    const dist = Math.hypot(an.p2x - an.p1x, an.p2y - an.p1y);
    k = clamp(dist * 0.42, 46, 210);
  }

  const c1x = an.p1x + an.d1x * k, c1y = an.p1y + an.d1y * k;
  const c2x = an.p2x + an.d2x * k, c2y = an.p2y + an.d2y * k;

  const pts = e.pts;
  pts.length = 0;
  for (let i = 0; i <= EDGE_SEGMENTS; i++) {
    const t = i / EDGE_SEGMENTS;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    pts.push({
      x: w0 * an.p1x + w1 * c1x + w2 * c2x + w3 * an.p2x,
      y: w0 * an.p1y + w1 * c1y + w2 * c2y + w3 * an.p2y,
    });
  }

  const cum = e.cum;
  cum.length = 0;
  cum.push(0);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum.push(total);
  }
  e.len = total;
  e.endDirX = an.d2x; e.endDirY = an.d2y;

  // Обходные дуги выходят далеко за габариты панелей — запоминаем размах,
  // чтобы вписывание в экран их не обрезало.
  if (e.back) {
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
    e.minY = lo; e.maxY = hi;
  } else {
    e.minY = e.maxY = null;
  }
  e.dirty = false;
}

/** Точка на ребре по нормированной длине 0..1 (равномерно, не по параметру). */
function pointAtLen(e, s) {
  const target = clamp(s, 0, 1) * e.len;
  const cum = e.cum;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (target - cum[lo]) / seg;
  const p = e.pts[lo], q = e.pts[hi];
  return { x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t), dx: q.x - p.x, dy: q.y - p.y };
}

/* =============================================================================
 * 6. КАМЕРА
 * ========================================================================== */

const cam = {
  x: 0, y: 0, scale: 1,
  tx: 0, ty: 0, tscale: 1,   // цели, к которым идёт плавное приближение
};

let cssW = 1, cssH = 1;

function worldToScreen(wx, wy) {
  return {
    x: (wx - cam.x) * cam.scale + cssW / 2,
    y: (wy - cam.y) * cam.scale + cssH / 2,
  };
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - cssW / 2) / cam.scale + cam.x,
    y: (sy - cssH / 2) / cam.scale + cam.y,
  };
}

function graphBounds(pad = 0) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2);
    minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2);
  }
  // Обходные дуги ныряют далеко за панели. Учитываем их лишь частично: иначе
  // схема прижимается к краю экрана ради пустоты под обходом.
  let bowTop = minY, bowBot = maxY;
  for (const e of edges) {
    if (e.maxY == null) continue;
    bowTop = Math.min(bowTop, e.minY);
    bowBot = Math.max(bowBot, e.maxY);
  }
  minY += (bowTop - minY) * 0.4;
  maxY += (bowBot - maxY) * 0.4;
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

function fitView(instant = false) {
  const b = graphBounds(90);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;

  // Сцена может занять часть экрана своими панелями — вписываем в остаток,
  // иначе схема уезжает под них.
  const ins = (SCENE && SCENE.viewInset) || {};
  const availW = Math.max(200, cssW - (ins.left || 0) - (ins.right || 0));
  const availH = Math.max(200, cssH - (ins.top || 0) - (ins.bottom || 0));
  const s = clamp(Math.min(availW / w, availH / h), 0.18, 1.6);

  // Центр свободной области в мировых координатах.
  const shiftX = ((ins.left || 0) - (ins.right || 0)) / 2 / s;
  const shiftY = ((ins.top || 0) - (ins.bottom || 0)) / 2 / s;
  cam.tx = (b.minX + b.maxX) / 2 - shiftX;
  cam.ty = (b.minY + b.maxY) / 2 - shiftY;
  cam.tscale = s;
  if (instant) { cam.x = cam.tx; cam.y = cam.ty; cam.scale = cam.tscale; }
}

/* =============================================================================
 * 7. RENDER TARGETS
 * ========================================================================== */

const out = view.getContext('2d', { alpha: false, desynchronized: true });

let DPR = 1, W = 1, H = 1;

function makeRT(w, h, alpha = false) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0);
  c.height = Math.max(1, h | 0);
  const x = c.getContext('2d', { alpha });
  return { c, x, w: c.width, h: c.height };
}

const RT = {
  scene: null,
  levels: [],     // пирамида блума
  tint: [],       // R/G/B копии для хроматической аберрации
  chroma: null,   // каналы, сведённые обратно в один слой
  half: null,     // промежуточный буфер bright-pass
  streak: null,   // анаморфный горизонтальный блик
  overlay: null,  // статичный слой: скан-линии + виньетка
};

const BLOOM_LEVELS = 6;

function resize() {
  // The panel decides the size, not the window: this canvas is one element on a
  // page, and CSS may give it any box at all.
  const box = view.parentNode && view.parentNode.getBoundingClientRect
    ? view.parentNode.getBoundingClientRect() : null;
  cssW = Math.max(1, Math.round((box && box.width) || view.clientWidth || 800));
  cssH = Math.max(1, Math.round((box && box.height) || view.clientHeight || 500));
  DPR = clamp(window.devicePixelRatio || 1, 1, 2);
  W = Math.round(cssW * DPR);
  H = Math.round(cssH * DPR);

  view.width = W;
  view.height = H;
  view.style.width = cssW + 'px';
  view.style.height = cssH + 'px';

  RT.scene = makeRT(W, H);

  RT.levels.length = 0;
  let lw = Math.max(2, W >> 1), lh = Math.max(2, H >> 1);
  for (let i = 0; i < BLOOM_LEVELS; i++) {
    RT.levels.push(makeRT(lw, lh));
    lw = Math.max(2, lw >> 1);
    lh = Math.max(2, lh >> 1);
  }

  // Каналы для аберрации берём на четверти разрешения: блум и так размыт,
  // а три полноразмерных тонировки заметно съедали бы кадр.
  const l0 = RT.levels[0];
  const l1 = RT.levels[1];
  const l2 = RT.levels[2];
  RT.tint = [makeRT(l2.w, l2.h), makeRT(l2.w, l2.h), makeRT(l2.w, l2.h)];
  RT.chroma = makeRT(l1.w, l1.h);
  RT.half = makeRT(l0.w, l0.h);
  RT.streak = makeRT(RT.levels[3].w, RT.levels[3].h);
  RT.overlay = makeRT(W, H, true);

  buildGrainTiles();
  buildOverlay();
}

/**
 * Виньетка не меняется от кадра к кадру, поэтому запекается в отдельный слой:
 * за кадр остаётся один drawImage вместо полноэкранного градиента.
 *
 * Глобальных скан-линий здесь намеренно нет — тёмная решётка поверх всего
 * кадра съедала читаемость текста в панелях. Ощущение развёртки дают
 * подвижные линии внутри самих панелей: они светлые и текст не забивают.
 */
function buildOverlay() {
  const o = RT.overlay;
  const x = o.x;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
  x.clearRect(0, 0, o.w, o.h);

  const vg = x.createRadialGradient(o.w / 2, o.h / 2, Math.min(o.w, o.h) * 0.30,
                                    o.w / 2, o.h / 2, Math.max(o.w, o.h) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(0.7, 'rgba(0,0,0,0.28)');
  vg.addColorStop(1, 'rgba(0,0,0,0.74)');
  x.fillStyle = vg;
  x.fillRect(0, 0, o.w, o.h);
}

/* =============================================================================
 * 8. ПРИМИТИВЫ ФОРМЫ
 * ========================================================================== */

/** Прямоугольник со срезанными углами — базовая форма HUD-панели. */
function chamferPath(ctx, x, y, w, h, c, corners) {
  const tl = !corners || corners[0], tr = !corners || corners[1];
  const br = !corners || corners[2], bl = !corners || corners[3];
  const cc = Math.min(c, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + (tl ? cc : 0), y);
  ctx.lineTo(x + w - (tr ? cc : 0), y);
  if (tr) ctx.lineTo(x + w, y + cc);
  ctx.lineTo(x + w, y + h - (br ? cc : 0));
  if (br) ctx.lineTo(x + w - cc, y + h);
  ctx.lineTo(x + (bl ? cc : 0), y + h);
  if (bl) ctx.lineTo(x, y + h - cc);
  ctx.lineTo(x, y + (tl ? cc : 0));
  if (tl) ctx.lineTo(x + cc, y);
  ctx.closePath();
}

/** Угловые скобки — «прицельные» маркеры вокруг панели. */
function cornerBrackets(ctx, x, y, w, h, len, gap) {
  const L = Math.min(len, w / 2 - 2, h / 2 - 2);
  const X0 = x - gap, Y0 = y - gap, X1 = x + w + gap, Y1 = y + h + gap;
  ctx.beginPath();
  ctx.moveTo(X0, Y0 + L); ctx.lineTo(X0, Y0); ctx.lineTo(X0 + L, Y0);
  ctx.moveTo(X1 - L, Y0); ctx.lineTo(X1, Y0); ctx.lineTo(X1, Y0 + L);
  ctx.moveTo(X1, Y1 - L); ctx.lineTo(X1, Y1); ctx.lineTo(X1 - L, Y1);
  ctx.moveTo(X0 + L, Y1); ctx.lineTo(X0, Y1); ctx.lineTo(X0, Y1 - L);
  ctx.stroke();
}

/** Пересечение прямоугольников отсечения — для текста на вложенных уровнях. */
function clipIntersect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Пунктирная «направляющая» между подписью и значением. */
function leaderDots(ctx, x0, x1, y, step, color) {
  if (x1 - x0 < step) return;
  ctx.fillStyle = color;
  for (let x = x0; x < x1; x += step) ctx.fillRect(x, y, 1, 1);
}

/* --- предрендеренное свечение -------------------------------------------- */

// Радиальный градиент на каждую светящуюся точку обходится слишком дорого:
// их в кадре под сотню. Вместо этого держим готовые спрайты по цветам —
// цвет квантуем, поэтому кэш остаётся крошечным.
const glowCache = new Map();

function glowSprite(c) {
  const key = `${c[0] >> 4}|${c[1] >> 4}|${c[2] >> 4}`;
  let sprite = glowCache.get(key);
  if (sprite) return sprite;

  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const x = cv.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, `rgba(255,255,255,1)`);
  g.addColorStop(0.14, rgba(mix(c, C.paper, 0.7), 0.85));
  g.addColorStop(0.34, rgba(c, 0.38));
  g.addColorStop(0.62, rgba(c, 0.10));
  g.addColorStop(1, rgba(c, 0));
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);

  glowCache.set(key, cv);
  return cv;
}

/**
 * Светящаяся точка радиуса r. Ожидает режим наложения 'lighter'.
 * Прозрачность перемножается с текущей, а не затирает её: вложенные уровни
 * проявляются через общий globalAlpha, и сброс в единицу их бы «засветил».
 */
function drawGlow(ctx, x, y, r, color, alpha) {
  if (r <= 0 || alpha <= 0.004) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = prev;
}

/* =============================================================================
 * 9. ФОН
 * ========================================================================== */

function drawBackground(ctx, t) {
  // Базовая заливка + мягкий центральный подсвет.
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#02060b';
  ctx.fillRect(0, 0, cssW, cssH);

  const g = ctx.createRadialGradient(
    cssW * 0.5, cssH * 0.52, 0,
    cssW * 0.5, cssH * 0.52, Math.max(cssW, cssH) * 0.72
  );
  g.addColorStop(0, 'rgba(18,64,104,0.42)');
  g.addColorStop(0.45, 'rgba(9,32,58,0.20)');
  g.addColorStop(1, 'rgba(2,6,11,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssW, cssH);
}

/** Мировая сетка с адаптивным шагом — фиксирует масштаб в пространстве. */
function drawGrid(ctx, t) {
  if (!FLAGS.grid) return;

  let step = 40;
  while (step * cam.scale < 22) step *= 4;
  const major = step * 5;

  const tl = screenToWorld(0, 0);
  const br = screenToWorld(cssW, cssH);

  const x0 = Math.floor(tl.x / step) * step;
  const y0 = Math.floor(tl.y / step) * step;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.lineWidth = 1;

  // Мелкая сетка.
  ctx.beginPath();
  for (let wx = x0; wx <= br.x; wx += step) {
    const sx = Math.round((wx - cam.x) * cam.scale + cssW / 2) + 0.5;
    ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH);
  }
  for (let wy = y0; wy <= br.y; wy += step) {
    const sy = Math.round((wy - cam.y) * cam.scale + cssH / 2) + 0.5;
    ctx.moveTo(0, sy); ctx.lineTo(cssW, sy);
  }
  ctx.strokeStyle = 'rgba(70,168,214,0.055)';
  ctx.stroke();

  // Крупная сетка.
  ctx.beginPath();
  const mx0 = Math.floor(tl.x / major) * major;
  const my0 = Math.floor(tl.y / major) * major;
  for (let wx = mx0; wx <= br.x; wx += major) {
    const sx = Math.round((wx - cam.x) * cam.scale + cssW / 2) + 0.5;
    ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH);
  }
  for (let wy = my0; wy <= br.y; wy += major) {
    const sy = Math.round((wy - cam.y) * cam.scale + cssH / 2) + 0.5;
    ctx.moveTo(0, sy); ctx.lineTo(cssW, sy);
  }
  ctx.strokeStyle = 'rgba(88,200,255,0.10)';
  ctx.stroke();
}

/** Концентрические кольца и вращающиеся тики — «стол проектора». */
function drawRings(ctx, t) {
  if (!FLAGS.grid) return;
  const c = worldToScreen(0, 0);
  const base = 320 * cam.scale;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.save();
  ctx.translate(c.x, c.y);

  for (let i = 0; i < 4; i++) {
    const r = base * (0.55 + i * 0.42);
    if (r < 12 || r > Math.max(cssW, cssH) * 1.6) continue;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.strokeStyle = `rgba(90,200,255,${0.05 - i * 0.008})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Тики по кольцу.
    const dir = i % 2 === 0 ? 1 : -1;
    const rot = t * 0.055 * dir + i;
    const count = 48;
    ctx.beginPath();
    for (let k = 0; k < count; k++) {
      const a = rot + (k / count) * TAU;
      const long = k % 6 === 0;
      const r1 = r, r2 = r + (long ? 8 : 3);
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
    }
    ctx.strokeStyle = `rgba(96,232,255,${0.07 - i * 0.012})`;
    ctx.stroke();
  }
  ctx.restore();
}

/* --- атмосферная пыль ----------------------------------------------------- */

const dust = (() => {
  const rnd = mulberry32(7777);
  const arr = [];
  for (let i = 0; i < 260; i++) {
    arr.push({
      x: (rnd() * 2 - 1) * 2400,
      y: (rnd() * 2 - 1) * 1500,
      z: 0.35 + rnd() * 0.9,           // параллакс-глубина
      s: 0.5 + rnd() * 1.6,
      ph: rnd() * TAU,
      sp: 0.1 + rnd() * 0.35,
    });
  }
  return arr;
})();

function drawDust(ctx, t) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  for (const d of dust) {
    const wy = d.y + Math.sin(t * d.sp + d.ph) * 26;
    const wx = d.x + Math.cos(t * d.sp * 0.7 + d.ph) * 18;
    // Параллакс: дальние точки движутся с камерой медленнее.
    const sx = (wx - cam.x * d.z) * cam.scale + cssW / 2;
    const sy = (wy - cam.y * d.z) * cam.scale + cssH / 2;
    if (sx < -20 || sx > cssW + 20 || sy < -20 || sy > cssH + 20) continue;
    const a = 0.10 + 0.16 * (Math.sin(t * 1.6 + d.ph) * 0.5 + 0.5);
    ctx.fillStyle = `rgba(140,225,255,${a * d.z * 0.8})`;
    const s = d.s * clamp(cam.scale, 0.5, 1.4);
    ctx.fillRect(sx, sy, s, s);
  }
}

/* =============================================================================
 * 10. РЁБРА
 * ========================================================================== */

function drawEdge(ctx, e, t) {
  const p = e.boot;
  if (p <= 0.001) return;

  const pts = e.pts;
  const n = pts.length;
  const shown = Math.max(2, Math.ceil((n - 1) * easeOutCubic(p)) + 1);

  const focus = e.hover;
  const dim = e.dim;
  const ca = e.a.color, cb = e.b.color;

  const s1 = worldToScreen(pts[0].x, pts[0].y);
  const s2 = worldToScreen(pts[n - 1].x, pts[n - 1].y);

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Путь строится один раз и обводится трижды — «ядро + гало» без дорогого
  // shadowBlur. Преобразование координат разворачиваем вручную: на кадр
  // приходится под тысячу точек, и объекты от worldToScreen здесь лишние.
  const kx = cam.scale;
  const offX = cssW / 2 - cam.x * kx;
  const offY = cssH / 2 - cam.y * kx;

  ctx.beginPath();
  ctx.moveTo(pts[0].x * kx + offX, pts[0].y * kx + offY);
  for (let i = 1; i < shown; i++) {
    ctx.lineTo(pts[i].x * kx + offX, pts[i].y * kx + offY);
  }

  const flick = 0.9 + 0.1 * noiseA(t * 2.2 + e.seed);
  const mid = mix(ca, cb, 0.5);

  // 1) широкое гало
  ctx.strokeStyle = rgba(mid, 0.16 * dim * flick * (1 + focus));
  ctx.lineWidth = (3.4 + focus * 3.2) * clamp(cam.scale, 0.5, 1.5);
  ctx.stroke();

  // 2) средний слой
  ctx.strokeStyle = rgba(mid, 0.42 * dim * (0.7 + focus * 0.5));
  ctx.lineWidth = (1.5 + focus * 1.1) * clamp(cam.scale, 0.55, 1.4);
  ctx.stroke();

  // 3) яркое ядро — здесь градиент виден, поэтому он остаётся
  const grad = ctx.createLinearGradient(s1.x, s1.y, s2.x, s2.y);
  grad.addColorStop(0, rgba(mix(ca, C.ice, 0.55), (0.55 + focus * 0.45) * dim));
  grad.addColorStop(1, rgba(mix(cb, C.ice, 0.55), (0.55 + focus * 0.45) * dim));
  ctx.strokeStyle = grad;
  ctx.lineWidth = 0.85 * clamp(cam.scale, 0.6, 1.3);
  ctx.stroke();

  // Бегущий пунктир поверх — ощущение потока.
  if (cam.scale > 0.4) {
    ctx.save();
    ctx.setLineDash([2.5, 9]);
    ctx.lineDashOffset = -t * 34 - e.seed;
    ctx.strokeStyle = rgba(C.ice, 0.30 * dim * (0.5 + focus));
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.restore();
  }

  if (p < 0.999) return;

  // Наконечник.
  const tip = pointAtLen(e, 1);
  const tp = worldToScreen(tip.x, tip.y);
  const ang = Math.atan2(-e.endDirY, -e.endDirX);
  const size = (6 + focus * 3) * clamp(cam.scale, 0.5, 1.3);
  ctx.save();
  ctx.translate(tp.x, tp.y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.lineTo(-size, -size * 0.5);
  ctx.lineTo(-size * 0.62, 0);
  ctx.lineTo(-size, size * 0.5);
  ctx.closePath();
  ctx.fillStyle = rgba(mix(cb, C.ice, 0.4), (0.75 + focus * 0.25) * dim);
  ctx.fill();
  ctx.restore();

  // Подпись связи в середине — только при достаточном зуме.
  const labelZoom = FLAGS.labels ? 0.5 : 0.72;
  if (e.label && cam.scale > labelZoom && (focus > 0.02 || FLAGS.labels)) {
    const m = pointAtLen(e, 0.5);
    const mp = worldToScreen(m.x, m.y);
    const a = (FLAGS.labels ? 0.62 : 0.30) + focus * 0.38;
    const size = 7.5;
    const tw = textWidth(e.label, size, 500, 1.1);
    ctx.fillStyle = `rgba(2,10,18,${0.88 * a * dim})`;
    ctx.fillRect(mp.x - tw / 2 - 4, mp.y - 6, tw + 8, 12);
    ctx.strokeStyle = rgba(cb, 0.35 * a * dim);
    ctx.lineWidth = 1;
    ctx.strokeRect(mp.x - tw / 2 - 4.5, mp.y - 6.5, tw + 9, 13);
    drawText(ctx, e.label, mp.x, mp.y, {
      size, weight: 500, tracking: 1.1, align: 'center',
      color: rgba(C.ice, 0.9 * a * dim),
    });
  }
}

/** Пакеты данных — светящиеся сегменты, бегущие по связям. */
function drawPackets(ctx, e, t, dt) {
  if (e.boot < 0.999 || e.len < 1) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.lineCap = 'round';

  for (const pk of e.packets) {
    pk.t += (pk.speed * dt * (1 + e.hover * 1.2)) / Math.max(0.35, e.len / 260);
    if (pk.t > 1) pk.t -= 1 + Math.random() * 0.4;
    if (pk.t < 0) continue;

    const tail = 0.06;
    const t0 = clamp(pk.t - tail, 0, 1);
    const t1 = clamp(pk.t, 0, 1);
    if (t1 - t0 < 0.002) continue;

    const steps = 7;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const s = lerp(t0, t1, i / steps);
      const p = pointAtLen(e, s);
      const sp = worldToScreen(p.x, p.y);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    }
    const head = pointAtLen(e, t1);
    const hp = worldToScreen(head.x, head.y);

    const col = mix(e.a.color, e.b.color, t1);
    const k = clamp(cam.scale, 0.5, 1.4) * pk.size * e.dim;

    ctx.strokeStyle = rgba(mix(col, C.ice, 0.5), 0.55 * e.dim);
    ctx.lineWidth = 2.2 * k;
    ctx.stroke();

    ctx.strokeStyle = rgba(C.paper, 0.9 * e.dim);
    ctx.lineWidth = 0.9 * k;
    ctx.stroke();

    // Головка пакета со свечением.
    const r = 2.6 * k;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, hp.x, hp.y, r * 4, col, 0.85 * e.dim);
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* =============================================================================
 * 11. УЗЛЫ
 * ========================================================================== */

/**
 * Сборка узла разбита на фазы — как разворачивающаяся голограмма:
 *   0.00-0.30  горизонтальная линия раскрывается из центра
 *   0.20-0.55  каркас набирает высоту
 *   0.45-0.75  появляются заливка, шапка, разделители
 *   0.62-1.00  текст «печатается» построчно
 */
function drawNode(ctx, n, t, dt) {
  const p = n.boot;
  if (p <= 0.001) return;

  const pa = easeOutCubic(invLerp(0.00, 0.30, p));
  const pb = easeOutCubic(invLerp(0.20, 0.55, p));
  const pc = invLerp(0.45, 0.75, p);
  const pd = invLerp(0.62, 1.00, p);

  const dim = n.dim;
  const foc = Math.max(n.hover, n.select);

  // Голографическое «дыхание» узла. Держим его на грани заметности: сильнее —
  // и текст внутри панели начинает подрагивать при чтении.
  const jx = noiseA(t * 0.55 + n.seed) * 0.28;
  const jy = noiseB(t * 0.65 + n.seed) * 0.28;
  const flick = 0.955 + 0.045 * (noiseC(t * 1.5 + n.seed) * 0.5 + 0.5);

  const cw = n.w * pa;
  const ch = n.h * pb;

  const c = worldToScreen(n.x + jx, n.y + jy);
  const s = cam.scale;
  const x = c.x - (cw / 2) * s;
  const y = c.y - (ch / 2) * s;
  const w = cw * s;
  const h = ch * s;

  // Отсечение по экрану.
  if (x > cssW + 200 || x + w < -200 || y > cssH + 200 || y + h < -200) return;

  const col = n.color;
  const acc = n.accent;
  const alpha = dim * flick;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.lineJoin = 'miter';

  // --- фаза 1: линия раскрытия
  if (pb < 0.02) {
    ctx.beginPath();
    ctx.moveTo(c.x - (w / 2), c.y);
    ctx.lineTo(c.x + (w / 2), c.y);
    ctx.strokeStyle = rgba(acc, 0.9 * alpha);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.strokeStyle = rgba(col, 0.28 * alpha);
    ctx.lineWidth = 5;
    ctx.stroke();
    return;
  }

  const ch1 = Math.min(11 * s, h / 2, w / 2);

  // Раскрытый контейнер — это рамка вокруг вложенной схемы, а не светящаяся
  // панель. Его собственную заливку и ореол приглушаем, иначе плита такого
  // размера уводит bloom в пересвет и топит содержимое.
  const openK = (n.sub || n.leaf) ? easeInOutCubic(n.expandT) : 0;
  const fillK = 1 - openK * 0.74;

  // --- подложка: мягкое свечение под панелью
  if ((foc > 0.01 || n.kind === 'core') && openK < 0.98) {
    const k = (n.kind === 'core' ? 0.5 : 0) + foc * 1.5;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, c.x, c.y, Math.max(w, h) * 0.85, col,
             0.20 * k * alpha * n.glowK * (1 - openK));
    ctx.globalCompositeOperation = 'source-over';
  }

  // --- корпус.
  // Сначала плотная тёмная подложка: связи проходят под панелями, и без неё
  // они просвечивают сквозь строки данных, перечёркивая текст. Немного света
  // всё же пропускаем — панель должна остаться стеклом, а не картонкой.
  chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
  ctx.fillStyle = `rgba(3,11,20,${0.93 * pc * dim})`;
  ctx.fill();

  const body = ctx.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, rgba(col, (0.16 + foc * 0.10) * pc * alpha * fillK));
  body.addColorStop(0.5, rgba(col, (0.055 + foc * 0.05) * pc * alpha * fillK));
  body.addColorStop(1, rgba(col, (0.10 + foc * 0.07) * pc * alpha * fillK));
  ctx.fillStyle = body;
  ctx.fill();

  // Тонкая внутренняя «плёнка» — стеклянный блик по верхней кромке.
  ctx.save();
  ctx.clip();
  const sheen = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
  sheen.addColorStop(0, rgba(C.ice, 0.10 * pc * alpha * fillK));
  sheen.addColorStop(0.4, rgba(C.ice, 0));
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h);

  // Внутренние скан-линии, медленно ползущие вверх.
  if (s > 0.35) {
    const period = 4 * s;
    const off = ((-t * 22 * s) % period + period) % period;
    ctx.fillStyle = rgba(col, 0.055 * pc * alpha * fillK);
    for (let yy = y + off; yy < y + h; yy += period) {
      ctx.fillRect(x, Math.round(yy), w, Math.max(1, s * 0.9));
    }
  }

  // Проходящая волна подсветки — «сканирование» панели.
  const wavePos = ((t * 0.42 + n.seed * 0.37) % 2.2) / 2.2;
  if (wavePos < 1) {
    const wy = y + h * wavePos;
    const wg = ctx.createLinearGradient(0, wy - 22 * s, 0, wy + 22 * s);
    wg.addColorStop(0, rgba(acc, 0));
    wg.addColorStop(0.5, rgba(acc, 0.16 * pc * alpha * fillK));
    wg.addColorStop(1, rgba(acc, 0));
    ctx.fillStyle = wg;
    ctx.fillRect(x, wy - 22 * s, w, 44 * s);
  }
  ctx.restore();

  // --- рамка
  chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
  ctx.strokeStyle = rgba(col, (0.30 + foc * 0.35) * alpha);
  ctx.lineWidth = 3.2;
  ctx.stroke();
  ctx.strokeStyle = rgba(mix(col, acc, 0.6), (0.85 + foc * 0.15) * alpha);
  ctx.lineWidth = 1.15;
  ctx.stroke();

  // --- угловые скобки
  ctx.strokeStyle = rgba(acc, (0.45 + foc * 0.55) * alpha * pb);
  ctx.lineWidth = 1.3;
  cornerBrackets(ctx, x, y, w, h, 12 * s, (3 + foc * 4) * s);

  // Сцена может пометить узел поверх рамки — например, следом воздействия AI.
  if (SCENE.decorateNode) SCENE.decorateNode(ctx, n, { x, y, w, h, s, alpha }, t);

  // Внешний прицельный контур при наведении.
  if (foc > 0.01) {
    const g2 = (10 + Math.sin(t * 3) * 2) * s * foc;
    ctx.strokeStyle = rgba(acc, 0.30 * foc * alpha);
    ctx.lineWidth = 1;
    cornerBrackets(ctx, x, y, w, h, 20 * s, g2 + 5 * s);
  }

  if (pc <= 0.02 || s < 0.16) return;

  const openT = n.expandT;

  // --- раскрытый лист: вместо сводки — развёрнутая карточка
  if (openT > 0.10 && n.leaf && !n.sub) {
    ctx.save();
    chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
    ctx.clip();
    const prevClip = textClip;
    textClip = clipIntersect(prevClip, { x, y, w, h });
    ctx.globalAlpha *= easeOutCubic(clamp((openT - 0.2) / 0.8, 0, 1));
    SCENE.detail.draw(ctx, n, x, y, w, h, s, alpha, t);
    textClip = prevClip;
    ctx.restore();

    chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
    ctx.strokeStyle = rgba(mix(col, acc, 0.6), (0.85 + foc * 0.15) * alpha);
    ctx.lineWidth = 1.15;
    ctx.stroke();
    return;
  }

  // --- раскрытый контейнер: вместо строк данных внутри живёт вложенный граф
  if (openT > 0.10 && n.sub) {
    ctx.save();
    chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
    ctx.clip();

    const prevClip = textClip;
    textClip = clipIntersect(prevClip, { x, y, w, h });

    // Заголовок контейнера остаётся на месте, содержимое проявляется.
    const headH = METRIC.headerH * s;
    ctx.fillStyle = rgba(col, 0.14 * pc * alpha);
    ctx.fillRect(x, y, w, headH);
    ctx.beginPath();
    ctx.moveTo(x, y + headH + 0.5);
    ctx.lineTo(x + w, y + headH + 0.5);
    ctx.strokeStyle = rgba(mix(col, acc, 0.5), 0.65 * pc * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();

    const padX = METRIC.padX * s;
    drawText(ctx, n.title, x + padX + 8 * s, y + headH / 2 + 0.5 * s, {
      size: METRIC.titleSize * s, weight: 600, tracking: METRIC.titleTrack * s,
      color: rgba(mix(C.paper, acc, 0.25), 0.95 * pc * alpha),
    });
    drawText(ctx, `${n.sub.nodes.length} SUBSYSTEMS`, x + w - padX, y + headH / 2 + 0.5 * s, {
      size: METRIC.tagSize * s, weight: 400, tracking: METRIC.tagTrack * s,
      align: 'right', color: rgba(col, 0.66 * pc * alpha),
    });

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * easeOutCubic(clamp((openT - 0.28) / 0.72, 0, 1));
    drawLevel(ctx, n.sub, t, dt);
    ctx.globalAlpha = prevAlpha;

    textClip = prevClip;
    ctx.restore();

    // Контур поверх содержимого, чтобы вложенные панели не «резали» рамку.
    chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
    ctx.strokeStyle = rgba(mix(col, acc, 0.6), (0.85 + foc * 0.15) * alpha);
    ctx.lineWidth = 1.15;
    ctx.stroke();
    return;
  }

  // --- содержимое
  ctx.save();
  chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
  ctx.clip();
  // Тот же клип понадобится отложенному тексту — панель может оказаться уже
  // своего содержимого, и строки не должны выезжать за корпус. Пересекаем с
  // внешним клипом и потом восстанавливаем его: обнулять нельзя, иначе панель
  // внутри контейнера снимала бы отсечение со всех, кто рисуется после неё.
  const outerClip = textClip;
  textClip = clipIntersect(outerClip, { x, y, w, h });

  const padX = METRIC.padX * s;
  const headH = METRIC.headerH * s;

  // Шапка
  ctx.fillStyle = rgba(col, 0.14 * pc * alpha);
  ctx.fillRect(x, y, w, headH);
  ctx.beginPath();
  ctx.moveTo(x, y + headH + 0.5);
  ctx.lineTo(x + w, y + headH + 0.5);
  ctx.strokeStyle = rgba(mix(col, acc, 0.5), 0.65 * pc * alpha);
  ctx.lineWidth = 1;
  ctx.stroke();

  // Индикатор состояния — мигает с индивидуальной фазой.
  const blink = 0.55 + 0.45 * Math.sin(t * 2.6 + n.seed);
  const ledX = x + padX * 0.62;
  const ledY = y + headH / 2;
  const ledR = 2.6 * s;
  ctx.globalCompositeOperation = 'lighter';
  drawGlow(ctx, ledX, ledY, ledR * 5, acc, 0.85 * blink * pc * alpha);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = rgba(C.paper, 0.95 * pc * alpha);
  ctx.beginPath();
  ctx.arc(ledX, ledY, ledR * 0.75, 0, TAU);
  ctx.fill();

  // Заголовок с посимвольным появлением.
  if (s > 0.3) {
    const titleShown = n.title.slice(0, Math.ceil(n.title.length * clamp(pd * 1.6, 0, 1)));
    drawText(ctx, titleShown, x + padX + 8 * s, y + headH / 2 + 0.5 * s, {
      size: METRIC.titleSize * s,
      weight: 600,
      tracking: METRIC.titleTrack * s,
      color: rgba(mix(C.paper, acc, 0.25), (0.92 + foc * 0.08) * pc * alpha),
    });

    // Тег справа.
    drawText(ctx, n.tag, x + w - padX, y + headH / 2 + 0.5 * s, {
      size: METRIC.tagSize * s,
      weight: 400,
      tracking: METRIC.tagTrack * s,
      align: 'right',
      color: rgba(col, 0.62 * pc * alpha),
    });
  }

  // Левая шкала с тиками — декоративный «линеал».
  if (s > 0.45) {
    const bodyTop = y + headH + 4 * s;
    const bodyBot = y + h - METRIC.footerH * s;
    ctx.beginPath();
    for (let yy = bodyTop; yy < bodyBot; yy += 4 * s) {
      const long = Math.round((yy - bodyTop) / (4 * s)) % 4 === 0;
      ctx.moveTo(x + 4 * s, yy);
      ctx.lineTo(x + (long ? 8 : 6) * s, yy);
    }
    ctx.strokeStyle = rgba(col, 0.30 * pc * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Строки данных.
  if (s > 0.42) {
    const rowH = METRIC.rowH * s;
    let ry = y + headH + rowH * 0.72;
    const lx = x + padX + 4 * s;
    const rx = x + w - padX;

    for (let i = 0; i < n.rows.length; i++) {
      const rowP = clamp((pd - i * 0.10) / 0.5, 0, 1);
      if (rowP <= 0) break;
      const row = n.rows[i];
      const type = row[2];
      const ra = rowP * pc * alpha;

      if (type === 'bar') {
        // Индикатор загрузки с «живым» значением.
        const label = row[0];
        drawText(ctx, label, lx, ry, {
          size: METRIC.rowSize * s, weight: 400, tracking: METRIC.rowTrack * s,
          color: rgba(col, 0.62 * ra),
        });
        const val = n.leaf && SCENE.leaf.progress
          ? SCENE.leaf.progress(n.leaf)
          : clamp(n.load + noiseA(t * 0.55 + n.seed) * 0.16, 0.05, 0.99);
        const bx = lx + textWidth(label, METRIC.rowSize * s, 400, METRIC.rowTrack * s) + 8 * s;
        const bw = rx - bx - 26 * s;
        const bh = 3.6 * s;
        const by = ry - bh / 2;
        if (bw > 8) {
          ctx.fillStyle = rgba(col, 0.16 * ra);
          ctx.fillRect(bx, by, bw, bh);
          const fillW = bw * val * rowP;
          const bg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
          bg.addColorStop(0, rgba(col, 0.7 * ra));
          bg.addColorStop(1, rgba(acc, 0.95 * ra));
          ctx.fillStyle = bg;
          ctx.fillRect(bx, by, fillW, bh);
          // Насечки на шкале.
          ctx.fillStyle = `rgba(2,8,14,${0.6 * ra})`;
          for (let k = 1; k < 8; k++) ctx.fillRect(bx + (bw * k) / 8, by, 1, bh);
          drawText(ctx, `${Math.round(val * 100)}%`, rx, ry, {
            size: METRIC.rowSize * s, weight: 600, tracking: METRIC.rowTrack * s,
            align: 'right', color: rgba(acc, 0.9 * ra),
          });
        }
      } else {
        const label = row[0];
        // Значение может быть живым: расход токенов, счётчик задач, активность.
        const resolved = SCENE.resolveRow(n, row);
        const value = resolved.value;
        const shownValue = value.slice(0, Math.ceil(value.length * clamp(rowP * 1.5, 0, 1)));

        const lw = drawText(ctx, label, lx, ry, {
          size: METRIC.rowSize * s, weight: 400, tracking: METRIC.rowTrack * s,
          color: rgba(col, 0.60 * ra),
        });

        const vk = resolved.kind;
        let vc = C.paper;
        if (vk === 'ok') vc = C.green;
        else if (vk === 'warn') vc = C.amber;
        else if (vk === 'bad') vc = C.red;

        const vw = textWidth(shownValue, METRIC.rowSize * s, 600, METRIC.rowTrack * s);
        leaderDots(ctx, lx + lw + 5 * s, rx - vw - 5 * s, ry, 3.4 * s, rgba(col, 0.28 * ra));

        drawText(ctx, shownValue, rx, ry, {
          size: METRIC.rowSize * s, weight: 600, tracking: METRIC.rowTrack * s,
          align: 'right', color: rgba(vc, 0.95 * ra),
        });

        // Точка-маркер статуса.
        if (vk === 'ok' || vk === 'warn' || vk === 'bad') {
          const mx = rx - vw - 10 * s;
          ctx.fillStyle = rgba(vc, 0.85 * ra * (vk === 'bad' ? 0.5 + 0.5 * Math.sin(t * 7) : 1));
          ctx.fillRect(mx - 1.5 * s, ry - 1.5 * s, 3 * s, 3 * s);
        }
      }
      ry += rowH;
    }
  }

  // Подвал: id-полоска и штрих-код.
  if (s > 0.5) {
    const fy = y + h - METRIC.footerH * s / 2;
    ctx.beginPath();
    ctx.moveTo(x + padX * 0.5, y + h - METRIC.footerH * s);
    ctx.lineTo(x + w - padX * 0.5, y + h - METRIC.footerH * s);
    ctx.strokeStyle = rgba(col, 0.22 * pc * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();

    drawText(ctx, `NODE·${n.id}`, x + padX * 0.7, fy, {
      size: 7 * s, weight: 400, tracking: 1.0 * s,
      color: rgba(col, 0.5 * pc * alpha),
    });

    // Псевдо-штрихкод справа — детерминированный по seed узла.
    const bcW = 42 * s;
    let bx = x + w - padX * 0.7 - bcW;
    const rnd = mulberry32(Math.floor(n.seed * 1000));
    ctx.fillStyle = rgba(col, 0.42 * pc * alpha);
    while (bx < x + w - padX * 0.7) {
      const bw = (rnd() < 0.35 ? 1.8 : 0.9) * s;
      ctx.fillRect(bx, fy - 3 * s, bw, 6 * s);
      bx += bw + (0.8 + rnd() * 1.6) * s;
    }
  }

  ctx.restore();
  textClip = outerClip;

  // Метка выбора над панелью.
  if (n.select > 0.02 && s > 0.3) {
    const ly = y - 10 * s;
    drawText(ctx, '◂ SELECTED ▸', c.x, ly, {
      size: 7.5 * s, weight: 600, tracking: 1.6 * s, align: 'center',
      color: rgba(acc, 0.85 * n.select * alpha),
    });
  }
}

/** Частицы, слетающиеся к узлу в момент сборки. */
function drawNodeMotes(ctx, n, t) {
  const p = n.boot;
  if (p <= 0 || p >= 1) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const s = cam.scale;

  for (const m of n.motes) {
    const mp = clamp((p - m.t) / (1 - m.t), 0, 1);
    if (mp <= 0) continue;
    const e = easeOutQuint(mp);
    const wx = n.x + m.ax * (1 - e);
    const wy = n.y + m.ay * (1 - e);
    const sp = worldToScreen(wx, wy);
    const a = (1 - mp) * 0.9 * n.dim;
    const r = (1.2 + m.s * 1.6) * clamp(s, 0.4, 1.4);

    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, sp.x, sp.y, r * 4, n.color, a);
    ctx.globalCompositeOperation = 'source-over';

    // Трассирующий хвост к цели.
    const tail = worldToScreen(n.x + m.ax * (1 - e) * 1.12, n.y + m.ay * (1 - e) * 1.12);
    ctx.strokeStyle = rgba(n.accent, a * 0.4);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(tail.x, tail.y);
    ctx.stroke();
  }
}

/* =============================================================================
 * 12. ЭКРАННЫЙ HUD
 * ========================================================================== */

function pad2(v) { return v < 10 ? '0' + v : '' + v; }

function drawOverlay(ctx, t, fps) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  const chrome = SCENE.chrome !== false;   // сцена может рисовать свой интерфейс
  const M = 22;                       // отступ от края
  const ink = rgba(C.cyan, 0.72);
  const inkDim = rgba(C.cyan, 0.36);

  if (!chrome) {
    // Интерфейс рисует сцена — от движка нужны только крошки пути.
    drawBreadcrumbs(ctx, t);
    if (SCENE.minimap !== false) drawMinimap(ctx, t);
    if (SCENE.overlay) SCENE.overlay(ctx, t, { cssW, cssH, drillPath, hovered, selected });
    drawReticle(ctx, t);
    return;
  }

  // --- рамка кадра с разрывами по углам
  ctx.strokeStyle = rgba(C.cyan, 0.20);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const gapT = 210, gapB = 150;
  ctx.moveTo(M + gapT, M + 0.5); ctx.lineTo(cssW - M - gapT, M + 0.5);
  ctx.moveTo(M + gapB, cssH - M - 0.5); ctx.lineTo(cssW - M - gapB, cssH - M - 0.5);
  ctx.moveTo(M + 0.5, M + 90); ctx.lineTo(M + 0.5, cssH - M - 90);
  ctx.moveTo(cssW - M - 0.5, M + 90); ctx.lineTo(cssW - M - 0.5, cssH - M - 90);
  ctx.stroke();

  // Угловые скобки экрана.
  ctx.strokeStyle = rgba(C.cyan, 0.55);
  ctx.lineWidth = 1.4;
  const L = 28;
  ctx.beginPath();
  ctx.moveTo(M, M + L); ctx.lineTo(M, M); ctx.lineTo(M + L, M);
  ctx.moveTo(cssW - M - L, M); ctx.lineTo(cssW - M, M); ctx.lineTo(cssW - M, M + L);
  ctx.moveTo(cssW - M, cssH - M - L); ctx.lineTo(cssW - M, cssH - M); ctx.lineTo(cssW - M - L, cssH - M);
  ctx.moveTo(M + L, cssH - M); ctx.lineTo(M, cssH - M); ctx.lineTo(M, cssH - M - L);
  ctx.stroke();

  // --- заголовок слева сверху
  drawText(ctx, SCENE.title, M + 8, M + 16, {
    size: 15, weight: 600, tracking: 5.2, color: rgba(C.ice, 0.92),
  });
  drawText(ctx, SCENE.subtitle, M + 8, M + 34, {
    size: 8.5, weight: 400, tracking: 2.6, color: inkDim,
  });

  // Бегунок под заголовком.
  const barW = 168;
  ctx.fillStyle = rgba(C.cyan, 0.16);
  ctx.fillRect(M + 8, M + 44, barW, 2);
  const sweep = (t * 0.35) % 1;
  const sg = ctx.createLinearGradient(M + 8, 0, M + 8 + barW, 0);
  sg.addColorStop(Math.max(0, sweep - 0.16), rgba(C.cyan, 0));
  sg.addColorStop(clamp(sweep, 0, 1), rgba(C.ice, 0.95));
  sg.addColorStop(Math.min(1, sweep + 0.16), rgba(C.cyan, 0));
  ctx.fillStyle = sg;
  ctx.fillRect(M + 8, M + 44, barW, 2);

  // --- телеметрия справа сверху
  const now = new Date();
  const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const right = cssW - M - 8;
  const stats = [
    ['SYS TIME', clock],
    ['NODES', `${nodes.length}`],
    ['LINKS', `${edges.length}`],
    ['ZOOM', `${(cam.scale * 100).toFixed(0)}%`],
    ['FPS', `${fps.toFixed(0)}`],
  ];
  let sy = M + 14;
  for (const [k, v] of stats) {
    drawText(ctx, k, right - 74, sy, { size: 8, weight: 400, tracking: 1.6, align: 'right', color: inkDim });
    drawText(ctx, v, right, sy, { size: 9, weight: 600, tracking: 1.4, align: 'right', color: ink });
    sy += 13;
  }

  // --- бегущая строка снизу
  const tickY = cssH - M - 16;
  ctx.fillStyle = 'rgba(4,14,24,0.55)';
  ctx.fillRect(M + 1, tickY - 8, cssW - M * 2 - 2, 16);
  ctx.save();
  ctx.beginPath();
  ctx.rect(M + 10, tickY - 8, cssW - M * 2 - 20, 16);
  ctx.clip();
  const ticker = SCENE.ticker;
  const tw = textWidth(ticker, 8, 400, 2.2) + 120;
  let off = -((t * 46) % tw);
  for (let i = 0; i < 2; i++) {
    drawText(ctx, ticker, M + 14 + off + i * tw, tickY, {
      size: 8, weight: 400, tracking: 2.2, color: rgba(C.cyan, 0.5),
    });
  }
  ctx.restore();

  // Мигающая точка перед строкой.
  ctx.fillStyle = rgba(C.green, 0.4 + 0.6 * (Math.sin(t * 4) * 0.5 + 0.5));
  ctx.fillRect(M + 4, tickY - 2, 4, 4);

  // --- подсказки по управлению
  const help = 'CLICK ▸ OPEN / CLOSE · [ESC] BACK · DRAG ORBIT · WHEEL ZOOM · [F] FIT  [R] REBUILD  [G] GRID  [B] BLOOM  [L] LABELS  [SPACE] PAUSE';
  drawText(ctx, help, M + 8, cssH - M - 32, {
    size: 7.5, weight: 400, tracking: 1.5, color: rgba(C.cyan, 0.30),
  });

  drawBreadcrumbs(ctx, t);

  if (SCENE.minimap !== false) drawMinimap(ctx, t);
  if (SCENE.overlay) SCENE.overlay(ctx, t, { cssW, cssH, drillPath, hovered, selected });
  else drawInspector(ctx, t);
  drawReticle(ctx, t);
}

/**
 * Хлебные крошки текущего пути погружения. Показывают, на каком уровне
 * находишься и как глубоко — без них drill-down дезориентирует.
 */
function drawBreadcrumbs(ctx, t) {
  // В демонстрационном режиме крошки нужны только когда мы внутри объекта.
  if (SCENE.chrome === false && !drillPath.length && SCENE.hideEmptyCrumbs) return;
  const M = 22;
  let x = M + 8;
  const y = SCENE.chrome === false ? (SCENE.crumbY || 92) : M + 62;

  const step = (label, active, color) => {
    const size = active ? 9 : 8.5;
    const w = textWidth(label, size, active ? 600 : 400, 1.8);
    if (active) {
      ctx.fillStyle = rgba(color, 0.16);
      ctx.fillRect(x - 5, y - 8, w + 10, 16);
      ctx.strokeStyle = rgba(color, 0.55);
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 5.5, y - 8.5, w + 11, 17);
    }
    drawText(ctx, label, x, y, {
      size, weight: active ? 600 : 400, tracking: 1.8,
      color: rgba(active ? C.ice : C.cyan, active ? 0.95 : 0.45),
    });
    x += w + 10;
    return w;
  };

  step('TOP', drillPath.length === 0, C.cyan);
  for (let i = 0; i < drillPath.length; i++) {
    drawText(ctx, '▸', x, y, { size: 8, weight: 400, tracking: 0, color: rgba(C.cyan, 0.35) });
    x += 12;
    const n = drillPath[i];
    step(n.title, i === drillPath.length - 1, n.accent);
  }

  if (drillPath.length) {
    drawText(ctx, '[ESC] BACK', x + 8, y, {
      size: 7.5, weight: 400, tracking: 1.4,
      color: rgba(C.cyan, 0.30 + 0.18 * (Math.sin(t * 2.4) * 0.5 + 0.5)),
    });
  }
}

/** Мини-карта в правом нижнем углу с рамкой видимой области. */
function drawMinimap(ctx, t) {
  const w = 176, h = 116;
  const x = cssW - 22 - 8 - w;
  const y = cssH - 22 - 46 - h;

  const b = graphBounds(70);
  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const s = Math.min((w - 14) / bw, (h - 14) / bh);
  const ox = x + w / 2 - ((b.minX + b.maxX) / 2) * s;
  const oy = y + h / 2 - ((b.minY + b.maxY) / 2) * s;

  ctx.fillStyle = 'rgba(4,14,24,0.5)';
  chamferPath(ctx, x, y, w, h, 8, [true, false, true, false]);
  ctx.fill();
  ctx.strokeStyle = rgba(C.cyan, 0.35);
  ctx.lineWidth = 1;
  ctx.stroke();

  drawText(ctx, 'TOPOLOGY MAP', x + 8, y + 10, {
    size: 7, weight: 500, tracking: 1.8, color: rgba(C.cyan, 0.5),
  });

  // Рёбра.
  ctx.strokeStyle = rgba(C.cyan, 0.22);
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  for (const e of edges) {
    ctx.moveTo(ox + e.a.x * s, oy + e.a.y * s);
    ctx.lineTo(ox + e.b.x * s, oy + e.b.y * s);
  }
  ctx.stroke();

  // Узлы.
  for (const n of nodes) {
    const nx = ox + (n.x - n.w / 2) * s;
    const ny = oy + (n.y - n.h / 2) * s;
    const a = 0.35 + Math.max(n.hover, n.select) * 0.65;
    ctx.fillStyle = rgba(n.color, a * n.boot);
    ctx.fillRect(nx, ny, Math.max(2, n.w * s), Math.max(1.5, n.h * s));
  }

  // Видимая область.
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(cssW, cssH);
  ctx.strokeStyle = rgba(C.ice, 0.55);
  ctx.lineWidth = 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y + 1, w - 2, h - 2);
  ctx.clip();
  ctx.strokeRect(ox + tl.x * s, oy + tl.y * s, (br.x - tl.x) * s, (br.y - tl.y) * s);
  ctx.restore();
}

/** Панель детали выбранного узла — слева внизу. */
function drawInspector(ctx, t) {
  const n = selected;
  inspectorAlpha = approach(inspectorAlpha, n ? 1 : 0, 9, 1 / 60);
  if (inspectorAlpha < 0.01 || !lastSelected) return;

  const node = lastSelected;
  const w = 232;
  const rows = node.rows.length;
  const h = 62 + rows * 14;
  const x = 22 + 8;
  const y = cssH - 22 - 46 - h;
  const a = easeOutCubic(inspectorAlpha);

  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate((1 - a) * -18, 0);

  chamferPath(ctx, x, y, w, h, 10, [true, false, true, false]);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, rgba(node.color, 0.14));
  g.addColorStop(1, rgba(node.color, 0.04));
  ctx.fillStyle = 'rgba(4,14,24,0.62)';
  ctx.fill();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = rgba(node.color, 0.6);
  ctx.lineWidth = 1.1;
  ctx.stroke();

  ctx.strokeStyle = rgba(node.accent, 0.55);
  ctx.lineWidth = 1;
  cornerBrackets(ctx, x, y, w, h, 12, 4);

  drawText(ctx, node.title, x + 12, y + 16, {
    size: 11, weight: 600, tracking: 2.2, color: rgba(C.paper, 0.95),
  });
  drawText(ctx, node.tag, x + w - 12, y + 16, {
    size: 8, weight: 400, tracking: 1.2, align: 'right', color: rgba(node.color, 0.7),
  });

  ctx.beginPath();
  ctx.moveTo(x + 10, y + 26.5); ctx.lineTo(x + w - 10, y + 26.5);
  ctx.strokeStyle = rgba(node.color, 0.35);
  ctx.stroke();

  let ry = y + 40;
  for (const r of node.rows) {
    const label = r[0];
    const val = r[2] === 'bar' ? `${Math.round(clamp(node.load, 0, 1) * 100)}%` : String(r[1] || '');
    let vc = C.paper;
    if (r[2] === 'ok') vc = C.green;
    else if (r[2] === 'warn') vc = C.amber;
    else if (r[2] === 'bad') vc = C.red;
    const lw = drawText(ctx, label, x + 12, ry, {
      size: 8.5, weight: 400, tracking: 1.1, color: rgba(node.color, 0.62),
    });
    const vw = textWidth(val, 8.5, 600, 1.1);
    leaderDots(ctx, x + 12 + lw + 5, x + w - 12 - vw - 5, ry, 3.4, rgba(node.color, 0.3));
    drawText(ctx, val, x + w - 12, ry, {
      size: 8.5, weight: 600, tracking: 1.1, align: 'right', color: rgba(vc, 0.95),
    });
    ry += 14;
  }

  const deg = node.inEdges.length + node.outEdges.length;
  drawText(ctx, `LINKS ${deg}  ·  IN ${node.inEdges.length}  ·  OUT ${node.outEdges.length}`,
    x + 12, y + h - 12, { size: 7.5, weight: 400, tracking: 1.4, color: rgba(C.cyan, 0.45) });

  ctx.restore();
}

/** Прицельное перекрестие у курсора. */
function drawReticle(ctx, t) {
  if (!pointer.inside) return;
  const x = pointer.x, y = pointer.y;
  const a = hovered ? 0.75 : 0.32;
  const r = hovered ? 13 : 8;

  ctx.strokeStyle = rgba(C.cyan, a);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - r - 7, y); ctx.lineTo(x - 4, y);
  ctx.moveTo(x + 4, y); ctx.lineTo(x + r + 7, y);
  ctx.moveTo(x, y - r - 7); ctx.lineTo(x, y - 4);
  ctx.moveTo(x, y + 4); ctx.lineTo(x, y + r + 7);
  ctx.stroke();

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * 0.9);
  ctx.strokeStyle = rgba(C.cyan, a * 0.8);
  ctx.strokeRect(-r * 0.55, -r * 0.55, r * 1.1, r * 1.1);
  ctx.restore();

  const w = screenToWorld(x, y);
  drawText(ctx, `X ${w.x.toFixed(0)}  Y ${w.y.toFixed(0)}`, x + 16, y + 18, {
    size: 7, weight: 400, tracking: 1.1, color: rgba(C.cyan, 0.4),
  });
}

/* =============================================================================
 * 13. ПОСТОБРАБОТКА
 * ========================================================================== */

const FLAGS = { grid: true, bloom: true, post: true, labels: false, paused: false };

const grainTiles = [];

function buildGrainTiles() {
  grainTiles.length = 0;
  const S = 128;
  const rnd = mulberry32(31337);
  for (let k = 0; k < 4; k++) {
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const x = c.getContext('2d');
    const img = x.createImageData(S, S);
    const d = img.data;
    for (let i = 0; i < S * S; i++) {
      const v = rnd();
      const lum = v < 0.5 ? 0 : 255;
      d[i * 4] = lum;
      d[i * 4 + 1] = lum;
      d[i * 4 + 2] = lum;
      d[i * 4 + 3] = Math.floor(v * 46);
    }
    x.putImageData(img, 0, 0);
    grainTiles.push(out.createPattern(c, 'repeat'));
  }
}

function tintChannel(dst, src, color) {
  const x = dst.x;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
  x.fillStyle = '#000';
  x.fillRect(0, 0, dst.w, dst.h);
  x.drawImage(src.c, 0, 0, dst.w, dst.h);
  x.globalCompositeOperation = 'multiply';
  x.fillStyle = color;
  x.fillRect(0, 0, dst.w, dst.h);
  x.globalCompositeOperation = 'source-over';
}

/** Строит пирамиду блума из сцены. */
function buildBloom() {
  const levels = RT.levels;
  const l0 = levels[0];

  // Bright-pass: уменьшаем сцену вдвое, затем умножаем результат сам на себя.
  // Возведение яркости в квадрат гасит фон (0.05 -> 0.0025) и сохраняет свечение.
  // Полный кадр читаем ровно один раз — второй множитель берём уже с half.
  const half = RT.half;
  half.x.setTransform(1, 0, 0, 1, 0, 0);
  half.x.globalCompositeOperation = 'source-over';
  half.x.globalAlpha = 1;
  half.x.imageSmoothingEnabled = true;
  half.x.drawImage(RT.scene.c, 0, 0, half.w, half.h);

  l0.x.setTransform(1, 0, 0, 1, 0, 0);
  l0.x.globalCompositeOperation = 'source-over';
  l0.x.globalAlpha = 1;
  l0.x.imageSmoothingEnabled = true;
  l0.x.drawImage(half.c, 0, 0, l0.w, l0.h);
  l0.x.globalCompositeOperation = 'multiply';
  l0.x.drawImage(half.c, 0, 0, l0.w, l0.h);
  l0.x.globalCompositeOperation = 'source-over';

  // Downsample: каждый уровень вдвое меньше, билинейная фильтрация даёт размытие.
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1], b = levels[i];
    b.x.setTransform(1, 0, 0, 1, 0, 0);
    b.x.globalCompositeOperation = 'source-over';
    b.x.globalAlpha = 1;
    b.x.fillStyle = '#000';
    b.x.fillRect(0, 0, b.w, b.h);
    b.x.drawImage(a.c, 0, 0, b.w, b.h);
  }

  // Анаморфный горизонтальный блик — снимается с мелкого уровня, там он и
  // нужен: блик широкий и размытый, детализация ему только вредит.
  const st = RT.streak;
  const src = levels[3];
  st.x.setTransform(1, 0, 0, 1, 0, 0);
  st.x.globalCompositeOperation = 'source-over';
  st.x.globalAlpha = 1;
  st.x.fillStyle = '#000';
  st.x.fillRect(0, 0, st.w, st.h);
  st.x.globalCompositeOperation = 'lighter';
  for (let i = -3; i <= 3; i++) {
    st.x.globalAlpha = (1 - Math.abs(i) / 4) * 0.34;
    st.x.drawImage(src.c, i * 5, 0, st.w, st.h);
  }
  st.x.globalAlpha = 1;
  st.x.globalCompositeOperation = 'source-over';

  // Upsample с накоплением: снизу вверх собираем широкое мягкое гало.
  // Останавливаемся на четверти разрешения — дальше апскейлить незачем,
  // финальное растягивание на экран всё равно билинейное.
  for (let i = levels.length - 1; i > 1; i--) {
    const a = levels[i], b = levels[i - 1];
    b.x.globalCompositeOperation = 'lighter';
    b.x.globalAlpha = 0.66;
    b.x.drawImage(a.c, 0, 0, b.w, b.h);
    b.x.globalAlpha = 1;
    b.x.globalCompositeOperation = 'source-over';
  }

  // Резкую составляющую свечения подмешиваем с половинного уровня напрямую:
  // именно она даёт плотный ореол вокруг тонких линий.
  const l1 = levels[1];
  l1.x.globalCompositeOperation = 'lighter';
  l1.x.globalAlpha = 0.55;
  l1.x.drawImage(l0.c, 0, 0, l1.w, l1.h);
  l1.x.globalAlpha = 1;
  l1.x.globalCompositeOperation = 'source-over';
}

/** Рисует слой по центру приёмника с масштабом k — основа радиальной аберрации. */
function drawScaledCentered(ctx, rt, dw, dh, k, alpha) {
  const w = dw * k, h = dh * k;
  ctx.globalAlpha = alpha;
  ctx.drawImage(rt.c, (dw - w) / 2, (dh - h) / 2, w, h);
  ctx.globalAlpha = 1;
}

function composite(t) {
  const scene = RT.scene;

  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalCompositeOperation = 'source-over';
  out.globalAlpha = 1;
  out.imageSmoothingEnabled = true;
  out.drawImage(scene.c, 0, 0);

  if (!FLAGS.post) return;

  if (FLAGS.bloom) {
    // Пирамида уже построена в frame() — до того, как на сцену лёг текст.
    const bloomRT = RT.levels[1];                // здесь собрана пирамида
    const ab = 0.0016;                           // амплитуда хроматической аберрации

    tintChannel(RT.tint[0], bloomRT, '#ff2a2a');
    tintChannel(RT.tint[1], bloomRT, '#2aff5a');
    tintChannel(RT.tint[2], bloomRT, '#2a6aff');

    // Каналы сводим в один буфер половинного разрешения и лишь потом
    // растягиваем на экран: три полноэкранных масштабирования превращаются
    // в одно. Радиальный сдвиг от этого не страдает — он пропорционален.
    const ch = RT.chroma;
    ch.x.setTransform(1, 0, 0, 1, 0, 0);
    ch.x.globalCompositeOperation = 'source-over';
    ch.x.globalAlpha = 1;
    ch.x.fillStyle = '#000';
    ch.x.fillRect(0, 0, ch.w, ch.h);
    ch.x.globalCompositeOperation = 'lighter';
    drawScaledCentered(ch.x, RT.tint[0], ch.w, ch.h, 1 + ab, 1);
    drawScaledCentered(ch.x, RT.tint[1], ch.w, ch.h, 1, 1);
    drawScaledCentered(ch.x, RT.tint[2], ch.w, ch.h, 1 - ab, 1);
    // Анаморфный блик подмешиваем здесь же.
    ch.x.globalAlpha = 0.55;
    ch.x.drawImage(RT.streak.c, 0, 0, ch.w, ch.h);
    ch.x.globalAlpha = 1;
    ch.x.globalCompositeOperation = 'source-over';

    out.globalCompositeOperation = 'lighter';
    out.globalAlpha = 0.62;
    out.drawImage(ch.c, 0, 0, W, H);
    out.globalAlpha = 1;
    out.globalCompositeOperation = 'source-over';
  }

  // --- бегущая полоса развёртки
  const sweepY = ((t * 0.16) % 1.35) * H;
  const sg = out.createLinearGradient(0, sweepY - 90 * DPR, 0, sweepY + 90 * DPR);
  sg.addColorStop(0, 'rgba(120,220,255,0)');
  sg.addColorStop(0.5, 'rgba(120,220,255,0.035)');
  sg.addColorStop(1, 'rgba(120,220,255,0)');
  out.globalCompositeOperation = 'lighter';
  out.fillStyle = sg;
  out.fillRect(0, sweepY - 90 * DPR, W, 180 * DPR);
  out.globalCompositeOperation = 'source-over';

  // --- зерно
  if (grainTiles.length) {
    const tile = grainTiles[(frameCount >> 1) % grainTiles.length];
    out.globalCompositeOperation = 'lighter';
    out.globalAlpha = 0.03;
    out.fillStyle = tile;
    out.save();
    out.translate((frameCount * 7) % 128, (frameCount * 13) % 128);
    out.fillRect(-128, -128, W + 256, H + 256);
    out.restore();
    out.globalAlpha = 1;
    out.globalCompositeOperation = 'source-over';
  }

  // --- запечённый слой: скан-линии + виньетка одним проходом
  if (RT.overlay) {
    out.globalCompositeOperation = 'source-over';
    out.drawImage(RT.overlay.c, 0, 0);
  }
}

/* =============================================================================
 * 14. ВВОД
 * ========================================================================== */

const pointer = { x: 0, y: 0, inside: false, down: false, moved: false };
let dragNode = null;
let dragOffX = 0, dragOffY = 0;
let panning = false;
let panStartX = 0, panStartY = 0, panCamX = 0, panCamY = 0;

let hovered = null;
let selected = null;
let pointerConsumed = false;   // клик ушёл в модальный слой сцены
let lastSelected = null;
let inspectorAlpha = 0;

/** Ищет узел под точкой, спускаясь внутрь раскрытых контейнеров. */
function hitLevel(level, wx, wy) {
  // Сверху вниз по порядку отрисовки — последний нарисованный ловит первым.
  for (let i = level.nodes.length - 1; i >= 0; i--) {
    const n = level.nodes[i];
    if (n.boot < 0.3) continue;
    if (Math.abs(wx - n.x) > n.w / 2 || Math.abs(wy - n.y) > n.h / 2) continue;
    if (n.sub && n.expandT > 0.5) {
      const inner = hitLevel(n.sub, wx, wy);
      if (inner) return inner;
    }
    return n;
  }
  return null;
}

function nodeAt(sx, sy) {
  const w = screenToWorld(sx, sy);
  return hitLevel(root, w.x, w.y);
}

/* --- проваливание по уровням --------------------------------------------- */

const drillPath = [];        // цепочка раскрытых контейнеров, сверху вниз
let autoFrame = null;        // кадрирование, удерживаемое до конца анимации

/** Запускает голографическую сборку уровня заново. */
function bootLevel(level) {
  level.bootStart = time;
  for (const n of level.nodes) {
    n.boot = 0;
    n.expanded = false;
    n.expandT = 0;
    if (n.sub) { n.w = n.baseW; n.h = n.baseH; }
  }
  for (const e of level.edges) e.boot = 0;
  placeLevel(level, null, true);
  for (const e of level.edges) e.dirty = true;
}

/**
 * Наводит камеру на раскрытый контейнер. Поле вокруг оставляем щедрое: если
 * вписать контейнер впритык, соседние узлы уезжают за край и переключиться
 * на другую подсистему можно только через закрытие.
 */
function focusCamera(n) {
  const pad = 300;
  const ins = (SCENE && SCENE.viewInset) || {};
  const availW = Math.max(200, cssW - (ins.left || 0) - (ins.right || 0));
  const availH = Math.max(200, cssH - (ins.top || 0) - (ins.bottom || 0));
  const s = clamp(Math.min(availW / (n.openW + pad), availH / (n.openH + pad)), 0.2, 1.9);
  cam.tscale = s;
  cam.tx = n.x - ((ins.left || 0) - (ins.right || 0)) / 2 / s;
  cam.ty = n.y + (NEST.padTop - NEST.padBottom) / 2 - ((ins.top || 0) - (ins.bottom || 0)) / 2 / s;
}

/** Узел можно раскрыть, если внутри него есть уровень или досье агента. */
function canOpen(n) {
  return !!(n && (n.sub || n.leaf));
}

function drillInto(n) {
  if (SCENE.onDrill) setTimeout(() => SCENE.onDrill(drillPath.map((x) => x.src || x)), 0);
  if (!canOpen(n) || n.expanded) return false;

  // На одном уровне раскрыт только один контейнер — иначе схема превращается
  // в кашу и целевые позиции скачут.
  for (const s of n.level.nodes) if (s !== n && s.expanded) collapse(s);

  // Путь обрезаем до контейнера, внутри которого лежит n. Без этого переход
  // к соседнему узлу оставлял бы в цепочке уже свёрнутый контейнер, и Esc
  // возвращал бы не туда.
  const host = n.level.parent || null;
  const idx = host ? drillPath.indexOf(host) : -1;
  drillPath.length = idx + 1;

  n.expanded = true;
  if (n.sub) bootLevel(n.sub);
  drillPath.push(n);
  selected = null;
  autoFrame = { node: n };
  focusCamera(n);
  return true;
}

function collapse(n) {
  n.expanded = false;
  if (n.sub) for (const c of n.sub.nodes) if (c.expanded) collapse(c);
}

/** Сворачивает конкретный контейнер и поднимает навигацию на его уровень. */
function collapseNode(n) {
  if (!n || !n.expanded) return false;
  collapse(n);
  const idx = drillPath.indexOf(n);
  if (idx >= 0) drillPath.length = idx;
  selected = null;
  hovered = null;
  const parent = drillPath[drillPath.length - 1];
  autoFrame = parent ? { node: parent } : { fit: true };
  if (parent) focusCamera(parent);
  else fitView();
  return true;
}

/** Возврат на уровень выше. */
function drillOut() {
  return collapseNode(drillPath[drillPath.length - 1]);
}

function setCursor(cls) {
  view.className = cls || '';
}

on(view, 'pointerdown', (ev) => {
  // Сцена может держать поверх схемы модальный слой и забирать клики себе.
  if (SCENE.onPointer && SCENE.onPointer(ev.clientX, ev.clientY)) {
    pointerConsumed = true;
    return;
  }
  pointerConsumed = false;
  view.setPointerCapture(ev.pointerId);
  pointer.down = true;
  pointer.moved = false;
  // Точку нажатия запоминаем всегда — по ней отличаем клик от перетаскивания.
  panStartX = ev.clientX;
  panStartY = ev.clientY;

  const n = nodeAt(ev.clientX, ev.clientY);
  if (n) {
    dragNode = n;
    const w = screenToWorld(ev.clientX, ev.clientY);
    dragOffX = n.x - w.x;
    dragOffY = n.y - w.y;
    setCursor('grabbing');
  } else {
    panning = true;
    panCamX = cam.tx;
    panCamY = cam.ty;
    autoFrame = null;          // ручная панорама важнее автокадрирования
    setCursor('grabbing');
  }
});

on(view, 'pointermove', (ev) => {
  pointer.x = ev.clientX;
  pointer.y = ev.clientY;
  pointer.inside = true;

  if (pointer.down) {
    const dx = ev.clientX - panStartX, dy = ev.clientY - panStartY;
    if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
  }

  if (dragNode) {
    const w = screenToWorld(ev.clientX, ev.clientY);
    dragNode.x = w.x + dragOffX;
    dragNode.y = w.y + dragOffY;
    for (const e of edges) if (e.a === dragNode || e.b === dragNode) e.dirty = true;
    pointer.moved = true;
    return;
  }

  if (panning) {
    cam.tx = panCamX - (ev.clientX - panStartX) / cam.scale;
    cam.ty = panCamY - (ev.clientY - panStartY) / cam.scale;
    cam.x = cam.tx; cam.y = cam.ty;      // панорама без инерции — точнее ощущается
    return;
  }

  if (SCENE.onHover && SCENE.onHover(ev.clientX, ev.clientY)) {
    hovered = null;
    setCursor('pointing');
    return;
  }
  const n = nodeAt(ev.clientX, ev.clientY);
  hovered = n;
  setCursor(n ? 'pointing' : '');
});

const endPointer = (ev) => {
  if (pointerConsumed) { pointerConsumed = false; return; }
  if (pointer.down && !pointer.moved) {
    const n = nodeAt(ev.clientX, ev.clientY);
    if (n && n.expanded) {
      // Попали в сам раскрытый узел, а не в его содержимое — закрываем.
      collapseNode(n);
    } else if (canOpen(n)) {
      // У узла есть нижний слой — проваливаемся внутрь.
      drillInto(n);
    } else if (n) {
      selected = n === selected ? null : n;
      if (selected) lastSelected = selected;
      if (SCENE.onNodeSelect) SCENE.onNodeSelect(selected);
    } else if (selected) {
      selected = null;
    } else {
      // Клик по пустому фону — выход на уровень выше.
      drillOut();
    }
  }
  pointer.down = false;
  panning = false;
  dragNode = null;
  setCursor(hovered ? 'pointing' : '');
};

on(view, 'pointerup', endPointer);
on(view, 'pointercancel', () => {
  pointer.down = false; panning = false; dragNode = null; setCursor('');
});
on(view, 'pointerleave', () => { pointer.inside = false; hovered = null; });

on(view, 'wheel', (ev) => {
  ev.preventDefault();
  autoFrame = null;
  const k = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0022));
  const next = clamp(cam.tscale * k, 0.18, 3.2);

  // Зум к точке под курсором.
  const before = screenToWorld(ev.clientX, ev.clientY);
  cam.tscale = next;
  cam.scale = next;
  const after = screenToWorld(ev.clientX, ev.clientY);
  cam.tx += before.x - after.x;
  cam.ty += before.y - after.y;
  cam.x = cam.tx; cam.y = cam.ty;
}, { passive: false });

on(view, 'dblclick', () => fitView());

on(window, 'keydown', (ev) => {
  // This canvas shares the page with text fields and other views. A hotkey that
  // fires while someone is typing, or while the panel is not even on screen,
  // belongs to somebody else.
  const el = ev.target;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  if (!view.isConnected || !view.offsetParent) return;
  const k = ev.key.toLowerCase();
  if (SCENE.onKey && SCENE.onKey(k, ev)) return;          // сцена перехватила клавишу
  if (k === 'f') fitView();
  else if (k === 'r') startBoot();
  else if (k === 'g') FLAGS.grid = !FLAGS.grid;
  else if (k === 'b') FLAGS.bloom = !FLAGS.bloom;
  else if (k === 'p') FLAGS.post = !FLAGS.post;
  else if (k === 'l') FLAGS.labels = !FLAGS.labels;
  else if (k === 'escape' || k === 'backspace') {
    // Сначала снимаем выделение, затем поднимаемся на уровень выше.
    ev.preventDefault();
    if (selected) selected = null;
    else drillOut();
  }
  else if (k === 'enter') {
    const n = selected || hovered;
    if (n) drillInto(n);
  }
  else if (ev.code === 'Space') { ev.preventDefault(); FLAGS.paused = !FLAGS.paused; }
});

// A panel is resized by layout far more often than a window is: watch the box.
if (typeof ResizeObserver === 'function' && view.parentNode) {
  const ro = new ResizeObserver(() => { if (!stopped) { resize(); fitView(); } });
  ro.observe(view.parentNode);
  teardown.push(() => ro.disconnect());
} else {
  on(window, 'resize', () => { resize(); fitView(); });
}

/* =============================================================================
 * 15. ГЛАВНЫЙ ЦИКЛ
 * ========================================================================== */


let frameCount = 0;
let time = 0;

function startBoot() {
  drillPath.length = 0;
  selected = null;
  hovered = null;
  bootLevel(root);
  autoFrame = { fit: true };
  fitView();
}

/** Множество узлов и рёбер, связанных с активным — для режима фокуса. */
function updateFocus(dt) {
  const active = hovered || selected;
  const related = new Set();
  if (active) {
    related.add(active);
    for (const e of active.level.edges) {
      if (e.a === active) related.add(e.b);
      if (e.b === active) related.add(e.a);
    }
  }

  // Уровень, внутри которого сейчас находимся. Всё, что лежит выше по дереву,
  // приглушаем — иначе на глубине соседи верхних уровней спорят за внимание с
  // тем, что рассматриваешь. Сами контейнеры пути гасить нельзя: они служат
  // рамкой и показывают, откуда пришёл.
  const host = drillPath[drillPath.length - 1] || null;
  const activeLevel = host ? host.sub : root;
  const onPath = new Set(drillPath);

  for (const n of allNodes) {
    const isHover = n === hovered;
    const isSel = n === selected;
    n.hover = approach(n.hover, isHover ? 1 : 0, 12, dt);
    n.select = approach(n.select, isSel ? 1 : 0, 10, dt);

    // Затеняем только соседей по тому же уровню: контейнер, внутри которого
    // сидит активный узел, гасить нельзя — он его же и показывает.
    const sameLevel = active && n.level === active.level;
    let target = !active || !sameLevel ? 1 : (related.has(n) ? 1 : 0.26);
    if (n.level !== activeLevel && !onPath.has(n)) target = Math.min(target, 0.24);
    n.dim = approach(n.dim, target, 8, dt);
  }

  for (const e of allEdges) {
    const on = active && (e.a === active || e.b === active);
    const sameLevel = active && e.level === active.level;
    e.hover = approach(e.hover, on ? 1 : 0, 11, dt);
    let target = !active || !sameLevel ? 1 : (on ? 1 : 0.14);
    if (e.level !== activeLevel) target = Math.min(target, 0.12);
    e.dim = approach(e.dim, target, 8, dt);
  }
}

/**
 * Обновляет один уровень: голографическую сборку, раскрытие узлов и движение
 * к целевым позициям. Возвращает true, пока хоть что-то движется — по этому
 * признаку пересчитывается расстановка и геометрия рёбер.
 */
function updateLevel(level, dt) {
  let moving = false;
  const elapsed = time - (level.bootStart || 0);

  // Сборка узлов по расписанию уровня.
  for (const n of level.nodes) {
    const target = clamp((elapsed - n.bootDelay) / 1.05, 0, 1);
    if (target > n.boot) { n.boot = target; moving = true; }
  }
  // Связь прорастает только после того, как оба её узла достаточно собраны.
  for (const e of level.edges) {
    if (e.boot < 1 && e.a.boot > 0.55 && e.b.boot > 0.35) {
      e.boot = clamp(e.boot + dt * 1.35, 0, 1);
    }
  }

  // Раскрытие: размер узла едет от свёрнутого к контейнерному.
  for (const n of level.nodes) {
    const target = n.expanded ? 1 : 0;
    if (Math.abs(n.expandT - target) > 0.0015) {
      n.expandT = approach(n.expandT, target, 5.5, dt);
      moving = true;
    } else {
      n.expandT = target;
    }
    if (n.sub) {
      // Вложенный уровень живёт, пока контейнер хоть немного раскрыт.
      if (n.expandT > 0.002 && updateLevel(n.sub, dt)) moving = true;
      // Габариты контейнера берём из ТЕКУЩЕЙ раскладки его содержимого:
      // когда внутри раскрывается ещё один узел, подграф вырастает, и
      // контейнер обязан вырасти следом — иначе содержимое режется рамкой.
      n.openW = Math.max(n.baseW, n.sub.w + NEST.padX * 2);
      n.openH = n.sub.h + NEST.padTop + NEST.padBottom;
      const k = easeInOutCubic(n.expandT);
      n.w = lerp(n.baseW, n.openW, k);
      n.h = lerp(n.baseH, n.openH, k);
    } else if (n.leaf) {
      // Лист раскрывается не в подграф, а в карточку. Сцена может подобрать
      // её размер под объём содержимого — пустая нижняя треть выглядит плохо.
      const size = SCENE.detail.size ? SCENE.detail.size(n) : SCENE.detail;
      n.openW = Math.max(n.baseW, size.w);
      n.openH = Math.max(n.baseH, size.h);
      const k = easeInOutCubic(n.expandT);
      n.w = lerp(n.baseW, n.openW, k);
      n.h = lerp(n.baseH, n.openH, k);
    }
  }

  // Размеры изменились — пересчитываем цели, соседи разъезжаются.
  if (moving) placeLevel(level, null, false);

  for (const n of level.nodes) {
    const nx = approach(n.lx, n.ltx, 7, dt);
    const ny = approach(n.ly, n.lty, 7, dt);
    if (Math.abs(nx - n.lx) > 0.002 || Math.abs(ny - n.ly) > 0.002) moving = true;
    n.lx = nx; n.ly = ny;
  }

  if (moving) for (const e of level.edges) e.dirty = true;
  return moving;
}

/** Переводит локальные координаты уровня в мировые — сверху вниз по дереву. */
function syncAbsolute(level, ox, oy) {
  for (const n of level.nodes) {
    n.x = ox + n.lx;
    n.y = oy + n.ly;
    if (n.sub && n.expandT > 0.002) {
      // Содержимое контейнера смещено вниз: сверху остаётся его заголовок.
      syncAbsolute(n.sub, n.x, n.y + (NEST.padTop - NEST.padBottom) / 2);
    }
  }
}

function update(dt) {
  const moving = updateLevel(root, dt);
  syncAbsolute(root, 0, 0);

  // Пока схема раздвигается или схлопывается, габариты меняются каждый кадр,
  // поэтому кадрирование нужно пересчитывать до конца анимации — иначе камера
  // фиксируется на промежуточном, ещё раздутом состоянии.
  if (autoFrame) {
    if (autoFrame.fit) fitView();
    else if (autoFrame.node) focusCamera(autoFrame.node);
    if (!moving) autoFrame = null;
  }

  updateFocus(dt);

  // Камера: плавное приближение к целям. Кадр намеренно стоит неподвижно —
  // тряска проектора и сбои развёртки мешали читать схему.
  cam.scale = approach(cam.scale, cam.tscale, 9, dt);
  cam.x = approach(cam.x, cam.tx, 9, dt);
  cam.y = approach(cam.y, cam.ty, 9, dt);

  if (SCENE.tick) SCENE.tick(dt);

  // Перестройка геометрии рёбер после перетаскивания и раскрытия.
  for (const e of allEdges) if (e.dirty) rebuildEdge(e);

  // Сеть работает вся целиком, а не только видимая её часть: агенты внутри
  // закрытых групп тоже жгут токены и продвигают очередь.
  for (const n of allNodes) {
    if (n.leaf) SCENE.leaf.step(n.leaf, dt);
    else n.load = clamp(n.load + (Math.random() - 0.5) * dt * 0.06, 0.08, 0.97);
  }
  computeStats(root);
}

/** Сводка по поддереву: сколько агентов, сколько токенов сожжено, кто в работе. */
function computeStats(level) {
  let agents = 0, tokens = 0, active = 0;
  for (const n of level.nodes) {
    if (n.leaf) {
      n.stats = SCENE.leaf.stats(n.leaf);
    } else if (n.sub) {
      n.stats = computeStats(n.sub);
    } else {
      n.stats = { agents: 0, tokens: 0, active: 0 };
    }
    agents += n.stats.agents;
    tokens += n.stats.tokens;
    active += n.stats.active;
  }
  return { agents, tokens, active };
}

function renderScene(t, dt, fps) {
  const ctx = RT.scene.x;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  drawBackground(ctx, t);
  drawGrid(ctx, t);
  drawRings(ctx, t);
  drawDust(ctx, t);

  drawLevel(ctx, root, t, dt);
  drawOverlay(ctx, t, fps);
}

/**
 * Рисует один уровень схемы. Вложенные уровни попадают сюда рекурсивно из
 * drawNode — у раскрытого узла содержимым становится его подграф.
 */
function drawLevel(ctx, level, t, dt) {
  // Рёбра под панелями.
  for (const e of level.edges) drawEdge(ctx, e, t);
  for (const e of level.edges) drawPackets(ctx, e, t, dt);

  // Частицы сборки, затем сами панели.
  for (const n of level.nodes) drawNodeMotes(ctx, n, t);

  // Активный узел рисуется последним, чтобы быть поверх остальных.
  const active = hovered || selected;
  let deferred = null;
  for (const n of level.nodes) {
    if (n === active) { deferred = n; continue; }
    drawNode(ctx, n, t, dt);
  }
  if (deferred) drawNode(ctx, deferred, t, dt);
}

let lastTime = 0;
let fps = 60;
let bootHidden = false;

function frame(now) {
  if (stopped) return;
  // Whoever removed this canvas from the page is not obliged to have told us.
  if (!view.isConnected) { HUD_API.destroy(); return; }
  requestAnimationFrame(frame);
  // Tabs here are switched by hiding, not by removing. A panel nobody is looking
  // at still costs a bloom pyramid per frame, so keep the loop and skip the work.
  if (!view.offsetParent) { lastTime = 0; return; }

  const nowSec = now / 1000;
  let dt = lastTime ? nowSec - lastTime : 1 / 60;
  lastTime = nowSec;
  dt = Math.min(dt, 1 / 20);            // защита от «прыжка» после вкладки в фоне

  fps = lerp(fps, 1 / Math.max(dt, 1e-4), 0.08);

  if (!FLAGS.paused) {
    time += dt;
    update(dt);
  }

  // Порядок принципиален: сцена рисуется без текста, по ней считается bloom,
  // и только затем текст ложится сверху — так буквы не набирают ореол.
  renderScene(time, FLAGS.paused ? 0 : dt, fps);
  if (FLAGS.post && FLAGS.bloom) buildBloom();
  flushText(RT.scene.x);

  // Слой сцены поверх всего, включая уже уложенный текст узлов: панели HUD
  // и модальные экраны иначе оказываются под подписями схемы.
  if (SCENE.overlayTop) {
    const ctx = RT.scene.x;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const wasDeferred = deferText;
    deferText = false;
    SCENE.overlayTop(ctx, time, { cssW, cssH, dt, drillPath, hovered, selected });
    deferText = wasDeferred;
  }

  composite(time);

  frameCount++;

  if (!bootHidden && frameCount > 2) {
    bootHidden = true;
    const el = OPTS.bootEl || null;
    if (el) {
      el.classList.add('hidden');
      setTimeout(() => el.remove(), 600);
    }
  }
}

/* --- запуск --------------------------------------------------------------- */

// Утилиты, которыми сцена рисует свои карточки.
Object.assign(HUD_API, {
  C, KIND, rgba, mix, clamp, lerp, invLerp,
  allNodes, findNode: (id) => allNodes.find((n) => n.id === id),
  fit: () => { autoFrame = { fit: true }; fitView(); },
  focus: (n) => { autoFrame = { node: n }; focusCamera(n); },
  // Программное управление раскрытием — нужно демонстрационному режиссёру.
  open: (id) => { const n = allNodes.find((x) => x.id === id); return n ? drillInto(n) : false; },
  closeAll: () => { while (drillPath.length) drillOut(); },
  path: () => drillPath.slice(),
  camTo: (x, y, scale) => {
    autoFrame = null;
    cam.tx = x; cam.ty = y;
    if (scale) cam.tscale = clamp(scale, 0.15, 3);
  },
  cam,
  easeOutCubic, easeOutQuint, easeInOutCubic, approach,
  mulberry32, makeNoise1D, noise: noiseA,
  drawText, textWidth, drawGlow, chamferPath, cornerBrackets, leaderDots,
  TAU,
});

if (!SCENE_INPUT) throw new Error('HUD_MOUNT: no scene given.');
SCENE = typeof SCENE_INPUT === 'function' ? SCENE_INPUT(HUD_API) : SCENE_INPUT;
FLAGS.labels = !!SCENE.labels;
if (SCENE.kinds) Object.assign(KIND, SCENE.kinds);        // свои типы узлов сцены
if (SCENE.metric) Object.assign(METRIC, SCENE.metric);   // плотность раскладки сцены

buildGraph();
computeStats(root);
layoutLevel(root);
syncAbsolute(root, 0, 0);
for (const e of allEdges) rebuildEdge(e);
resize();
fitView(true);
startBoot();
requestAnimationFrame(frame);

Object.assign(HUD_API, {
  // The panel draws its own toolbar, so it needs the same switches the keyboard has.
  flags: FLAGS,
  back: () => drillOut(),
  // Functions, not getters: Object.assign copies the value a getter returns at
  // copy time, which froze this at zero and made it useless as a probe.
  frames: () => frameCount,
  running: () => !stopped,
  destroy() {
    if (stopped) return;
    stopped = true;
    while (teardown.length) { try { teardown.pop()(); } catch (e) {} }
    if (OPTS.onDestroy) { try { OPTS.onDestroy(); } catch (e) {} }
  },
  resize() { resize(); fitView(); },
});
return HUD_API;
};
