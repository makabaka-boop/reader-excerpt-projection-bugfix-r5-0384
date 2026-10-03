import type { Annotation, Book, Chapter } from "./types";
import { flattenBook, type FlatChapter } from "./text/flatten";
import { createAnchor } from "./text/anchor";
import { anchorStillValid } from "./text/validate";
import { parseBook, BookParseError } from "./text/parseBook";

/** 分享选区：页面规范化章节文字中的 UTF-16 区间（端点须在完整字素边界）。 */
export interface ExcerptRange {
  chapterId: string;
  start: number;
  end: number;
}

export interface ExcerptPackage {
  format: "reader-excerpt";
  /** 节选格式版本。 */
  version: 1;
  /** 来源书稿身份（仅展示用，节选正文不依赖它）。 */
  source: { id: string; title: string; version?: string };
  exportedAt: string;
  /** 独立书稿：拥有自己的 id，与原书稿的存储互不影响。 */
  book: Book;
  /** 仅包含与选区相交的、已定位且坐标有效的批注（锚点按节选文字重建）。 */
  annotations: Annotation[];
}

export class ExcerptError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const graphemeSegmenter = new Intl.Segmenter("zh", {
  granularity: "grapheme",
});

/** 收集字素簇边界（含 0 与 text.length）。 */
function graphemeBoundaries(text: string): Set<number> {
  const set = new Set<number>([0, text.length]);
  for (const seg of graphemeSegmenter.segment(text)) {
    set.add(seg.index);
    set.add(seg.index + seg.segment.length);
  }
  return set;
}

/**
 * 清洗单个选区：
 * - 整数化并夹取到章节文字范围内；
 * - 端点离开段界定符 '\n'（它不属于任何段落正文）；
 * - start 向上吸附、end 向下吸附到最近的完整字素边界（绝不扩大选区）。
 * 返回 null 表示该选区无法使用（旧锚点/失联坐标等），调用方应丢弃。
 */
function sanitizeRange(
  ch: FlatChapter,
  range: ExcerptRange,
): { start: number; end: number } | null {
  if (!isFiniteNumber(range.start) || !isFiniteNumber(range.end)) return null;
  let start = Math.trunc(range.start);
  let end = Math.trunc(range.end);
  start = Math.max(0, Math.min(start, ch.text.length));
  end = Math.max(0, Math.min(end, ch.text.length));
  if (end <= start) return null;

  const boundaries = graphemeBoundaries(ch.text);
  // 先离开段界定符，再吸附字素边界（'\n' 自身也是边界，顺序无副作用）。
  while (start < end && ch.text[start] === "\n") start++;
  while (end > start && ch.text[end - 1] === "\n") end--;
  while (start < end && !boundaries.has(start)) start++;
  while (end > start && !boundaries.has(end)) end--;
  // 吸附可能再次落到 '\n' 上（极端外部位移），再排一次。
  while (start < end && ch.text[start] === "\n") start++;
  while (end > start && ch.text[end - 1] === "\n") end--;
  return end > start ? { start, end } : null;
}

/** 同章选区按起点排序后合并重叠或相邻（端点相接）的区间。 */
function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** 节选中的一个正文片段：源章节扁平文字的 [srcStart, srcEnd)。 */
interface Piece {
  srcStart: number;
  srcEnd: number;
  text: string;
}

interface ChapterPlan {
  source: FlatChapter;
  merged: Array<{ start: number; end: number }>;
  pieces: Piece[];
  excerptChapter: Chapter;
}

/**
 * 按合并后的选区把章节切成片段。每个片段按源段落边界再次切分：
 * 节选里一个片段段落对应源段落中的一段规范化文字，因此重新扁平化时
 * 规范化是幂等的（受控 NFKC 幂等；片段首尾不保留折叠空格），坐标不漂移。
 */
