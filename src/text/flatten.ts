import type { Book, Chapter, Paragraph } from "../types";
import { normalizeText, type Normalized } from "./normalize";

/** 单段：原文与规范化结果。 */
export interface FlatParagraph {
  index: number;
  /** 段落 ID（未提供时退化为序号）。 */
  id: string;
  raw: string;
  norm: Normalized;
  /** 该段在章节扁平串中的起点（含尾接空格）。 */
  start: number;
  /** 该段文字范围 [start, textEnd)，不含尾接空格。 */
  textEnd: number;
  /** 下一段起点；末段为整串长度。 */
  end: number;
}

export interface FlatChapter {
  id: string;
  title: string;
  /**
   * 扁平文字：规范化段落以 '\n' 分隔。这里的 '\n' 只是段间定界符，
   * 不属于任何段落；锚点永远不会覆盖它（段尾已裁掉）。
   */
  text: string;
  paragraphs: FlatParagraph[];
}

export interface FlatBook {
  id: string;
  title: string;
  version?: string;
  chapters: FlatChapter[];
  chapterById: Map<string, FlatChapter>;
}

export function flattenChapter(chapter: Chapter): FlatChapter {
  const paragraphs: FlatParagraph[] = [];
  const parts: string[] = [];
  let cursor = 0;
  chapter.paragraphs.forEach((p: Paragraph, index) => {
    const norm = normalizeText(p.text);
    const start = cursor;
    parts.push(norm.text);
    cursor += norm.text.length;
    const textEnd = cursor;
    const isLast = index === chapter.paragraphs.length - 1;
    if (!isLast) {
      parts.push("\n");
      cursor += 1;
    }
    paragraphs.push({
      index,
      id: p.id ?? `p${index}`,
      raw: p.text,
      norm,
      start,
      textEnd,
      end: cursor, // 初值；最后一个条目之后再修正
    });
  });
  for (let i = 0; i < paragraphs.length - 1; i++) {
    paragraphs[i].end = paragraphs[i + 1].start;
  }
  return {
    id: chapter.id,
    title: chapter.title,
    text: parts.join(""),
    paragraphs,
  };
}

export function flattenBook(book: Book): FlatBook {
  const chapters = book.chapters.map(flattenChapter);
  const chapterById = new Map(chapters.map((c) => [c.id, c]));
  return {
    id: book.id,
    title: book.title,
    version: book.version,
    chapters,
    chapterById,
  };
}

// ---------------------------------------------------------------------------
// DOM 选区坐标 <-> 扁平偏移
// ---------------------------------------------------------------------------

/** 落在某个文本节点中的位置（el 为段落渲染元素，offset 为其 textContent 内偏移）。 */
export interface TextPoint {
  paragraph: FlatParagraph;
  /** 规范化段落内偏移（0..text.length）。 */
  offset: number;
}

/** 找到包含扁平偏移 pos 的段落，并换算为段内偏移。越界时吸附到最近端点。 */
export function pointAt(chapter: FlatChapter, pos: number): TextPoint {
  const ps = chapter.paragraphs;
  let lo = 0;
  let hi = ps.length - 1;
  // 跳过空段时仍要给出稳定结果：找 start <= pos 的最后一段。
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ps[mid].start <= pos) lo = mid;
    else hi = mid - 1;
  }
  const paragraph = ps[lo];
  const offset = Math.max(
    0,
    Math.min(pos - paragraph.start, paragraph.norm.text.length),
  );
  return { paragraph, offset };
}

/** 段内规范化偏移 -> 扁平偏移。 */
export function flatOffset(
  p: FlatParagraph,
  offsetInParagraph: number,
): number {
  return p.start + Math.max(0, Math.min(offsetInParagraph, p.norm.text.length));
}

/**
 * 将一个 DOM Range 端点（某段元素内的文本偏移，基于原始 textContent）
 * 换算为扁平规范化偏移。nodeOffset 语义：相对段落元素 textContent 的下标。
 */
export function domPointToFlat(
  paragraph: FlatParagraph,
  rawOffset: number,
): number {
  const clamped = Math.max(0, Math.min(rawOffset, paragraph.raw.length));
  const normOffset = paragraph.norm.inv[clamped] ?? paragraph.norm.text.length;
  return flatOffset(paragraph, normOffset);
}

/** 扁平偏移 -> (段落, 原始 textContent 偏移)，用于构造 DOM Range。 */
export function flatToDomPoint(
  chapter: FlatChapter,
  pos: number,
): { paragraph: FlatParagraph; rawOffset: number } {
  const { paragraph, offset } = pointAt(chapter, pos);
  const rawOffset =
    offset >= paragraph.norm.text.length
      ? paragraph.raw.length
      : paragraph.norm.map[offset];
  return { paragraph, rawOffset };
}

/** 读取章节元素内用户选区，返回规范化后的扁平区间；非本章节选区返回 null。 */
export function readSelection(
  rootEl: HTMLElement,
  chapter: FlatChapter,
): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startP = locateParagraph(rootEl, range.startContainer, chapter);
  const endP = locateParagraph(rootEl, range.endContainer, chapter);
  if (!startP || !endP) return null;

  const s = domPointToFlat(
    startP,
    nodeOffsetWithin(range.startContainer, range.startOffset),
  );
  const e = domPointToFlat(
    endP,
    nodeOffsetWithin(range.endContainer, range.endOffset),
  );
  const start = Math.min(s, e);
  const end = Math.max(s, e);
  if (end <= start) return null;
  return { start, end };
}

/** 判断节点是否在某个段落渲染元素内，并返回该段落数据。 */
function locateParagraph(
  rootEl: HTMLElement,
  node: Node,
  chapter: FlatChapter,
): FlatParagraph | null {
  let el: Node | null =
    node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el && el !== rootEl) {
    if (
      el.nodeType === Node.ELEMENT_NODE &&
      (el as HTMLElement).dataset?.paraIndex !== undefined
    ) {
      const idx = Number((el as HTMLElement).dataset.paraIndex);
      return chapter.paragraphs[idx] ?? null;
    }
    el = el.parentNode;
  }
  return null;
}

/**
 * 计算文本节点相对于其所在段落元素的 textContent 偏移。
 * 渲染时段落只有一个文本节点（无嵌套元素），高亮层独立于文字层。
 */
function nodeOffsetWithin(node: Node, offset: number): number {
  const paraEl = (
    node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  ) as HTMLElement | null;
  if (!paraEl || paraEl.dataset?.paraIndex === undefined) {
    // 理论上 locateParagraph 已保证不会走到这里。
    return offset;
  }
  if (node === paraEl) return offset; // 端点直接是段落元素
  if (node.parentNode === paraEl && node.nodeType === Node.TEXT_NODE) {
    // 找该文本节点前的兄弟长度。
    let total = 0;
    let sib = node.previousSibling;
    while (sib) {
      total += sib.textContent?.length ?? 0;
      sib = sib.previousSibling;
    }
    return total + offset;
  }
  // 兜底：遍历段落 textContent（单文本节点时与上面等价）。
  return offset;
}
