import type { Annotation, Book } from "../types";

/**
 * 单一持久化层：批注状态按书 id 存于 localStorage。
 * 画面高亮、导出、重锚后的状态都来自同一份内存状态（见 useAnnotations），
 * 这里只负责把它写入 / 读出。
 *
 * 两种作用域：
 * - "book"：用户导入的完整书稿（reader: 前缀，保持既有键名不变）；
 * - "excerpt"：打开的节选分享文件（reader-excerpt: 前缀）。
 * 两者键空间互不相通——节选的保存/编辑绝不覆盖或串入原书稿，
 * 反过来重新载入完整书稿也不会读到节选批注。
 */
export type StorageScope = "book" | "excerpt";

const SCOPE_PREFIX: Record<StorageScope, string> = {
  book: "reader:",
  excerpt: "reader-excerpt:",
};
const LAST_BOOK_KEY = "reader:lastBookId";

function annotationKey(scope: StorageScope, bookId: string): string {
  return `${SCOPE_PREFIX[scope]}annotations:${bookId}`;
}
function bookKey(scope: StorageScope, bookId: string): string {
  return `${SCOPE_PREFIX[scope]}book:${bookId}`;
}

export const storage = {
  loadAnnotations(
    bookId: string,
    scope: StorageScope = "book",
  ): Annotation[] | null {
    try {
      const raw = localStorage.getItem(annotationKey(scope, bookId));
      if (!raw) return null;
      const data = JSON.parse(raw);
      return Array.isArray(data) ? (data as Annotation[]) : null;
    } catch {
      return null;
    }
  },
  saveAnnotations(
    bookId: string,
    annotations: Annotation[],
    scope: StorageScope = "book",
  ): void {
    localStorage.setItem(
      annotationKey(scope, bookId),
      JSON.stringify(annotations),
    );
  },
  loadBook(bookId: string, scope: StorageScope = "book"): Book | null {
    try {
      const raw = localStorage.getItem(bookKey(scope, bookId));
      return raw ? (JSON.parse(raw) as Book) : null;
    } catch {
      return null;
    }
  },
  saveBook(book: Book, scope: StorageScope = "book"): void {
    localStorage.setItem(bookKey(scope, book.id), JSON.stringify(book));
    if (scope === "book") localStorage.setItem(LAST_BOOK_KEY, book.id);
  },
  lastBookId(): string | null {
    return localStorage.getItem(LAST_BOOK_KEY);
  },
};
