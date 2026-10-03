// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAnnotations } from "./useAnnotations";
import { buildExcerpt } from "../excerpt";
import { sampleBookV1, sampleBookV2 } from "../samples";

beforeEach(() => {
  localStorage.clear();
});

/** 原书稿名下的存储键（lastBookId 是「最近打开」指针，打开节选后合法变化）。 */
function storageSnapshot(): Record<string, string | null> {
  const keys = ["reader:annotations:sample-book", "reader:book:sample-book"];
  return Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)]));
}

describe("useAnnotations 端到端", () => {
  it("新增批注 → 持久化 → 重载入同一版本仍定位", () => {
    const { result, rerender } = renderHook(() => useAnnotations());

    act(() => result.current.importBook(structuredClone(sampleBookV1)));
    const ch = result.current.flat!.chapters[0];
    const s = ch.text.indexOf("王木匠推开店门");
    act(() =>
      result.current.addAnnotation(
        ch.id,
        s,
        s + "王木匠推开店门".length,
        "第一条",
      ),
    );
    const id = result.current.annotations[0].id;
    expect(result.current.annotations[0].status).toBe("anchored");
    expect(
      JSON.parse(localStorage.getItem("reader:annotations:sample-book")!)[0]
        .anchor.text,
    ).toContain("王木匠");

    // 模拟刷新：重新载入同一版本
    const { result: r2 } = renderHook(() => useAnnotations());
    act(() => r2.current.importBook(structuredClone(sampleBookV1)));
    expect(r2.current.annotations).toHaveLength(1);
    expect(r2.current.annotations[0].id).toBe(id);
    expect(r2.current.annotations[0].status).toBe("anchored");
    expect(r2.current.annotations[0].note).toBe("第一条");
    rerender();
  });

  it("导入新版本：唯一迁移 / 多处待裁决 / 找不到失联；裁决与删除分别作用于重叠批注", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.importBook(structuredClone(sampleBookV1)));
    const ch = result.current.flat!.chapters[0];
    const add = (needle: string) => {
      const s = ch.text.indexOf(needle);
      act(() =>
        result.current.addAnnotation(ch.id, s, s + needle.length, needle),
      );
    };
    add("王木匠推开店门");
    add("他点了点头。");
    add("只剩一盏灯还亮着");

    // 导入 v2 触发重锚
    act(() => result.current.importBook(structuredClone(sampleBookV2)));
    const [a, b, c] = result.current.annotations;
    expect(a.status).toBe("anchored");
    expect(b.status).toBe("ambiguous");
    expect(b.candidates).toHaveLength(2);
    expect(c.status).toBe("lost");
    // 失联批注保留原文证据
    expect(c.anchor.text).toBe("只剩一盏灯还亮着");

    // 裁决选第二个候选
    act(() => result.current.resolve(b.id, b.candidates![1]));
    const resolved = result.current.annotations.find((x) => x.id === b.id)!;
    expect(resolved.status).toBe("anchored");
    expect(resolved.anchor.start).toBe(b.candidates![1].start);

    // 删除只影响被删的一条，其余保留（重叠批注可分别删除）
    act(() => result.current.deleteAnnotation(a.id));
    expect(result.current.annotations.map((x) => x.id)).toEqual([b.id, c.id]);
  });

  it("失联批注修改备注后仍持久化，且不会被系统猜测放置", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.importBook(structuredClone(sampleBookV1)));
    const ch = result.current.flat!.chapters[0];
    const s = ch.text.indexOf("只剩一盏灯还亮着");
    act(() => result.current.addAnnotation(ch.id, s, s + 8, "证据"));
    act(() => result.current.importBook(structuredClone(sampleBookV2)));
    const lost = result.current.annotations[0];
    expect(lost.status).toBe("lost");
    act(() => result.current.updateNote(lost.id, "补充说明"));
    const stored = JSON.parse(
      localStorage.getItem("reader:annotations:sample-book")!,
    );
    expect(stored[0].note).toBe("补充说明");
    expect(stored[0].status).toBe("lost");
  });
});

describe("节选分享端到端", () => {
  it("导出节选 → 打开：独立保存与编辑，重新载入完整书稿恢复原批注", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.importBook(structuredClone(sampleBookV1)));
    const ch = result.current.flat!.chapters[0];
    const s = ch.text.indexOf("王木匠推开店门");
    act(() => result.current.addAnnotation(ch.id, s, s + 7, "原批注"));
    const originalId = result.current.annotations[0].id;
    const before = storageSnapshot();

    // 导出节选：只含选中正文与相交批注
    const pack = buildExcerpt(result.current.book!, result.current.annotations, [
      { chapterId: ch.id, start: s, end: s + 7 },
    ]);
    expect(pack.book.id).not.toBe("sample-book");
    expect(pack.annotations).toHaveLength(1);
    expect(pack.annotations[0].id).toBe(originalId);

    // 打开节选（模拟文件往返）：作为独立书稿保存
    act(() =>
      result.current.loadExcerpt(JSON.parse(JSON.stringify(pack))),
    );
    expect(result.current.book!.id).toBe(pack.book.id);
    expect(result.current.annotations).toHaveLength(1);
    // 高亮位置与节选文字对应
    const frag = result.current.flat!.chapters[0];
    const opened = result.current.annotations[0];
    expect(frag.text.slice(opened.anchor.start, opened.anchor.end)).toBe(
      opened.anchor.text,
    );
    // 原书稿的正文与批注存储未被触碰
    expect(storageSnapshot()).toEqual(before);
    // 节选另行持久化
    expect(
      localStorage.getItem(`reader:annotations:${pack.book.id}`),
    ).not.toBeNull();

    // 在节选中编辑批注：只影响节选，不影响原书稿
    act(() => result.current.updateNote(opened.id, "节选内修改"));
    expect(storageSnapshot()).toEqual(before);
    expect(
      JSON.parse(localStorage.getItem(`reader:annotations:${pack.book.id}`)!)[0]
        .note,
    ).toBe("节选内修改");

    // 重新载入完整书稿：恢复原批注，节选编辑不残留
    act(() => result.current.importBook(structuredClone(sampleBookV1)));
    expect(result.current.book!.id).toBe("sample-book");
    expect(result.current.annotations).toHaveLength(1);
    expect(result.current.annotations[0].id).toBe(originalId);
    expect(result.current.annotations[0].note).toBe("原批注");
  });

  it("非法节选文件：整体拒绝，状态与存储都不留下部分更新", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.importBook(structuredClone(sampleBookV1)));
    const ch = result.current.flat!.chapters[0];
    const s = ch.text.indexOf("王木匠推开店门");
    act(() => result.current.addAnnotation(ch.id, s, s + 7, "原批注"));
    const bookBefore = result.current.book;
    const annsBefore = result.current.annotations;
    const flatBefore = result.current.flat;
    const before = storageSnapshot();

    const garbage = [
      null,
      "not json",
      { format: "reader-excerpt" },
      // 结构合法但书稿 id 沿用原书（会覆盖原书稿存储的恶意文件）
      {
        format: "reader-excerpt",
        sourceBookId: "other",
        book: structuredClone(sampleBookV1),
        annotations: [],
      },
    ];
    for (const g of garbage) {
      expect(() => act(() => result.current.loadExcerpt(g))).toThrow();
    }
    expect(result.current.book).toBe(bookBefore);
    expect(result.current.annotations).toBe(annsBefore);
    expect(result.current.flat).toBe(flatBefore);
    expect(storageSnapshot()).toEqual(before);
  });
});
