import { describe, expect, it } from "vitest";
import {
  flattenBook,
  pointAt,
  flatToDomPoint,
  domPointToFlat,
} from "./flatten";
import type { Book } from "../types";

function book(paragraphs: Array<string | { id?: string; text: string }>): Book {
  return {
    id: "b",
    title: "t",
    chapters: [
      {
        id: "c1",
        title: "第一章",
        paragraphs: paragraphs.map((p) =>
          typeof p === "string" ? { text: p } : p,
        ),
      },
    ],
  };
}

describe("flatten", () => {
  it("段落以换行定界，段尾坐标可相互换算", () => {
    const flat = flattenBook(book(["甲二乙", "丙丁"]));
    const ch = flat.chapters[0];
    expect(ch.text).toBe("甲二乙\n丙丁");
    const p0 = ch.paragraphs[0];
    const p1 = ch.paragraphs[1];
    expect(p0.start).toBe(0);
    expect(p0.textEnd).toBe(3);
    expect(p0.end).toBe(4);
    expect(p1.start).toBe(4);
    expect(p1.end).toBe(6);
  });

  it("pointAt：段界定符位置吸附到前段尾", () => {
    const ch = flattenBook(book(["甲二乙", "丙丁"])).chapters[0];
    const pt = pointAt(ch, 3);
    expect(pt.paragraph.index).toBe(0);
    expect(pt.offset).toBe(3);
    const pt2 = pointAt(ch, 4);
    expect(pt2.paragraph.index).toBe(1);
    expect(pt2.offset).toBe(0);
  });

  it("原始 DOM 偏移与规范化扁平偏移往返一致（含空白规范化）", () => {
    const ch = flattenBook(book(["  王 木匠 ", "开店"])).chapters[0];
    const p0 = ch.paragraphs[0];
    // 原文位置 3（「木」，在多空格后）规范化后仍指向「木」
    const flat = domPointToFlat(
      p0,
      p0.norm.inv.length ? p0.raw.indexOf("木") : 0,
    );
    const back = flatToDomPoint(ch, flat);
    expect(p0.raw.slice(back.rawOffset, back.rawOffset + 1)).toBe("木");
  });
});
