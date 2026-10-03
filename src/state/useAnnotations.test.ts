// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAnnotations } from "./useAnnotations";
import { buildExcerpt, ExcerptError } from "../excerpt";
import { createAnchor } from "../text/anchor";
import type { Annotation } from "../types";
import { sampleBookV1, sampleBookV2 } from "../samples";

beforeEach(() => {
  localStorage.clear();
});

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

  it("打开节选：独立作用域保存，不覆盖原书稿；重新载入原书读不到节选批注", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.importBook(structuredClone(sampleBookV1)));
    const ch = result.current.flat!.chapters[0];
    const wang = ch.text.indexOf("王木匠");
    act(() =>
      result.current.addAnnotation(ch.id, wang, wang + 7, "原书批注"),
    );
    const originalAnn = result.current.annotations[0];

    // 构造一个只含「王木匠推开店门」附近文字的节选
    const s = ch.text.indexOf("王木匠推开店门");
    const pack = buildExcerpt(sampleBookV1, result.current.annotations, [
      { chapterId: ch.id, start: s, end: s + 7 },
    ]);
    expect(pack.book.id).not.toBe(sampleBookV1.id);
    expect(pack.annotations).toHaveLength(1);
    expect(pack.annotations[0].id).toBe(originalAnn.id);
    expect(pack.annotations[0].anchor.text).toBe("王木匠推开店门");

    // 打开节选
    act(() => result.current.loadExcerpt(structuredClone(pack)));
    expect(result.current.book!.id).toBe(pack.book.id);
    expect(result.current.scope).toBe("excerpt");
    expect(result.current.annotations).toHaveLength(1);

    // 节选落在独立存储槽，原书稿正文与批注原样保留
    const originalStored = JSON.parse(
      localStorage.getItem("reader:book:sample-book")!,
    );
    expect(originalStored.title).toBe(sampleBookV1.title);
    const originalAnns = JSON.parse(
      localStorage.getItem("reader:annotations:sample-book")!,
    );
    expect(originalAnns).toHaveLength(1);
    expect(originalAnns[0].note).toBe("原书批注");
    expect(localStorage.getItem("reader-excerpt:book:" + pack.book.id)).not.toBe(
      null, // 节选书存在自己的前缀下
    );

    // 在节选中新增批注，只写入节选作用域
    const exCh = result.current.flat!.chapters[0];
    act(() =>
      result.current.addAnnotation(exCh.id, 0, 3, "校对员新批注"),
    );
    const exStored = JSON.parse(
      localStorage.getItem("reader-excerpt:annotations:" + pack.book.id)!,
    );
    expect(exStored.map((a: Annotation) => a.note).sort()).toEqual(
      ["原书批注", "校对员新批注"].sort(),
    );
    // 原书稿批注数量不变
    expect(
      JSON.parse(localStorage.getItem("reader:annotations:sample-book")!),
    ).toHaveLength(1);

    // 重新载入完整书稿：读不到节选里新增的批注，原书批注仍在
    act(() => result.current.importBook(structuredClone(sampleBookV1)));
    expect(result.current.scope).toBe("book");
    expect(result.current.annotations).toHaveLength(1);
    expect(result.current.annotations[0].note).toBe("原书批注");
  });

  it("非法节选文件：拒绝打开且不产生任何部分更新（状态与存储均不变）", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.importBook(structuredClone(sampleBookV1)));
    const before = {
      bookId: result.current.book!.id,
      count: result.current.annotations.length,
      storeKeys: Object.keys(localStorage).sort(),
    };

    const ch = result.current.flat!.chapters[0];
    const s = ch.text.indexOf("王木匠");
    const pack = buildExcerpt(sampleBookV1, [], [
      { chapterId: ch.id, start: s, end: s + 3 },
    ]);
    const bad = structuredClone(pack);
    bad.annotations = [{ ...pack.book } as unknown as Annotation]; // 完全非法的批注
    expect(() => result.current.loadExcerpt(bad)).toThrow(ExcerptError);

    // 当前状态未变
    expect(result.current.book!.id).toBe(before.bookId);
    expect(result.current.annotations).toHaveLength(before.count);
    expect(result.current.scope).toBe("book");
    // 存储未新增任何节选键
    expect(Object.keys(localStorage).sort()).toEqual(before.storeKeys);

    // 夹带证据（篡改 prefix）同样被拒
    const smuggled = structuredClone(pack);
    const anchor = createAnchor(ch, s, s + 3);
    smuggled.annotations = [
      {
        id: "x1",
        note: "",
        status: "anchored",
        createdAt: 1,
        anchor: { ...anchor, prefix: "未分享的秘密上下文" },
      },
    ];
    expect(() => result.current.loadExcerpt(smuggled)).toThrow(ExcerptError);
    expect(result.current.book!.id).toBe(before.bookId);
  });
});
