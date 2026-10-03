import { buildExcerpt, type ExcerptRange } from "./excerpt";
import { readSelection } from "./text/flatten";
import { useCallback, useRef, useState } from "react";
import { useAnnotations } from "./state/useAnnotations";
import { parseBook, BookParseError } from "./text/parseBook";
import { buildExport, downloadJson } from "./export";
import { ChapterView } from "./components/ChapterView";
import { Sidebar } from "./components/Sidebar";
import { sampleBookV1, sampleBookV2 } from "./samples";

export default function App() {
  const ann = useAnnotations();
  const [shareRanges, setShareRanges] = useState<ExcerptRange[]>([]);
  const shareFile = useRef<HTMLInputElement>(null);
  const [fontSize, setFontSize] = useState(18);
  const [contentWidth, setContentWidth] = useState(720);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const doImport = useCallback(
    (text: string) => {
      try {
        const book = parseBook(text);
        ann.importBook(book);
        setShareRanges([]);
        setError(null);
        setChapterId((cur) =>
          cur && book.chapters.some((c) => c.id === cur)
            ? cur
            : book.chapters[0].id,
        );
      } catch (e) {
        setError(
          e instanceof BookParseError
            ? e.message
            : `导入失败：${(e as Error).message}`,
        );
      }
    },
    [ann],
  );

  const onFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => doImport(String(reader.result ?? ""));
      reader.readAsText(file);
    },
    [doImport],
  );

  const chapter =
    ann.flat && chapterId
      ? (ann.flat.chapterById.get(chapterId) ?? ann.flat.chapters[0])
      : null;

  const onExport = useCallback(() => {
    if (ann.book) downloadJson(buildExport(ann.book, ann.annotations));
  }, [ann]);

  const addShareRange = () => {
    const root = document.querySelector<HTMLElement>(".chapter-text");
    if (root && chapter) {
      const selected = readSelection(root, chapter);
      if (selected)
        setShareRanges((v) => [...v, { chapterId: chapter.id, ...selected }]);
    }
  };
  const exportShare = () => {
    try {
      if (!ann.book) return;
      const pack = buildExcerpt(ann.book, ann.annotations, shareRanges);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(pack)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "reading-excerpt.json";
      a.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">书稿阅读器</div>
        <button type="button" onClick={() => fileRef.current?.click()}>
          导入 JSON 书稿
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => doImport(JSON.stringify(sampleBookV1))}
        >
          示例 v1
        </button>
        <button
          type="button"
          onClick={() => doImport(JSON.stringify(sampleBookV2))}
          title="同一本书的新版本"
        >
          示例 v2（重锚）
        </button>
        <span className="sep" />
        <label className="ctrl">
          字号 {fontSize}px
          <input
            type="range"
            min={14}
            max={30}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
        </label>
        <label className="ctrl">
          栏宽 {contentWidth}px
          <input
            type="range"
            min={420}
            max={1000}
            value={contentWidth}
            onChange={(e) => setContentWidth(Number(e.target.value))}
          />
        </label>
        <button
          disabled={!chapter}
          onMouseDown={(e) => {
            e.preventDefault();
            addShareRange();
          }}
        >
          加入分享选区
        </button>
        <button disabled={!shareRanges.length} onClick={exportShare}>
          导出节选（{shareRanges.length} 处）
        </button>
        <button onClick={() => setShareRanges([])}>清空选区</button>
        <button onClick={() => shareFile.current?.click()}>打开节选</button>
        <input
          hidden
          ref={shareFile}
          type="file"
          accept="application/json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const checked = ann.loadExcerpt(JSON.parse(await f.text()));
              setChapterId(checked.book.chapters[0]?.id ?? null);
              setShareRanges([]);
              setError(null);
            } catch (err) {
              setError(
                err instanceof Error ? err.message : `打开节选失败：${String(err)}`,
              );
            }
            e.target.value = "";
          }}
        />
        <span className="spacer" />
        <button type="button" onClick={onExport} disabled={!ann.book}>
          导出批注
        </button>
      </header>

      {error && <div className="errorbar">{error}</div>}

      {ann.lastReport &&
        ann.lastReport.counts.ambiguous + ann.lastReport.counts.lost > 0 && (
          <div className="reportbar">
            重锚完成（版本 {ann.lastReport.version ?? "?"}）：已定位{" "}
            {ann.lastReport.counts.anchored} 条，
            <strong> {ann.lastReport.counts.ambiguous} 条待裁决</strong>，
            <strong> {ann.lastReport.counts.lost} 条失联</strong>
            （失联批注保留原文证据，未猜测落点）
          </div>
        )}

      <div className="main">
        {ann.flat && (
          <nav className="toc">
            <h3>{ann.book?.title}</h3>
            {ann.book?.version && (
              <div className="version">版本 {ann.book.version}</div>
            )}
            {ann.flat.chapters.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`toc-item${c.id === chapter?.id ? " active" : ""}`}
                onClick={() => setChapterId(c.id)}
              >
                {c.title}
              </button>
            ))}
          </nav>
        )}

        <main
          className="reader"
          style={{ ["--content-width" as string]: `${contentWidth}px` }}
        >
          {!ann.flat && (
            <div className="welcome">
              <h2>本地 JSON 书稿批注阅读器</h2>
              <p>
                导入由「章节 + 段落」组成的 JSON，拖选跨段落文字即可保存批注。
              </p>
              <pre>{`{
  "id": "book-1",
  "title": "书名",
  "version": "1",
  "chapters": [
    { "id": "ch1", "title": "第一章", "paragraphs": ["段落一", "段落二…"] }
  ]
}`}</pre>
              <p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => doImport(JSON.stringify(sampleBookV1))}
                >
                  载入示例书稿试试
                </button>
              </p>
              <ul className="features">
                <li>锚点记录章节身份、规范化文字位置、选中文字与两侧上下文</li>
                <li>
                  改字号、拖窗口宽度后批注仍指向原文字（位置基于文字而非像素）
                </li>
                <li>
                  导入新版本：唯一匹配自动迁移，多处匹配人工裁决，找不到则保留失联证据
                </li>
                <li>重叠批注可循环点选、分别删除；高亮、持久化与导出同源</li>
              </ul>
            </div>
          )}
          {chapter && (
            <ChapterView
              chapter={chapter}
              fontSize={fontSize}
              annotations={ann.annotations}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onCreate={(start, end, note) =>
                ann.addAnnotation(chapter.id, start, end, note)
              }
            />
          )}
        </main>

        {ann.flat && (
          <Sidebar
            flat={ann.flat}
            annotations={ann.annotations}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChangeNote={ann.updateNote}
            onDelete={(id) => {
              ann.deleteAnnotation(id);
              if (selectedId === id) setSelectedId(null);
            }}
            onResolve={ann.resolve}
            onMarkLost={ann.markLost}
          />
        )}
      </div>
    </div>
  );
}
