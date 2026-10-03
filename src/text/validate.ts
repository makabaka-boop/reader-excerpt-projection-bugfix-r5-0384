import type { Annotation } from "../types";
import type { FlatBook } from "./flatten";
import { reanchorOne } from "./anchor";

const compactString = (s: string): string => s.replace(/\n/g, "");

/** 检查现存锚点坐标处的文字是否仍与证据一致（同一书稿重载时坐标权威）。 */
export function anchorStillValid(
  annotation: Annotation,
  book: FlatBook,
): boolean {
  if (annotation.status !== "anchored") return false;
  const ch = book.chapterById.get(annotation.anchor.chapterId);
  if (!ch) return false;
  const { start, end, text } = annotation.anchor;
  if (start < 0 || end > ch.text.length || end <= start) return false;
  return compactString(ch.text.slice(start, end)) === compactString(text);
}

/**
 * 载入同一书稿（同一版本）时：坐标与文字吻合的锚点直接保留，
 * 其余按证据重锚。
 */
export function ensureAnchored(
  annotations: Annotation[],
  book: FlatBook,
): Annotation[] {
  return annotations.map((a) =>
    anchorStillValid(a, book) ? a : reanchorOne(a, book),
  );
}

/** 导出用：章节标题解析。 */
export function chapterTitle(book: FlatBook, chapterId: string): string {
  return book.chapterById.get(chapterId)?.title ?? chapterId;
}
