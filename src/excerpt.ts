import type { Annotation, Book } from "./types";
import { flattenBook } from "./text/flatten";
export interface ExcerptRange {
  chapterId: string;
  start: number;
  end: number;
}
export interface ExcerptPackage {
  format: "reader-excerpt";
  book: Book;
  annotations: Annotation[];
}
export function buildExcerpt(
  book: Book,
  annotations: Annotation[],
  ranges: ExcerptRange[],
): ExcerptPackage {
  const flat = flattenBook(book);
  const chapters = book.chapters
    .filter((c) => ranges.some((r) => r.chapterId === c.id))
    .map((c) => {
      const chosen = ranges.filter((r) => r.chapterId === c.id);
      const start = Math.min(...chosen.map((r) => r.start));
      const end = Math.max(...chosen.map((r) => r.end));
      return {
        ...c,
        paragraphs: [
          { text: flat.chapterById.get(c.id)!.text.slice(start, end) },
        ],
      };
    });
  return structuredClone({
    format: "reader-excerpt",
    book: { ...book, chapters },
    annotations,
  });
}
export function validateExcerpt(pack: ExcerptPackage): ExcerptPackage {
  return structuredClone(pack);
}