function planChapter(
  ch: FlatChapter,
  rawRanges: ExcerptRange[],
): ChapterPlan | null {
  const clean = rawRanges
    .map((r) => sanitizeRange(ch, r))
    .filter((r): r is { start: number; end: number } => r !== null);
  if (clean.length === 0) return null;
  const merged = mergeRanges(clean);

  const pieces: Piece[] = [];
  const ps = ch.paragraphs;
  for (const r of merged) {
    // 找起点所在段落（start 经清洗不在段界定符上）。
    let lo = 0;
    let hi = ps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ps[mid].start <= r.start) lo = mid;
      else hi = mid - 1;
    }
    for (let i = lo; i < ps.length && ps[i].start < r.end; i++) {
      const p = ps[i];
      const ls0 = Math.max(r.start, p.start) - p.start;
      const le0 = Math.min(r.end, p.textEnd) - p.start;
      if (le0 <= ls0) continue;
      let ls = ls0;
      let le = le0;
      // 规范化文字中不存在连续空格；首尾空格在再次规范化时会被裁掉，
      // 这里同步收紧边界，保证节选文字重新规范化后逐字不变。
      while (ls < le && p.norm.text[ls] === " ") ls++;
      while (le > ls && p.norm.text[le - 1] === " ") le--;
      if (le <= ls) continue;
      pieces.push({
        srcStart: p.start + ls,
        srcEnd: p.start + le,
        text: p.norm.text.slice(ls, le),
      });
    }
  }
  if (pieces.length === 0) return null;

  const excerptChapter: Chapter = {
    id: ch.id, // 保留章节身份，批注 chapterId 与重锚逻辑无需特殊处理
    title: ch.title,
    paragraphs: pieces.map((p) => ({ text: p.text })),
  };
  return { source: ch, merged, pieces, excerptChapter };
}

/** 在有序片段中把源扁平偏移换算为节选扁平偏移（pos 必须落在某片段内）。 */
function mapSourceOffset(pieces: Piece[], exStarts: number[], pos: number): number {
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pieces[mid].srcStart <= pos) lo = mid;
    else hi = mid - 1;
  }
  const p = pieces[lo];
  const clamped = Math.max(p.srcStart, Math.min(pos, p.srcEnd));
  return exStarts[lo] + (clamped - p.srcStart);
}

/** FNV-1a 32 位：由来源身份与规范化选区生成稳定的节选书稿 id。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

/**
 * 构造节选分享文件。
 *
 * 安全保证：
 * - 正文只包含选区并集覆盖的文字；不连续选区保持为彼此分离的片段段落，
 *   选区之间（含跨段）的未选正文绝不进入文件；
 * - 仅导出「已定位、当前坐标仍有效、与选区相交」的批注；待裁决/失联、
 *   旧锚点、他章或不相交的批注一律排除，证据不泄漏；
 * - 相交批注按节选可见文字裁剪并以节选坐标重建锚点（同一批注即使跨越
 *   多个片段也只出现一次），位置 / 身份 / text·prefix·suffix 与节选一致；
 * - 无效选区（他章、越界、塌缩、字素中间、仅段界/空白）被丢弃；
 *   没有任何可用选区或片段时抛出 ExcerptError，不产生半成品文件。
 */
