import { describe, expect, it } from "vitest";
import type { Annotation, Book } from "./types";
import { flattenBook } from "./text/flatten";
import { createAnchor } from "./text/anchor";
import {
  buildExcerpt,
  validateExcerpt,
  normalizeRanges,
  ExcerptError,
  EXCERPT_ID_MARK,
  type ExcerptPackage,
  type ExcerptRange,
} from "./excerpt";

/**
 * 测试书稿：
 * - c1 三段，含跨段、重复上下文；
 * - c2 含前导/连续空白与全角字符（规范化）；
 * - c3 含 emoji 字素簇与组合字符（字素边界）。
 */
function book(): Book {
  return {
    id: "src-book",
    title: "原书",
    version: "1",
    chapters: [
      {
        id: "c1",
        title: "第一章",
        paragraphs: [
          { id: "p1", text: "清晨的阳光洒在老街上，王木匠推开店门。" },
          { id: "p2", text: "他点了点头。街坊们都知道这门手艺。" },
          { id: "p3", text: "暮色四合时，老街上只剩一盏灯还亮着。" },
        ],
      },
      {
        id: "c2",
        title: "第二章",
        paragraphs: [
          { id: "q1", text: "   ＸＹＺ　第二日，  一个外乡人来到店门前。  " },
        ],
      },
      {
        id: "c3",
        title: "第三章",
        paragraphs: [{ id: "e1", text: "甲👨‍👩‍👧乙 xéy 丙" }],
      },
    ],
  };
}

function annAt(
  b: Book,
  chapterId: string,
  start: number,
  end: number,
  note = "",
  id = `ann-${note || "x"}-${start}`,
): Annotation {
  const ch = flattenBook(b).chapterById.get(chapterId)!;
  return {
    id,
    note,
    status: "anchored",
    anchor: createAnchor(ch, start, end),
    createdAt: 1,
  };
}

/** c1 扁平文字中 needle 的区间。 */
function span(b: Book, needle: string, chapterId = "c1"): ExcerptRange {
  const ch = flattenBook(b).chapterById.get(chapterId)!;
  const s = ch.text.indexOf(needle);
  if (s < 0) throw new Error(`找不到 ${needle}`);
  return { chapterId, start: s, end: s + needle.length };
}

