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
import { storage, type StorageScope } from "./storage";

export interface ImportReport {
  version: string | undefined;
  counts: { anchored: number; ambiguous: number; lost: number };
}

export function useAnnotations() {
  const [book, setBook] = useState<Book | null>(null);
  const [flat, setFlat] = useState<FlatBook | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [lastReport, setLastReport] = useState<ImportReport | null>(null);
  const [scope, setScope] = useState<StorageScope>("book");
  const bookRef = useRef<Book | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;

  // 持久化与内存状态同源：任何变更都写入当前作用域的 localStorage。
  // 完整书稿与节选分属不同键空间，节选的保存/编辑永远到不了原书稿。
  useEffect(() => {
    if (book) storage.saveAnnotations(book.id, annotations, scope);
  }, [book, annotations, scope]);

  /**
   * 导入书稿。同书 id 但 version 变化视为「新版本」→ 全部按证据强制重锚；
   * 其余情况（首次载入、刷新后重载同一版本）坐标吻合的锚点直接保留，
   * 不吻合的再按证据重锚。始终走完整书稿作用域，即使当前正在看节选。
   */
  const importBook = useCallback((next: Book) => {
    const prev = bookRef.current;
    const nextFlat = flattenBook(next);
    const isNewVersion =
      !!prev && prev.id === next.id && prev.version !== next.version;
    // 新版本重锚基于内存中的现存批注；其余情况从完整书稿作用域恢复，
    // 绝不会读到节选作用域里的批注。
    const source = isNewVersion
      ? annotationsRef.current
      : (storage.loadAnnotations(next.id, "book") ?? []);
    const restored = isNewVersion
      ? reanchorAll(source, nextFlat)
      : ensureAnchored(source, nextFlat);

    storage.saveBook(next, "book");
    setScope("book");
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

  /**
   * 打开节选分享文件。
   *
   * 先做完整严格校验（validateExcerpt 失败时抛 ExcerptError），通过后才
   * 扁平化、落库、切换状态——校验阶段不触碰任何状态与 localStorage，
   * 非法文件不会留下部分更新。节选以 excerpt 作用域独立保存，不覆盖原书稿；
   * 节选中的批注全部已是「坐标与节选文字逐字一致」的已定位锚点，直接展示。
   *
   * @returns 校验通过的节选包（调用方可据此切换章节等 UI 状态）。
   */
  const loadExcerpt = useCallback((raw: unknown): ExcerptPackage => {
    // 以下任一步抛错，本函数都不会产生任何副作用。
    const checked = validateExcerpt(raw);
    const nextFlat = flattenBook(checked.book);

    storage.saveBook(checked.book, "excerpt");
    storage.saveAnnotations(checked.book.id, checked.annotations, "excerpt");
    setScope("excerpt");
    bookRef.current = checked.book;
    setBook(checked.book);
    setFlat(nextFlat);
    setAnnotations(structuredClone(checked.annotations));
    setLastReport({
      version: checked.book.version,
      counts: { anchored: checked.annotations.length, ambiguous: 0, lost: 0 },
    });
    return checked;
  }, []);

  return useMemo(
    () => ({
      loadExcerpt,
      book,
      flat,
      annotations,
      lastReport,
      scope,
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
      scope,
      importBook,
      addAnnotation,
      updateNote,
      deleteAnnotation,
      resolve,
      markLost,
    ],
  );
}
