import type { Anchor, Annotation, Book, Chapter } from "./types";
import { flattenBook, type FlatChapter } from "./text/flatten";
import { createAnchor, makeId } from "./text/anchor";
import { anchorStillValid } from "./text/validate";
import { bookFromUnknown, BookParseError } from "./text/parseBook";

/** 节选文件格式标识。 */
export const EXCERPT_FORMAT = "reader-excerpt" as const;
/**
 * 节选书稿 id 必须携带的标记。节选以全新 id 独立保存，从格式上保证
 * 打开/编辑节选永远不会覆盖原书稿的存储。
 */
export const EXCERPT_ID_MARK = ":excerpt:";

export interface ExcerptRange {
  chapterId: string;
  start: number;
  end: number;
}

export interface ExcerptPackage {
  format: typeof EXCERPT_FORMAT;
  /** 原书稿 id（溯源信息；节选书稿 id 必须与之不同）。 */
  sourceBookId: string;
  book: Book;
  annotations: Annotation[];
}

export class ExcerptError extends Error {}

// ---------------------------------------------------------------------------
// 选区规范化：字素边界吸附、边缘空白裁剪、重叠/相邻合并
// ---------------------------------------------------------------------------

const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** 章节扁平文字的全部字素边界（升序，含 0 与 text.length）。 */
function graphemeBoundaries(text: string): number[] {
  const bounds = [0];
  for (const seg of segmenter.segment(text)) {
    bounds.push(seg.index + seg.segment.length);
  }
  return bounds;
}

/** 不超过 pos 的最大边界。 */
function snapDown(bounds: number[], pos: number): number {
  let lo = 0;
  let hi = bounds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bounds[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return bounds[lo];
}

/** 不小于 pos 的最小边界。 */
function snapUp(bounds: number[], pos: number): number {
  let lo = 0;
  let hi = bounds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid] >= pos) hi = mid;
    else lo = mid + 1;
  }
  return bounds[lo];
}

const isWs = (ch: string | undefined): boolean =>
  ch !== undefined && /\s/u.test(ch);

interface MergedRange {
  start: number;
  end: number;
}

/**
 * 规范化某章的原始选区：
 * 1. 丢弃非法区间，其余夹取到章节文字范围内；
 * 2. 端点向外吸附到完整字素边界（绝不切断字素簇）；
 * 3. 裁掉两端空白（含段界定符）——这样切片重新规范化后坐标逐字不变；
 * 4. 合并重叠或首尾相接的区间；不连续选区保持分离。
 */
