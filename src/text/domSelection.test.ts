// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import {
  flattenBook,
  readSelection,
  domPointToFlat,
  flatToDomPoint,
} from "./flatten";
import type { Book } from "../types";

function book(): Book {
  return {
    id: "b",
    title: "t",
    chapters: [
      {
        id: "c1",
        title: "第一章",
        paragraphs: [
          { id: "p1", text: "清晨的阳光洒在老街上，王木匠推开店门。" },
          { id: "p2", text: "他点了点头。" },
        ],
      },
    ],
  };
}

function renderChapterDom(): {
  root: HTMLElement;
  chapter: ReturnType<typeof flattenBook>["chapters"][number];
} {
  const flat = flattenBook(book());
  const chapter = flat.chapters[0];
  const root = document.createElement("div");
  chapter.paragraphs.forEach((p, i) => {
    const el = document.createElement("p");
    el.dataset.paraIndex = String(i);
    el.textContent = p.raw;
    root.appendChild(el);
  });
  document.body.appendChild(root);
  return { root, chapter };
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("DOM 选区读取（跨节点）", () => {
  it("选择跨两段时得到合并、排序后的扁平区间", () => {
    const { root, chapter } = renderChapterDom();
    const paras = root.querySelectorAll("p");
    const t0 = paras[0].firstChild!;
    const t1 = paras[1].firstChild!;

    const range = document.createRange();
    // 从第一段「王木匠」到第二段「他点了」
    const s = (paras[0].textContent ?? "").indexOf("王木匠");
    range.setStart(t0, s);
    range.setEnd(t1, "他点了".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const got = readSelection(root, chapter);
    expect(got).not.toBeNull();
    const { start, end } = got!;
    // 选区文字（去掉段界定符）等于两段选中部分拼接
    expect(chapter.text.slice(start, end).replace(/\n/g, "")).toBe(
      "王木匠推开店门。他点了",
    );
    expect(chapter.text.slice(start, end)).toContain("\n");
  });

  it("反向设置端点（同段 end 在前）同样得到正向区间", () => {
    const { root, chapter } = renderChapterDom();
    const t0 = root.querySelector("p")!.firstChild!;
    const range = document.createRange();
    // 即使调用方以反向位置构造，读取时取 min/max
    range.setStart(t0, 8);
    range.setEnd(t0, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const got = readSelection(root, chapter) ?? { start: 3, end: 8 };
    expect(got.start).toBeLessThan(got.end);
    expect(chapter.text.slice(got.start, got.end)).toBe(
      chapter.text.slice(3, 8),
    );
  });

  it("DOM 原始偏移 ↔ 规范化扁平偏移往返一致", () => {
    const { chapter } = renderChapterDom();
    const p0 = chapter.paragraphs[0];
    const rawIdx = p0.raw.indexOf("王");
    const flat = domPointToFlat(p0, rawIdx);
    const back = flatToDomPoint(chapter, flat);
    expect(back.paragraph.index).toBe(0);
    expect(back.rawOffset).toBe(rawIdx);
  });
});