describe("buildExcerpt：选区与正文", () => {
  it("不连续选区保持分离，不夹带两处之间的未选正文", () => {
    const b = book();
    const pack = buildExcerpt(b, [], [
      span(b, "清晨的阳光"),
      span(b, "王木匠推开店门"),
    ]);
    expect(pack.book.chapters).toHaveLength(2);
    const flat = flattenBook(pack.book);
    expect(flat.chapters[0].text).toBe("清晨的阳光");
    expect(flat.chapters[1].text).toBe("王木匠推开店门");
    // 两处之间的「洒在老街上，」未入选，不得出现在文件的任何角落
    expect(JSON.stringify(pack)).not.toContain("洒在");
  });

  it("重叠或相邻选区先合并：正文不重复、批注不重复", () => {
    const b = book();
    const ch = flattenBook(b).chapterById.get("c1")!;
    const r1: ExcerptRange = { chapterId: "c1", start: 0, end: 6 };
    const r2: ExcerptRange = { chapterId: "c1", start: 4, end: 12 };
    const ann = annAt(b, "c1", 4, 6, "重叠处批注");
    const pack = buildExcerpt(b, [ann], [r1, r2]);
    expect(pack.book.chapters).toHaveLength(1);
    expect(flattenBook(pack.book).chapters[0].text).toBe(ch.text.slice(0, 12));
    expect(pack.annotations).toHaveLength(1);

    // 首尾相接也合并
    const adjacent = buildExcerpt(
      b,
      [],
      [
        { chapterId: "c1", start: 0, end: 5 },
        { chapterId: "c1", start: 5, end: 11 },
      ],
    );
    expect(adjacent.book.chapters).toHaveLength(1);
    expect(flattenBook(adjacent.book).chapters[0].text).toBe(
      ch.text.slice(0, 11),
    );
  });

  it("仅隔段界定符的选区不合并（保持分离）", () => {
    const b = book();
    const ch = flattenBook(b).chapterById.get("c1")!;
    const p1End = ch.paragraphs[0].textEnd;
    const p2Start = ch.paragraphs[1].start;
    const pack = buildExcerpt(b, [], [
      { chapterId: "c1", start: 0, end: p1End },
      { chapterId: "c1", start: p2Start, end: p2Start + 5 },
    ]);
    expect(pack.book.chapters).toHaveLength(2);
  });

  it("跨段落选区：切片按段拆回，重新扁平化后逐字一致", () => {
    const b = book();
    const ch = flattenBook(b).chapterById.get("c1")!;
    const start = ch.text.indexOf("王木匠");
    const end = ch.text.indexOf("街坊们") + 3;
    const pack = buildExcerpt(b, [], [{ chapterId: "c1", start, end }]);
    const frag = flattenBook(pack.book).chapters[0];
    expect(frag.text).toBe(ch.text.slice(start, end));
    expect(frag.text).toContain("\n");
    expect(pack.book.chapters[0].paragraphs.length).toBe(2);
    // 打开校验必须通过（坐标往返一致）
    expect(() => validateExcerpt(pack)).not.toThrow();
  });

  it("文字规范化：含空白折叠与全角字符的选区，重新规范化是恒等变换", () => {
    const b = book();
    const ch = flattenBook(b).chapterById.get("c2")!;
    // 规范化后为「XYZ 第二日， 一个外乡人来到店门前。」
    expect(ch.text.startsWith("XYZ 第二日，")).toBe(true);
    const start = ch.text.indexOf("第二日");
    const end = ch.text.indexOf("外乡人") + 3;
    const pack = buildExcerpt(b, [], [{ chapterId: "c2", start, end }]);
    const frag = flattenBook(pack.book).chapters[0];
    expect(frag.text).toBe(ch.text.slice(start, end));
    expect(() => validateExcerpt(pack)).not.toThrow();
  });

  it("端点向外吸附到完整字素边界（emoji 字素簇 / 组合字符）", () => {
    const b = book();
    const ch = flattenBook(b).chapterById.get("c3")!;
    const emojiStart = ch.text.indexOf("👨");
    const emojiEnd = ch.text.indexOf("乙");
    // 选区完全落在字素簇内部 → 外扩为整个簇
    const pack = buildExcerpt(b, [], [
      { chapterId: "c3", start: emojiStart + 2, end: emojiStart + 4 },
    ]);
    expect(flattenBook(pack.book).chapters[0].text).toBe("👨‍👩‍👧");
    expect(emojiEnd).toBe(emojiStart + "👨‍👩‍👧".length);

    // 组合字符 é = e + U+0301：切在中间同样外扩
    const eStart = ch.text.indexOf("e");
    const pack2 = buildExcerpt(b, [], [
      { chapterId: "c3", start: eStart + 1, end: eStart + 2 },
    ]);
    expect(flattenBook(pack2.book).chapters[0].text).toBe("é");
  });

  it("空白边缘被裁掉；纯空白选区被丢弃；没有任何有效选区时抛错", () => {
    const b = book();
    const ch = flattenBook(b).chapterById.get("c2")!;
    // 「XYZ 第二日」中 XYZ 后的空格起于 index 3
    expect(ch.text[3]).toBe(" ");
    const pack = buildExcerpt(b, [], [{ chapterId: "c2", start: 3, end: 7 }]);
    expect(flattenBook(pack.book).chapters[0].text).toBe("第二日");

    expect(() =>
      buildExcerpt(b, [], [{ chapterId: "c2", start: 3, end: 4 }]),
    ).toThrow(ExcerptError);
    expect(() => buildExcerpt(b, [], [])).toThrow(ExcerptError);
    // 未知章节的选区被跳过
    expect(() =>
      buildExcerpt(b, [], [{ chapterId: "nope", start: 0, end: 3 }]),
    ).toThrow(ExcerptError);
  });

  it("normalizeRanges：合并、排序、裁剪、字素吸附", () => {
    const b = book();
    const ch = flattenBook(b).chapterById.get("c1")!;
    expect(
      normalizeRanges(ch, [
        { chapterId: "c1", start: 8, end: 12 },
        { chapterId: "c1", start: 2, end: 8 },
        { chapterId: "c1", start: 30, end: 25 }, // 反向
        { chapterId: "c1", start: Number.NaN, end: 3 }, // 非法
      ]),
    ).toEqual([
      { start: 2, end: 12 },
      { start: 25, end: 30 },
    ]);
  });
});