export function buildExcerpt(
  book: Book,
  annotations: Annotation[],
  ranges: ExcerptRange[],
): ExcerptPackage {
  const flat = flattenBook(book);
  const plans: ChapterPlan[] = [];
  for (const ch of flat.chapters) {
    const inChapter = ranges.filter((r) => r.chapterId === ch.id);
    if (inChapter.length === 0) continue;
    const plan = planChapter(ch, inChapter);
    if (plan) plans.push(plan);
  }
  if (plans.length === 0)
    throw new ExcerptError("没有有效的分享选区：至少需要一处正文中的非空选区");

  const excerptBook: Book = {
    id: `excerpt:${book.id}:${fnv1a(
      JSON.stringify({
        s: book.id,
        v: book.version ?? null,
        r: plans.map((p) => [
          p.source.id,
          ...p.merged.map((m) => [m.start, m.end]),
        ]),
      }),
    )}`,
    title: `${book.title}（节选）`,
    version: "excerpt-1",
    chapters: plans.map((p) => p.excerptChapter),
  };
  const exFlat = flattenBook(excerptBook);

  // 片段 1:1 对应节选段落：重新规范化后的文字必须与切出的片段逐字相同，
  // 否则说明片段边界没处理好（会导致批注坐标漂移）——直接报错，不出半成品。
  plans.forEach((plan, chapterIdx) => {
    const exParas = exFlat.chapters[chapterIdx].paragraphs;
    if (exParas.length !== plan.pieces.length)
      throw new ExcerptError("节选片段结构不一致（内部错误）");
    plan.pieces.forEach((p, i) => {
      if (exParas[i].norm.text !== p.text)
        throw new ExcerptError("节选片段经重新规范化后发生变化（内部错误）");
    });
  });

  const included: Annotation[] = [];
  const seenIds = new Set<string>();
  plans.forEach((plan, chapterIdx) => {
    const exCh = exFlat.chapters[chapterIdx];
    // 片段按顺序 1:1 对应节选段落，记录各自在节选扁平文字中的起点。
    const exStarts = exCh.paragraphs.map((p) => p.start);
    for (const a of annotations) {
      if (seenIds.has(a.id)) continue;
      // 只导出已定位且与当前正文吻合的批注；待裁决/失联/旧锚点一律排除。
      if (a.status !== "anchored" || !anchorStillValid(a, flat)) continue;
      if (a.anchor.chapterId !== plan.source.id) continue;
      const hits = plan.pieces.filter(
        (p) => p.srcEnd > a.anchor.start && p.srcStart < a.anchor.end,
      );
      if (hits.length === 0) continue;
      const first = hits[0];
      const last = hits[hits.length - 1];
      const sSrc = Math.max(a.anchor.start, first.srcStart);
      const eSrc = Math.min(a.anchor.end, last.srcEnd);
      if (eSrc <= sSrc) continue;
      const start = mapSourceOffset(plan.pieces, exStarts, sSrc);
      const end = mapSourceOffset(plan.pieces, exStarts, eSrc);
      if (end <= start) continue;
      // 以节选文字重建锚点：text/prefix/suffix 只可能含已分享文字，
      // 原书完整上下文证据不会被带入。
      included.push({
        id: a.id,
        note: a.note,
        status: "anchored",
        anchor: createAnchor(exCh, start, end),
        createdAt: a.createdAt,
      });
      seenIds.add(a.id);
    }
  });

  const order = new Map(plans.map((p, i) => [p.source.id, i]));
  included.sort((x, y) => {
    const cx = order.get(x.anchor.chapterId) ?? 0;
    const cy = order.get(y.anchor.chapterId) ?? 0;
    return cx !== cy ? cx - cy : x.anchor.start - y.anchor.start;
  });

  return structuredClone({
    format: "reader-excerpt" as const,
    version: 1 as const,
    source: {
      id: book.id,
      title: book.title,
      ...(book.version !== undefined ? { version: book.version } : {}),
    },
    exportedAt: new Date().toISOString(),
    book: excerptBook,
    annotations: included,
  });
}

// ---------------------------------------------------------------------------
// 打开分享文件：严格校验。任何问题都抛 ExcerptError，且必须在校验全部通过后
// 才允许调用方落库 / 改状态——非法文件不能留下部分更新。
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new ExcerptError(message);
}

/**
 * 校验并净化外部传入的分享文件。
 *
 * 通过校验的文件满足：格式/版本正确；book 本身是合法书稿；批注全部是结构
 * 完整、id 唯一、章节存在、坐标在界内且与节选文字逐字一致的「已定位」批注，
 * 锚点 text/prefix/suffix 必须与按节选坐标重建的结果完全一致——从而杜绝
 * 夹带证据、旧锚点、重复批注或位置与正文不符的文件被打开。
 */
