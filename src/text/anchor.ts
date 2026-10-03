import type { Anchor, Annotation, Candidate } from "../types";
import type { FlatBook, FlatChapter } from "./flatten";

/** 两侧上下文各取多少字（规范化扁平偏移）。 */
export const CONTEXT_RADIUS = 32;

/** 去掉段界定符，得到连续文字，并保留 连续下标 -> 扁平下标 的映射。 */
interface Compact {
  text: string;
  toFlat: number[];
}

function compactChapter(ch: FlatChapter): Compact {
  const text: string[] = [];
  const toFlat: number[] = [];
  for (let i = 0; i < ch.text.length; i++) {
    if (ch.text[i] !== "\n") {
      text.push(ch.text[i]);
      toFlat.push(i);
    }
  }
  return { text: text.join(""), toFlat };
}

const compactString = (s: string): string => s.replace(/\n/g, "");

/** 从章节扁平文字中切出锚点（含两侧上下文）。 */
export function createAnchor(
  chapter: FlatChapter,
  start: number,
  end: number,
): Anchor {
  const text = chapter.text.slice(start, end);
  const prefix = chapter.text
    .slice(Math.max(0, start - CONTEXT_RADIUS), start)
    .replace(/\n/g, "");
  const suffix = chapter.text
    .slice(end, end + CONTEXT_RADIUS)
    .replace(/\n/g, "");
  return { chapterId: chapter.id, start, end, text, prefix, suffix };
}

function findOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + 1; // 允许重叠出现
  }
  return out;
}

/**
 * 候选评分：从选区边界向两侧逐字比较上下文。
 * 完全吻合的上下文越长，分数越高（编辑发生在远处时得分接近满分）。
 */
function scoreCandidate(
  compact: Compact,
  hitStart: number,
  hitEnd: number,
  anchor: Anchor,
): number {
  let score = 0;
  // 前缀：自边界向左
  let i = hitStart - 1;
  let j = anchor.prefix.length - 1;
  while (i >= 0 && j >= 0 && compact.text[i] === anchor.prefix[j]) {
    score++;
    i--;
    j--;
  }
  // 后缀：自边界向右
  i = hitEnd;
  j = 0;
  while (
    i < compact.text.length &&
    j < anchor.suffix.length &&
    compact.text[i] === anchor.suffix[j]
  ) {
    score++;
    i++;
    j++;
  }
  return score;
}

export interface ReanchorResult {
  annotation: Annotation;
}

/**
 * 用新版本书稿为单条批注重锚。
 *
 * - 章节缺失或选中文字 0 次出现：lost，原锚点与上下文原样保留作为证据；
 * - 恰好 1 次出现：anchored，自动迁移（段落拆分导致的段界换行被忽略）；
 * - 多次出现：ambiguous，全部候选按上下文评分降序，等待人工裁决。
 *
 * 任何情况下都不猜测落点。
 */
export function reanchorOne(
  annotation: Annotation,
  newBook: FlatBook,
): Annotation {
  const ch = newBook.chapterById.get(annotation.anchor.chapterId);
  const base: Annotation = { ...annotation, candidates: undefined };
  if (!ch) return { ...base, status: "lost" };

  const compact = compactChapter(ch);
  const needle = compactString(annotation.anchor.text);
  const hits = findOccurrences(compact.text, needle);
  if (hits.length === 0) return { ...base, status: "lost" };

  if (hits.length === 1) {
    return {
      ...base,
      status: "anchored",
      anchor: anchorAt(ch, compact, hits[0], hits[0] + needle.length),
    };
  }

  const candidates: Candidate[] = hits
    .map((h) => {
      const cs = compact.toFlat[h];
      const ce = compact.toFlat[h + needle.length - 1] + 1;
      return {
        chapterId: ch.id,
        start: cs,
        end: ce,
        score: scoreCandidate(compact, h, h + needle.length, annotation.anchor),
      };
    })
    .sort((a, b) => b.score - a.score);
  return { ...base, status: "ambiguous", candidates };
}

/** 由连续文字坐标构造新锚点，并刷新选中文字与两侧上下文。 */
function anchorAt(
  ch: FlatChapter,
  compact: Compact,
  cStart: number,
  cEnd: number,
): Anchor {
  const start = compact.toFlat[cStart];
  const end = cEnd > 0 ? compact.toFlat[cEnd - 1] + 1 : start;
  return createAnchor(ch, start, end);
}

/** 批量重锚：每次导入新版本都基于各批注现存锚点重新尝试。 */
export function reanchorAll(
  annotations: Annotation[],
  newBook: FlatBook,
): Annotation[] {
  return annotations.map((a) => reanchorOne(a, newBook));
}

/** 人工裁决：采用 ambiguous 批注的某个候选。 */
export function resolveCandidate(
  annotation: Annotation,
  candidate: Candidate,
  book: FlatBook,
): Annotation {
  const ch = book.chapterById.get(candidate.chapterId);
  if (!ch || annotation.status !== "ambiguous") return annotation;
  const compact = compactChapter(ch);
  // 候选坐标是扁平坐标，换算回连续坐标以复用 anchorAt。
  const cStart = compact.toFlat.indexOf(candidate.start);
  let cEnd = -1;
  for (let i = 0; i < compact.toFlat.length; i++) {
    if (compact.toFlat[i] === candidate.end - 1) {
      cEnd = i + 1;
      break;
    }
  }
  if (cStart < 0 || cEnd < 0) return annotation;
  return {
    ...annotation,
    status: "anchored",
    candidates: undefined,
    anchor: anchorAt(ch, compact, cStart, cEnd),
  };
}

/** 候选证据片段：命中文字及两侧上下文，供裁决界面展示。 */
export function candidateSnippet(
  book: FlatBook,
  candidate: Candidate,
  radius = 16,
): { before: string; hit: string; after: string } {
  const ch = book.chapterById.get(candidate.chapterId);
  if (!ch) return { before: "", hit: "", after: "" };
  const compact = compactChapter(ch);
  let cStart = -1;
  let cEnd = -1;
  for (let i = 0; i < compact.toFlat.length; i++) {
    if (compact.toFlat[i] === candidate.start) cStart = i;
    if (compact.toFlat[i] === candidate.end - 1) cEnd = i + 1;
  }
  if (cStart < 0 || cEnd < 0) return { before: "", hit: "", after: "" };
  return {
    before: compact.text.slice(Math.max(0, cStart - radius), cStart),
    hit: compact.text.slice(cStart, cEnd),
    after: compact.text.slice(cEnd, cEnd + radius),
  };
}

let counter = 0;
export function makeId(): string {
  counter += 1;
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `a-${Date.now().toString(36)}-${counter}`;
}