describe("buildExcerpt：批注裁剪", () => {
  it("相交的已定位批注：坐标重映射到片段坐标系，高亮与文字对应", () => {
    const b = book();
    const range = span(b, "王木匠推开店门");
    const ann = annAt(
      b,
      "c1",
      span(b, "推开店门").start,
      span(b, "推开店门").end,
      "第一批注",
      "a1",
    );
    const pack = buildExcerpt(b, [ann], [range]);
    expect(pack.annotations).toHaveLength(1);
    const out = pack.annotations[0];
    expect(out.id).toBe("a1"); // 身份保持
    expect(out.note).toBe("第一批注");
    expect(out.anchor.chapterId).toBe(pack.book.chapters[0].id);
    const frag = flattenBook(pack.book).chapters[0];
    // 重新打开后坐标处文字必须等于锚点文字（高亮不漂移）
    expect(frag.text.slice(out.anchor.start, out.anchor.end)).toBe(
      out.anchor.text,
    );
    expect(out.anchor.text).toBe("推开店门");
    // 上下文只来自可见文字
    expect(out.anchor.prefix).toBe("王木匠");
    expect(out.anchor.suffix).toBe(""); // 片段到此为止
  });

  it("上下文不越界：不得包含选区之外的原文", () => {
    const b = book();
    const range = span(b, "王木匠推开店门");
    const ann = annAt(
      b,
      "c1",
      span(b, "推开店门").start,
      span(b, "推开店门").end,
      "",
      "a1",
    );
    // 原锚点的 prefix 含「…洒在老街上，王木匠」，节选必须截断到选区内
    expect(ann.anchor.prefix).toContain("洒在");
    const pack = buildExcerpt(b, [ann], [range]);
    expect(JSON.stringify(pack.annotations)).not.toContain("洒在");
  });

  it("跨边界批注：按各片段可见部分截断，身份与导出内容一致", () => {
    const b = book();
    const ch = flattenBook(b).chapterById.get("c1")!;
    // 批注横跨两个选区之间的未选空隙
    const start = ch.text.indexOf("阳光");
    const end = ch.text.indexOf("王木") + 2;
    const ann = annAt(b, "c1", start, end, "跨边界", "cross1");
    const pack = buildExcerpt(b, [ann], [
      span(b, "清晨的阳光"),
      span(b, "王木匠推开店门"),
    ]);
    expect(pack.annotations).toHaveLength(2);
    const [first, second] = pack.annotations;
    // 第一片段保留原身份，第二片段派生唯一 id（不重复）
    expect(first.id).toBe("cross1");
    expect(second.id).not.toBe("cross1");
    expect(new Set(pack.annotations.map((a) => a.id)).size).toBe(2);
    // 各片段只显示可见部分，且与坐标一致
    const flat = flattenBook(pack.book);
    for (const a of pack.annotations) {
      const frag = flat.chapterById.get(a.anchor.chapterId)!;
      expect(frag.text.slice(a.anchor.start, a.anchor.end)).toBe(a.anchor.text);
    }
    expect(first.anchor.text).toBe("阳光");
    expect(second.anchor.text).toBe("王木");
    // 空隙中的原文不出现在任何锚点证据里
    expect(JSON.stringify(pack.annotations)).not.toContain("洒在");
  });

  it("单侧越界的批注被截断到选区边缘", () => {
    const b = book();
    const ch = flattenBook(b).chapterById.get("c1")!;
    const start = ch.text.indexOf("上，王木匠推"); // 选区开始之前
    const end = ch.text.indexOf("推开店门") + 2;
    const ann = annAt(b, "c1", start, end, "", "edge1");
    const pack = buildExcerpt(b, [ann], [span(b, "王木匠推开店门")]);
    expect(pack.annotations).toHaveLength(1);
    expect(pack.annotations[0].anchor.text).toBe("王木匠推开");
    expect(pack.annotations[0].anchor.prefix).toBe("");
  });

  it("待裁决/失联批注及其证据一律不进入分享文件", () => {
    const b = book();
    const anchored = annAt(b, "c1", span(b, "推开店门").start, span(b, "推开店门").end, "", "ok");
    const ambiguous: Annotation = {
      ...annAt(b, "c1", span(b, "他点了点头").start, span(b, "他点了点头").end, "待裁决秘密", "amb"),
      status: "ambiguous",
      candidates: [{ chapterId: "c1", start: 0, end: 5, score: 3 }],
    };
    const lost: Annotation = {
      ...annAt(b, "c1", 0, 5, "失联秘密", "lost"),
      status: "lost",
      anchor: { ...anchored.anchor, text: "已被删除的秘密文字" },
    };
    const pack = buildExcerpt(
      b,
      [anchored, ambiguous, lost],
      [span(b, "王木匠推开店门"), span(b, "他点了点头")],
    );
    expect(pack.annotations.map((a) => a.id)).toEqual(["ok"]);
    const json = JSON.stringify(pack);
    expect(json).not.toContain("待裁决秘密");
    expect(json).not.toContain("失联秘密");
    expect(json).not.toContain("已被删除的秘密文字");
    expect(json).not.toContain("candidates");
  });

  it("旧锚点（坐标与文字不符）不导出，绝不猜测落点", () => {
    const b = book();
    const ann = annAt(b, "c1", span(b, "推开店门").start, span(b, "推开店门").end, "", "stale");
    ann.anchor.text = "被篡改的锚点文字";
    const pack = buildExcerpt(b, [ann], [span(b, "王木匠推开店门")]);
    expect(pack.annotations).toHaveLength(0);
  });

  it("节选书稿使用带节选标记的全新 id，并记录原书 id", () => {
    const b = book();
    const pack = buildExcerpt(b, [], [span(b, "清晨的阳光")]);
    expect(pack.sourceBookId).toBe("src-book");
    expect(pack.book.id).not.toBe("src-book");
    expect(pack.book.id).toContain(EXCERPT_ID_MARK);
    expect(pack.book.id.startsWith("src-book")).toBe(true);
    // 两次导出 id 不同（不同节选互不覆盖）
    const pack2 = buildExcerpt(b, [], [span(b, "清晨的阳光")]);
    expect(pack2.book.id).not.toBe(pack.book.id);
  });
});

