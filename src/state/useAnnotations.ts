import { validateExcerpt, type ExcerptPackage } from "../excerpt";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, Book, Candidate } from "../types";
import { flattenBook, type FlatBook } from "../text/flatten";
import {
  createAnchor,
  makeId,
  reanchorAll,
  resolveCandidate,
} from "../text/anchor";
import { ensureAnchored } from "../text/validate";
import { storage } from "./storage";

export interface ImportReport {
  version: string | undefined;
  counts: { anchored: number; ambiguous: number; lost: number };
}

export function useAnnotations() {
  const [book, setBook] = useState<Book | null>(null);
  const [flat, setFlat] = useState<FlatBook | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [lastReport, setLastReport] = useState<ImportReport | null>(null);
  const bookRef = useRef<Book | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;

  // 持久化与内存状态同源：任何变更都写入 localStorage。
  useEffect(() => {
    if (book) storage.saveAnnotations(book.id, annotations);
  }, [book, annotations]);

  /**
   * 导入书稿。同书 id 但 version 变化视为「新版本」→ 全部按证据强制重锚；
   * 其余情况（首次载入、刷新后重载同一版本）坐标吻合的锚点直接保留，
   * 不吻合的再按证据重锚。
   */
  const importBook = useCallback((next: Book) => {
    const prev = bookRef.current;
    const nextFlat = flattenBook(next);
    const isNewVersion =
      !!prev && prev.id === next.id && prev.version !== next.version;
    const source = isNewVersion
      ? annotationsRef.current
      : (storage.loadAnnotations(next.id) ?? []);
    const restored = isNewVersion
      ? reanchorAll(source, nextFlat)
      : ensureAnchored(source, nextFlat);

    storage.saveBook(next);
    bookRef.current = next;
    setBook(next);
    setFlat(nextFlat);
    setAnnotations(restored);
    const counts = { anchored: 0, ambiguous: 0, lost: 0 };
    for (const a of restored) counts[a.status]++;
    setLastReport({ version: next.version, counts });
  }, []);

  const addAnnotation = useCallback(
    (chapterId: string, start: number, end: number, note: string) => {
      const ch = flat?.chapterById.get(chapterId);
      if (!ch || end <= start) return;
      const anchor = createAnchor(ch, start, end);
      const ann: Annotation = {
        id: makeId(),
        note,
        status: "anchored",
        anchor,
        createdAt: Date.now(),
      };
      setAnnotations((prev) => [...prev, ann]);
    },
    [flat],
  );

  const updateNote = useCallback((id: string, note: string) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, note } : a)),
    );
  }, []);

  const deleteAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const resolve = useCallback(
    (id: string, candidate: Candidate) => {
      setAnnotations((prev) =>
        prev.map((a) => {
          if (a.id !== id || !flat) return a;
          const next = resolveCandidate(a, candidate, flat);
          // 即使采用候选失败也不自动猜测落点。
          return next;
        }),
      );
    },
    [flat],
  );

  const markLost = useCallback((id: string) => {
    setAnnotations((prev) =>
      prev.map((a) =>
        a.id === id && a.status === "ambiguous"
          ? { ...a, status: "lost", candidates: undefined }
          : a,
      ),
    );
  }, []);

  const loadExcerpt = useCallback((pack: ExcerptPackage) => {
    const checked = validateExcerpt(pack);
    const nextFlat = flattenBook(checked.book);
    storage.saveBook(checked.book);
    storage.saveAnnotations(checked.book.id, checked.annotations);
    bookRef.current = checked.book;
    setBook(checked.book);
    setFlat(nextFlat);
    setAnnotations(checked.annotations);
    setLastReport({
      version: checked.book.version,
      counts: { anchored: checked.annotations.length, ambiguous: 0, lost: 0 },
    });
  }, []);

  return useMemo(
    () => ({
      loadExcerpt,
      book,
      flat,
      annotations,
      lastReport,
      importBook,
      addAnnotation,
      updateNote,
      deleteAnnotation,
      resolve,
      markLost,
    }),
    [
      loadExcerpt,
      book,
      flat,
      annotations,
      lastReport,
      importBook,
      addAnnotation,
      updateNote,
      deleteAnnotation,
      resolve,
      markLost,
    ],
  );
}
