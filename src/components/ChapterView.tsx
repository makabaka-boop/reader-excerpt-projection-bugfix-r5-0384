import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Annotation } from "../types";
import type { FlatChapter, FlatParagraph } from "../text/flatten";
import { flatToDomPoint, readSelection } from "../text/flatten";

/** 用锚点的扁平坐标构造真实 DOM Range；空段落退化为元素位置。 */
function buildRange(
  root: HTMLElement,
  chapter: FlatChapter,
  start: number,
  end: number,
): Range | null {
  const s = flatToDomPoint(chapter, start);
  const e = flatToDomPoint(chapter, end);
  const sEl = root.querySelector<HTMLElement>(
    `[data-para-index="${s.paragraph.index}"]`,
  );
  const eEl = root.querySelector<HTMLElement>(
    `[data-para-index="${e.paragraph.index}"]`,
  );
  if (!sEl || !eEl) return null;

  const range = document.createRange();
  const set = (el: HTMLElement, rawOffset: number, which: "start" | "end") => {
    const text =
      el.firstChild?.nodeType === Node.TEXT_NODE
        ? (el.firstChild as Text)
        : null;
    if (text) {
      const off = Math.max(0, Math.min(rawOffset, text.data.length));
      if (which === "start") range.setStart(text, off);
      else range.setEnd(text, off);
    } else {
      if (which === "start") range.setStartBefore(el);
      else range.setEndAfter(el);
    }
  };
  set(sEl, s.rawOffset, "start");
  set(eEl, e.rawOffset, "end");
  return range;
}

interface Box {
  id: string;
  status: Annotation["status"];
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PendingSelection {
  start: number;
  end: number;
  x: number;
  y: number;
}

interface ChapterViewProps {
  chapter: FlatChapter;
  fontSize: number;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (start: number, end: number, note: string) => void;
}

export function ChapterView({
  chapter,
  fontSize,
  annotations,
  selectedId,
  onSelect,
  onCreate,
}: ChapterViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [tick, setTick] = useState(0);

  const anchored = useMemo(
    () =>
      annotations.filter(
        (a) => a.status === "anchored" && a.anchor.chapterId === chapter.id,
      ),
    [annotations, chapter.id],
  );

  // 重算高亮：字号/窗口宽度/数据变化后都从同一批锚点重新测量，
  // DOM 重排不影响文字偏移（偏移基于规范化文字而非像素）。
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const next: Box[] = [];
    const rootRect = root.getBoundingClientRect();
    for (const a of anchored) {
      const range = buildRange(root, chapter, a.anchor.start, a.anchor.end);
      if (!range) continue;
      for (const r of Array.from(range.getClientRects())) {
        if (r.width <= 0 || r.height <= 0) continue;
        next.push({
          id: a.id,
          status: a.status,
          left: r.left - rootRect.left + root.scrollLeft,
          top: r.top - rootRect.top + root.scrollTop,
          width: r.width,
          height: r.height,
        });
      }
    }
    setBoxes(next);
  }, [anchored, chapter, fontSize, tick]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(root);
    window.addEventListener("resize", forceTick);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", forceTick);
    };
    function forceTick() {
      setTick((t) => t + 1);
    }
  }, []);

  const captureSelection = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const sel = readSelection(root, chapter);
    if (!sel) {
      setPending(null);
      return;
    }
    const live = window.getSelection();
    const rect =
      live && live.rangeCount > 0
        ? live.getRangeAt(0).getBoundingClientRect()
        : null;
    const rootRect = root.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      setPending(null);
      return;
    }
    setPending({
      start: sel.start,
      end: sel.end,
      x: rect.left - rootRect.left + rect.width / 2 + root.scrollLeft,
      y: rect.top - rootRect.top + root.scrollTop,
    });
    setNoteDraft("");
  }, [chapter]);

  // 点高亮：找出点击点覆盖的全部批注（含重叠），循环选择。
  const onBoxClick = useCallback(
    (ev: React.MouseEvent, clickedId: string) => {
      ev.stopPropagation();
      const root = rootRef.current;
      if (!root) return;
      const rootRect = root.getBoundingClientRect();
      const px = ev.clientX - rootRect.left + root.scrollLeft;
      const py = ev.clientY - rootRect.top + root.scrollTop;
      const hits = new Set<string>();
      for (const b of boxes) {
        if (
          px >= b.left &&
          px <= b.left + b.width &&
          py >= b.top &&
          py <= b.top + b.height
        )
          hits.add(b.id);
      }
      const list = anchored.filter((a) => hits.has(a.id)).map((a) => a.id);
      const order = list.length > 0 ? list : [clickedId];
      const idx = order.indexOf(selectedId ?? "");
      onSelect(order[(idx + 1) % order.length] ?? order[0]);
    },
    [boxes, anchored, selectedId, onSelect],
  );

  const confirmCreate = useCallback(() => {
    if (pending) {
      onCreate(pending.start, pending.end, noteDraft.trim());
      window.getSelection()?.removeAllRanges();
      setPending(null);
    }
  }, [pending, noteDraft, onCreate]);

  return (
    <div className="chapter" style={{ fontSize }}>
      <h2 className="chapter-title">{chapter.title}</h2>
      <div
        ref={rootRef}
        className="chapter-text"
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
      >
        {chapter.paragraphs.map((p: FlatParagraph) => (
          <p key={p.id} className="para" data-para-index={p.index}>
            {p.raw}
          </p>
        ))}

        <div className="highlight-layer" aria-hidden="true">
          {boxes.map((b, i) => {
            const selected = b.id === selectedId;
            return (
              <div
                key={`${b.id}-${i}`}
                className={`hl hl-${b.status}${selected ? " hl-selected" : ""}`}
                style={{
                  left: b.left,
                  top: b.top,
                  width: b.width,
                  height: b.height,
                }}
                onClick={(e) => onBoxClick(e, b.id)}
              />
            );
          })}
        </div>

        {pending && (
          <div
            className="selection-pop"
            style={{ left: pending.x, top: pending.y }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="pop-hint">{pending.end - pending.start} 字</span>
            <textarea
              autoFocus
              value={noteDraft}
              placeholder="写批注（可留空）"
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                  confirmCreate();
                if (e.key === "Escape") setPending(null);
              }}
              rows={2}
            />
            <div className="pop-actions">
              <button type="button" onClick={() => setPending(null)}>
                取消
              </button>
              <button type="button" className="primary" onClick={confirmCreate}>
                保存批注
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