export function validateExcerpt(input: unknown): ExcerptPackage {
  if (!isObject(input)) fail("分享文件必须是 JSON 对象");
  if (input.format !== "reader-excerpt")
    fail("不是有效的节选分享文件（format 不符）");
  if (input.version !== 1) fail("不支持的节选格式版本");

  let book: Book;
  try {
    // 复用书稿的严格解析，保证节选 book 自身结构合法（章节 id 唯一等）。
    book = parseBook(JSON.stringify(input.book));
  } catch (e) {
    fail(
      e instanceof BookParseError
        ? `分享文件中的书稿不合法：${e.message}`
        : "分享文件中的书稿不合法",
    );
  }
  const flat = flattenBook(book);

  if (!isObject(input.source) || !isString(input.source.id))
    fail("分享文件缺少来源信息 source.id");
  const source = {
    id: input.source.id,
    title: isString(input.source.title) ? input.source.title : input.source.id,
    ...(isString(input.source.version)
      ? { version: input.source.version }
      : {}),
  };
  const exportedAt = isString(input.exportedAt) ? input.exportedAt : "";

  if (!Array.isArray(input.annotations)) fail("annotations 必须是数组");
  const seen = new Set<string>();
  const annotations: Annotation[] = input.annotations.map((raw, i) => {
    const where = `第 ${i + 1} 条批注`;
    if (!isObject(raw)) fail(`${where}不是对象`);
    if (!isString(raw.id) || raw.id.length === 0)
      fail(`${where}缺少字符串 id`);
    if (seen.has(raw.id)) fail(`批注 id 重复：${raw.id}`);
    if (!isString(raw.note)) fail(`${where}的 note 必须是字符串`);
    if (!isFiniteNumber(raw.createdAt)) fail(`${where}的 createdAt 非法`);
    if (raw.status !== "anchored")
      fail(`${where}不是已定位状态，节选文件不得携带待裁决/失联证据`);
    if (raw.candidates !== undefined)
      fail(`${where}不得携带裁决候选证据`);

    const an = raw.anchor;
    if (!isObject(an)) fail(`${where}缺少锚点`);
    if (!isString(an.chapterId) || !isString(an.text))
      fail(`${where}锚点字段不完整`);
    if (!isString(an.prefix) || !isString(an.suffix))
      fail(`${where}锚点上下文字段不完整`);
    if (!isFiniteNumber(an.start) || !isFiniteNumber(an.end))
      fail(`${where}锚点坐标非法`);

    const ch = flat.chapterById.get(an.chapterId);
    if (!ch) fail(`${where}引用了节选里不存在的章节：${an.chapterId}`);
    const start = Math.trunc(an.start);
    const end = Math.trunc(an.end);
    if (start < 0 || end <= start || end > ch.text.length)
      fail(`${where}坐标越界或塌缩`);
    if (!Number.isInteger(an.start) || !Number.isInteger(an.end))
      fail(`${where}坐标必须是整数`);
    if (ch.text[start] === "\n" || ch.text[end - 1] === "\n")
      fail(`${where}端点落在段界定符上`);

    const expected = createAnchor(ch, start, end);
    if (an.text !== expected.text)
      fail(`${where}锚点文字与节选正文不一致（文件可能已损坏或来自旧版本）`);
    if (an.prefix !== expected.prefix || an.suffix !== expected.suffix)
      fail(`${where}锚点上下文与节选正文不一致（疑似夹带未分享证据）`);

    seen.add(raw.id);
    return {
      id: raw.id,
      note: raw.note,
      status: "anchored" as const,
      anchor: {
        chapterId: an.chapterId,
        start,
        end,
        text: expected.text,
        prefix: expected.prefix,
        suffix: expected.suffix,
      },
      createdAt: raw.createdAt,
    };
  });

  return {
    format: "reader-excerpt",
    version: 1,
    source,
    exportedAt,
    book,
    annotations,
  };
}
