import type { Annotation, Book } from "./types";

export interface ExportPayload {
  bookId: string;
  bookTitle: string;
  version?: string;
  exportedAt: string;
  counts: { anchored: number; ambiguous: number; lost: number };
  annotations: Array<{
    id: string;
    status: Annotation["status"];
    chapterId: string;
    start: number;
    end: number;
    text: string;
    prefix: string;
    suffix: string;
    note: string;
    createdAt: number;
  }>;
}

/**
 * 导出内容直接取自同一锚点状态（与画面高亮、持久化同源），
 * 失联/待裁决批注连同原文证据一并导出。
 */
export function buildExport(
  book: Book,
  annotations: Annotation[],
): ExportPayload {
  const counts = { anchored: 0, ambiguous: 0, lost: 0 };
  for (const a of annotations) counts[a.status]++;
  const rank = { anchored: 0, ambiguous: 1, lost: 2 } as const;
  const sorted = [...annotations].sort((x, y) => {
    if (rank[x.status] !== rank[y.status])
      return rank[x.status] - rank[y.status];
    if (x.anchor.chapterId !== y.anchor.chapterId)
      return x.anchor.chapterId < y.anchor.chapterId ? -1 : 1;
    return x.anchor.start - y.anchor.start;
  });
  return {
    bookId: book.id,
    bookTitle: book.title,
    version: book.version,
    exportedAt: new Date().toISOString(),
    counts,
    annotations: sorted.map((a) => ({
      id: a.id,
      status: a.status,
      chapterId: a.anchor.chapterId,
      start: a.anchor.start,
      end: a.anchor.end,
      text: a.anchor.text,
      prefix: a.anchor.prefix,
      suffix: a.anchor.suffix,
      note: a.note,
      createdAt: a.createdAt,
    })),
  };
}

export function downloadJson(payload: ExportPayload): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${payload.bookId}-annotations.json`;
  a.click();
  URL.revokeObjectURL(url);
}
