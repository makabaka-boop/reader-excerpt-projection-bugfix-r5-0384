import { useMemo } from "react";
import type { Annotation, Candidate } from "../types";
import type { FlatBook } from "../text/flatten";
import { candidateSnippet } from "../text/anchor";

interface SidebarProps {
  flat: FlatBook;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeNote: (id: string, note: string) => void;
  onDelete: (id: string) => void;
  onResolve: (id: string, candidate: Candidate) => void;
  onMarkLost: (id: string) => void;
}

const statusLabel: Record<Annotation["status"], string> = {
  anchored: "已定位",
  ambiguous: "待裁决",
  lost: "失联",
};

export function Sidebar({
  flat,
  annotations,
  selectedId,
  onSelect,
  onChangeNote,
  onDelete,
  onResolve,
  onMarkLost,
}: SidebarProps) {
  const counts = useMemo(() => {
    const c = { anchored: 0, ambiguous: 0, lost: 0 };
    for (const a of annotations) c[a.status]++;
    return c;
  }, [annotations]);

  const sorted = useMemo(() => {
    const rank = { ambiguous: 0, lost: 1, anchored: 2 } as const;
    return [...annotations].sort((a, b) => {
      if (rank[a.status] !== rank[b.status])
        return rank[a.status] - rank[b.status];
      if (a.anchor.chapterId !== b.anchor.chapterId)
        return a.anchor.chapterId < b.anchor.chapterId ? -1 : 1;
      return a.anchor.start - b.anchor.start;
    });
  }, [annotations]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h3>批注（{annotations.length}）</h3>
        <div className="counts">
          <span className="tag tag-anchored">已定位 {counts.anchored}</span>
          <span className="tag tag-ambiguous">待裁决 {counts.ambiguous}</span>
          <span className="tag tag-lost">失联 {counts.lost}</span>
        </div>
      </div>

      <ul className="ann-list">
        {sorted.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className={`ann-item ann-${a.status}${selectedId === a.id ? " active" : ""}`}
              onClick={() => onSelect(a.id === selectedId ? null : a.id)}
            >
              <span className={`dot dot-${a.status}`} />
              <span className="ann-text">
                {a.anchor.text.replace(/\n/g, " ⏎ ") || "（空）"}
              </span>
              <span className={`badge badge-${a.status}`}>
                {statusLabel[a.status]}
              </span>
            </button>

            {selectedId === a.id && (
              <div className="ann-detail">
                <div className="evidence">
                  <div className="ev-line">
                    <em>章节</em>
                    {flat.chapterById.get(a.anchor.chapterId)?.title ??
                      a.anchor.chapterId}
                    <span className="coords">
                      [{a.anchor.start}, {a.anchor.end})
                    </span>
                  </div>
                  <div className="ev-line">
                    <em>原文</em>「{a.anchor.text.replace(/\n/g, " ⏎ ")}」
                  </div>
                  <div className="ev-context">
                    …{a.anchor.prefix}【选中】{a.anchor.suffix}…
                  </div>
                </div>

                <textarea
                  value={a.note}
                  rows={2}
                  placeholder="批注内容"
                  onChange={(e) => onChangeNote(a.id, e.target.value)}
                />

                {a.status === "ambiguous" && a.candidates && (
                  <div className="candidates">
                    <p className="warn">
                      在新版中找到 {a.candidates.length}{" "}
                      处相同文字，请人工选择，系统不会替你猜测：
                    </p>
                    {a.candidates.map((c, i) => {
                      const snip = candidateSnippet(flat, c);
                      return (
                        <button
                          type="button"
                          key={`${c.chapterId}-${c.start}`}
                          className="candidate"
                          onClick={() => onResolve(a.id, c)}
                          title={`上下文吻合度 ${c.score}`}
                        >
                          <span className="cand-rank">#{i + 1}</span>
                          <span className="cand-snip">
                            …{snip.before}
                            <mark>{snip.hit}</mark>
                            {snip.after}…
                          </span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="link-danger"
                      onClick={() => onMarkLost(a.id)}
                    >
                      都不对，标记为失联
                    </button>
                  </div>
                )}

                {a.status === "lost" && (
                  <p className="warn">
                    新版中找不到该文字（或所在章节缺失），已保留原文证据，未放置任何高亮。
                  </p>
                )}

                <button
                  type="button"
                  className="danger"
                  onClick={() => onDelete(a.id)}
                >
                  删除批注
                </button>
              </div>
            )}
          </li>
        ))}
        {annotations.length === 0 && (
          <li className="empty">在正文中拖选文字即可添加批注</li>
        )}
      </ul>
    </aside>
  );
}