describe("validateExcerpt", () => {
  function validPack(): ExcerptPackage {
    const b = book();
    const ann = annAt(
      b,
      "c1",
      span(b, "推开店门").start,
      span(b, "推开店门").end,
      "备注",
      "a1",
    );
    return buildExcerpt(b, [ann], [span(b, "王木匠推开店门")]);
  }

  it("接受 buildExcerpt 的产物（JSON 往返后仍有效）", () => {
    const pack = validPack();
    const checked = validateExcerpt(JSON.parse(JSON.stringify(pack)));
    expect(checked.book.id).toBe(pack.book.id);
    expect(checked.annotations).toHaveLength(1);
    expect(checked.annotations[0].id).toBe("a1");
    expect(checked.sourceBookId).toBe("src-book");
  });

  it("拒绝各种非法文件", () => {
    const good = validPack();
    const cases: Array<[string, unknown]> = [
      ["null", null],
      ["非对象", "text"],
      ["缺 format", { ...good, format: undefined }],
      ["format 错误", { ...good, format: "full-book" }],
      ["缺 sourceBookId", { ...good, sourceBookId: undefined }],
      ["书稿非法", { ...good, book: { id: "x:excerpt:1" } }],
      [
        "书稿 id 无节选标记",
        { ...good, book: { ...good.book, id: "src-book" } },
      ],
      [
        "书稿 id 与原书相同",
        {
          ...good,
          sourceBookId: "src-book:excerpt:1",
          book: { ...good.book, id: "src-book:excerpt:1" },
        },
      ],
      ["annotations 非数组", { ...good, annotations: {} }],
      [
        "批注状态非 anchored",
        {
          ...good,
          annotations: [{ ...good.annotations[0], status: "lost" }],
        },
      ],
      [
        "批注携带候选证据",
        {
          ...good,
          annotations: [
            { ...good.annotations[0], candidates: [{ chapterId: "x", start: 0, end: 1, score: 1 }] },
          ],
        },
      ],
      [
        "批注 id 重复",
        { ...good, annotations: [good.annotations[0], good.annotations[0]] },
      ],
      [
        "锚点指向缺失章节",
        {
          ...good,
          annotations: [
            {
              ...good.annotations[0],
              anchor: { ...good.annotations[0].anchor, chapterId: "ghost" },
            },
          ],
        },
      ],
      [
        "锚点坐标越界",
        {
          ...good,
          annotations: [
            {
              ...good.annotations[0],
              anchor: { ...good.annotations[0].anchor, end: 9999 },
            },
          ],
        },
      ],
      [
        "锚点文字与坐标不符",
        {
          ...good,
          annotations: [
            {
              ...good.annotations[0],
              anchor: { ...good.annotations[0].anchor, text: "不符的文字" },
            },
          ],
        },
      ],
      [
        "上下文夹带未分享原文",
        {
          ...good,
          annotations: [
            {
              ...good.annotations[0],
              anchor: {
                ...good.annotations[0].anchor,
                prefix: `未分享内容${good.annotations[0].anchor.prefix}`,
              },
            },
          ],
        },
      ],
      [
        "note 缺失",
        {
          ...good,
          annotations: [{ ...good.annotations[0], note: undefined }],
        },
      ],
    ];
    for (const [name, input] of cases) {
      expect(() => validateExcerpt(input), name).toThrow(ExcerptError);
    }
  });

  it("校验失败时不返回任何部分内容（整体拒绝）", () => {
    const good = validPack();
    const mixed = {
      ...good,
      annotations: [
        good.annotations[0],
        { ...good.annotations[0], id: "bad", status: "ambiguous" },
      ],
    };
    expect(() => validateExcerpt(mixed)).toThrow(ExcerptError);
  });
});
