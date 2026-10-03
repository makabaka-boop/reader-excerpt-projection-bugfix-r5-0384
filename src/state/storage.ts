import type { Annotation, Book } from "../types";

/**
 * 单一持久化层：批注状态按书 id 存于 localStorage。
 * 画面高亮、导出、重锚后的状态都来自同一份内存状态（见 useAnnotations），
 * 这里只负责把它写入 / 读出。
 */
const STORE_PREFIX = "reader:annotations:";
const BOOK_PREFIX = "reader:book:";
const LAST_BOOK_KEY = "reader:lastBookId";

export const storage = {
  loadAnnotations(bookId: string): Annotation[] | null {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + bookId);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return Array.isArray(data) ? (data as Annotation[]) : null;
    } catch {
      return null;
    }
  },
  saveAnnotations(bookId: string, annotations: Annotation[]): void {
    localStorage.setItem(STORE_PREFIX + bookId, JSON.stringify(annotations));
  },
  loadBook(bookId: string): Book | null {
    try {
      const raw = localStorage.getItem(BOOK_PREFIX + bookId);
      return raw ? (JSON.parse(raw) as Book) : null;
    } catch {
      return null;
    }
  },
  saveBook(book: Book): void {
    localStorage.setItem(BOOK_PREFIX + book.id, JSON.stringify(book));
    localStorage.setItem(LAST_BOOK_KEY, book.id);
  },
  lastBookId(): string | null {
    return localStorage.getItem(LAST_BOOK_KEY);
  },
};