export function normalizeRanges(
  chapter: FlatChapter,
  ranges: ExcerptRange[],
): MergedRange[] {
  const text = chapter.text;
  const bounds = graphemeBoundaries(text);
  const cleaned: MergedRange[] = [];
  for (const r of ranges) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) continue;
    const clamp = (v: number) => Math.max(0, Math.min(v, text.length));
    let start = snapDown(bounds, clamp(Math.floor(Math.min(r.start, r.end))));
    let end = snapUp(bounds, clamp(Math.ceil(Math.max(r.start, r.end))));
    while (start < end && isWs(text[start])) start++;
    while (end > start && isWs(text[end - 1])) end--;
    if (end > start) cleaned.push({ start, end });
  }
  cleaned.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MergedRange[] = [];
  for (const r of cleaned) {
    const last = merged[merged.length - 1];
    // 重叠或相接（next.start <= last.end）才合并；仅隔段界定符/空白的保持分离。
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 导出节选
// ---------------------------------------------------------------------------

const compactString = (s: string): string => s.replace(/\n/g, "");

interface Fragment {
  /** 原章节的扁平数据。 */
  source: FlatChapter;
  /** 合并后的选区（原章节扁平坐标）。 */
  range: MergedRange;
  /** 片段在节选书稿中的章节 id。 */
  fragId: string;
}

/**
 * 构建独立节选文件：
 * - 每个合并后的选区成为一个片段章节，不连续选区保持分离，不夹带未选正文；
 * - 切片按段界定符拆回段落，重新扁平化后坐标与切片逐字一致；
 * - 仅导出与选区相交、且坐标证据仍然吻合的已定位批注；待裁决/失联证据
 *   与旧锚点一律不进入分享文件；
 * - 跨边界批注按各片段可见部分截断，锚点在片段坐标系中重建，两侧上下文
 *   以片段可见文字为界（不会泄漏选区之外的原文）；
 * - 节选书稿使用带节选标记的全新 id，保存与编辑独立于原书稿。
 */
export function buildExcerpt(
  book: Book,
  annotations: Annotation[],
  ranges: ExcerptRange[],
): ExcerptPackage {
  const flat = flattenBook(book);
  const byChapter = new Map<string, ExcerptRange[]>();
  for (const r of ranges) {
    if (!flat.chapterById.has(r.chapterId)) continue;
    const list = byChapter.get(r.chapterId) ?? [];
    list.push(r);
    byChapter.set(r.chapterId, list);
  }

  // 按原书章节顺序展开片段章节。
  const chapters: Chapter[] = [];
  const fragments: Fragment[] = [];
  for (const ch of flat.chapters) {
    const merged = normalizeRanges(ch, byChapter.get(ch.id) ?? []);
    merged.forEach((range, i) => {
      const fragId = `${ch.id}#frag${i + 1}`;
      const slice = ch.text.slice(range.start, range.end);
      chapters.push({
        id: fragId,
        title:
          merged.length > 1
            ? `${ch.title}（节选 ${i + 1}/${merged.length}）`
            : `${ch.title}（节选）`,
        // 切片不含首尾空白，段界定符拆回段落后重新规范化是恒等变换。
        paragraphs: slice.split("\n").map((text) => ({ text })),
      });
      fragments.push({ source: ch, range, fragId });
    });
  }
  if (chapters.length === 0) throw new ExcerptError("没有可导出的有效选区");

  const excerptBook: Book = {
    id: `${book.id}${EXCERPT_ID_MARK}${makeId()}`,
    title: `${book.title}（节选）`,
    chapters,
  };
  if (book.version) excerptBook.version = book.version;
  const excerptFlat = flattenBook(excerptBook);
  const fragIndexById = new Map(excerptFlat.chapters.map((c, i) => [c.id, i]));

  // 只保留与选区相交的已定位批注，按片段截断并重建锚点。
  const usedIds = new Set<string>();
  const clipped: Annotation[] = [];
  for (const a of annotations) {
    if (a.status !== "anchored") continue; // 待裁决/失联证据不进入分享文件
    const src = flat.chapterById.get(a.anchor.chapterId);
    // 旧锚点防御：坐标处文字与证据不符时不导出，绝不猜测落点。
    if (!src || !anchorStillValid(a, flat)) continue;
    let copy = 0;
    for (const frag of fragments) {
      if (frag.source.id !== src.id) continue;
      const s = Math.max(a.anchor.start, frag.range.start);
      const e = Math.min(a.anchor.end, frag.range.end);
      if (e <= s) continue;
      const fragCh = excerptFlat.chapterById.get(frag.fragId)!;
      // 在片段坐标系中重建锚点：选中文字即片段内可见部分，
      // 两侧上下文被片段边界截断，不含任何未分享原文。
      const anchor = createAnchor(
        fragCh,
        s - frag.range.start,
        e - frag.range.start,
      );
      let id = copy === 0 ? a.id : `${a.id}~part${copy + 1}`;
      while (usedIds.has(id)) id = `${id}x`;
      usedIds.add(id);
      copy++;
      clipped.push({
        id,
        note: a.note,
        status: "anchored",
        anchor,
        createdAt: a.createdAt,
      });
    }
  }
  clipped.sort((x, y) => {
    const order =
      fragIndexById.get(x.anchor.chapterId)! -
        fragIndexById.get(y.anchor.chapterId)! ||
      x.anchor.start - y.anchor.start;
    return order !== 0 ? order : x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });

  return {
    format: EXCERPT_FORMAT,
    sourceBookId: book.id,
    book: excerptBook,
    annotations: clipped,
  };
}

// ---------------------------------------------------------------------------
// 打开节选：严格校验，任何不符都整体拒绝（不会留下部分更新）
// ---------------------------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * 校验节选文件。除结构外还逐条核对批注：坐标必须落在节选正文内、
 * 锚点文字与两侧上下文必须与可见正文完全一致（超出可见范围的「证据」
 * 一律视为非法文件）。全部通过才返回规范化后的包，否则抛出 ExcerptError。
 */
export function validateExcerpt(raw: unknown): ExcerptPackage {
  function fail(msg: string): never {
    throw new ExcerptError(`非法节选文件：${msg}`);
  }
  const obj = asObject(raw) ?? fail("顶层必须是对象");
  if (obj.format !== EXCERPT_FORMAT) fail(`format 必须是 ${EXCERPT_FORMAT}`);
  const sourceBookId = asString(obj.sourceBookId);
  if (!sourceBookId) fail("缺少字符串字段 sourceBookId");

  let book: Book;
  try {
    book = bookFromUnknown(obj.book);
  } catch (e) {
    fail(e instanceof BookParseError ? `书稿无效（${e.message}）` : "书稿无效");
  }
  if (!book.id.includes(EXCERPT_ID_MARK))
    fail("节选书稿 id 缺少节选标记（不得沿用原书稿 id）");
  if (book.id === sourceBookId) fail("节选书稿 id 不得与原书稿相同");

  const flat = flattenBook(book);
  if (!Array.isArray(obj.annotations)) fail("annotations 必须是数组");
  const seen = new Set<string>();
  const annotations: Annotation[] = obj.annotations.map((av, i) => {
    const where = `第 ${i + 1} 条批注`;
    const a = asObject(av) ?? fail(`${where}不是对象`);
    const id = asString(a.id);
    if (!id) fail(`${where}缺少字符串字段 id`);
    if (seen.has(id)) fail(`批注 id 重复：${id}`);
    seen.add(id);
    if (a.status !== "anchored")
      fail(`${where}状态必须是 anchored（节选不含待裁决/失联证据）`);
    if (a.candidates !== undefined) fail(`${where}不得携带候选证据`);
    const note = asString(a.note);
    if (note === null) fail(`${where}缺少字符串字段 note`);
    const createdAt = a.createdAt;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt))
      fail(`${where}createdAt 必须是有限数字`);
    const rawAnchor = asObject(a.anchor) ?? fail(`${where}缺少锚点对象`);
    const chapterId = asString(rawAnchor.chapterId);
    if (!chapterId) fail(`${where}锚点缺少章节 id`);
    const ch = flat.chapterById.get(chapterId);
    if (!ch) fail(`${where}指向不存在的章节「${chapterId}」`);
    const { start, end } = rawAnchor;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 0 ||
      (end as number) <= (start as number) ||
      (end as number) > ch.text.length
    )
      fail(`${where}锚点坐标越界`);
    if (
      typeof rawAnchor.text !== "string" ||
      typeof rawAnchor.prefix !== "string" ||
      typeof rawAnchor.suffix !== "string"
    )
      fail(`${where}锚点文字与上下文必须是字符串`);

    // 用节选正文重建锚点：文字与两侧上下文必须正好等于可见部分。
    const expected: Anchor = createAnchor(ch, start as number, end as number);
    if (compactString(rawAnchor.text as string) !== compactString(expected.text))
      fail(`${where}锚点文字与坐标处正文不符`);
    if (rawAnchor.prefix !== expected.prefix || rawAnchor.suffix !== expected.suffix)
      fail(`${where}锚点上下文与可见正文不符`);
    return { id, note, status: "anchored", anchor: expected, createdAt };
  });

  return { format: EXCERPT_FORMAT, sourceBookId, book, annotations };
}
