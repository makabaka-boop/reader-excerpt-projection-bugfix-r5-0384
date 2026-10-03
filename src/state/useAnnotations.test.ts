// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAnnotations } from "./useAnnotations";
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
});
