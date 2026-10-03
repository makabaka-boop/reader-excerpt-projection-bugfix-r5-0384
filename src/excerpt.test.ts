import { describe, expect, it } from "vitest";
import type { Annotation, Book } from "./types";
import { flattenBook } from "./text/flatten";
import { createAnchor } from "./text/anchor";
import {
  buildExcerpt,
  ExcerptError,
  validateExcerpt,
  type ExcerptRange,
} from "./excerpt";

/** 篡改测试用：放宽字段类型以模拟损坏/非法文件。 */
type ExcerptPackageMutable = {
  annotations: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/**
 * 测试用书：
 * - c1：两段普通中文，用于不连续选区 / 跨段 / 批注裁剪；
 * - c2：p1 含前导与内部空白（规范化折叠），p2 含 emoji + 肤色修饰符
 *   （👍🏽 是 4 个 UTF-16 单元、1 个字素），用于规范化往返与字素边界。
 */
function testBook(): Book {
  return {
    id: "book-x",
    title: "测试书",
    version: "7",
    chapters: [
      {
        id: "c1",
        title: "第一章",
        paragraphs: [
          { id: "p1", text: "清晨的阳光洒在老街上，王木匠推开店门。" },
          { id: "p2", text: "他点了点头。街坊们都知道，这门手艺传了三代。" },
        ],
      },
      {
        id: "c2",
        title: "第二章",
        paragraphs: [
          { id: "q1", text: "  第二日，  一个外乡人来到\t店门前。" },
          { id: "q2", text: "他说料子走了很远的路。😀👍🏽再见。" },
        ],
      },
    ],
  };
}

function flat(book = testBook()) {
  return flattenBook(book);
}

function rangeOf(
  book: Book,
  chapterId: string,
  needle: string,
  from = 0,
): ExcerptRange {
  const ch = flattenBook(book).chapterById.get(chapterId)!;
  const start = ch.text.indexOf(needle, from);
  if (start < 0) throw new Error(`测试夹具找不到：${needle}`);
  return { chapterId, start, end: start + needle.length };
}

function annotate(
  book: Book,
  chapterId: string,
  needle: string,
  extra: Partial<Annotation> = {},
): Annotation {
  const ch = flattenBook(book).chapterById.get(chapterId)!;
  const start = ch.text.indexOf(needle);
  return {
    id: extra.id ?? `ann-${needle}`,
    note: "",
    status: "anchored",
    anchor: createAnchor(ch, start, start + needle.length),
    createdAt: 1000,
    ...extra,
  };
}

describe("buildExcerpt 正文裁剪", () => {
  it("不连续选区保持分离，选区之间的未选正文（含跨段）不进入文件", () => {
    const book = testBook();
    const pack = buildExcerpt(book, [], [
      rangeOf(book, "c1", "阳光洒在"),
      rangeOf(book, "c1", "街坊们"),
    ]);
    expect(pack.book.chapters).toHaveLength(1);
    const c1 = pack.book.chapters[0];
    // 两段选区 -> 两个彼此分离的片段段落，而不是一个大切片
    expect(c1.paragraphs.map((p) => p.text)).toEqual(["阳光洒在", "街坊们"]);
    const flatText = JSON.stringify(pack.book);
    expect(flatText).not.toContain("王木匠");
    expect(flatText).not.toContain("他点了点头");
    expect(flatText).not.toContain("传了三代");
    expect(flatText).not.toContain("第二章");
  });

  it("重叠或相邻选区合并为单个连续片段", () => {
    const book = testBook();
    const ch = flat(book).chapterById.get("c1")!;
    const a = ch.text.indexOf("清晨");
    const b = ch.text.indexOf("阳光");
    const c = ch.text.indexOf("洒在");
    const pack = buildExcerpt(book, [], [
      { chapterId: "c1", start: a, end: a + 2 }, // 清晨
      { chapterId: "c1", start: a + 2, end: b + 2 }, // 的阳光（与上一段相邻）
      { chapterId: "c1", start: b, end: c + 2 }, // 阳光洒在（与上一段重叠）
    ]);
    expect(pack.book.chapters[0].paragraphs).toHaveLength(1);
    expect(pack.book.chapters[0].paragraphs[0].text).toBe("清晨的阳光洒在");
  });

  it("跨段落选区按源段落边界切成片段，段界定符不夹在片段文字里", () => {
    const book = testBook();
    const ch = flat(book).chapterById.get("c1")!;
    const start = ch.text.indexOf("推开店门。");
    const end = ch.text.indexOf("街坊们");
    const pack = buildExcerpt(book, [], [
      { chapterId: "c1", start, end },
    ]);
    const paras = pack.book.chapters[0].paragraphs.map((p) => p.text);
    expect(paras).toEqual(["推开店门。", "他点了点头。"]);
    expect(paras.every((t) => !t.includes("\n"))).toBe(true);
  });

  it("规范化往返：片段重新扁平化后文字逐字不变（内部折叠空格保留）", () => {
    const book = testBook();
    const pack = buildExcerpt(book, [], [
      rangeOf(book, "c2", "一个外乡人来到 店门前"),
    ]);
    const text = pack.book.chapters[0].paragraphs[0].text;
    expect(text).toBe("一个外乡人来到 店门前");
    // 再扁平化一次（模拟打开文件）文字必须完全一致
    const reflat = flattenBook(pack.book).chapters[0];
    expect(reflat.text).toBe(text);

    // 落在折叠空格上的端点自动收紧，不保留会被二次规范化裁掉的边空
    const ch2 = flat(book).chapterById.get("c2")!;
    const s = ch2.text.indexOf(" 店门前。");
    const pack2 = buildExcerpt(book, [], [
      { chapterId: "c2", start: s, end: s + " 店门前。".length },
    ]);
    expect(pack2.book.chapters[0].paragraphs[0].text).toBe("店门前。");
  });

  it("只覆盖折叠空格的选区不产生片段；全部无效时抛出而非生成空文件", () => {
    const book = testBook();
    const ch = flat(book).chapterById.get("c2")!;
    const s = ch.text.indexOf("， 一") + 1; // 折叠出来的那个空格
    expect(() =>
      buildExcerpt(book, [], [{ chapterId: "c2", start: s, end: s + 1 }]),
    ).toThrow(ExcerptError);
  });

  it("端点在字素中间（代理对/肤色修饰符）时向内吸附到完整字素边界", () => {
    const book = testBook();
    const ch = flat(book).chapterById.get("c2")!;
    const wave = ch.text.indexOf("👍🏽");
    // 起点切在 👍 与肤色修饰符 🏽 之间：向上吸附到整个字素之后，
    // 区间只保留后面的「再」，半个 emoji 绝不进入分享文件。
    const pack = buildExcerpt(book, [], [
      { chapterId: "c2", start: wave + 2, end: wave + 5 }, // 👍[|🏽]再|
    ]);
    const text = pack.book.chapters[0].paragraphs[0].text;
    expect(text).toBe("再");
    expect(text).not.toContain("👍");
    expect(text).not.toContain("🏽");
    // 终点切在字素中间：向下吸附到字素之前，只留下前面的 😀
    const pack2 = buildExcerpt(book, [], [
      { chapterId: "c2", start: wave - 2, end: wave + 3 }, // 😀|👍[🏽|
    ]);
    expect(pack2.book.chapters[0].paragraphs[0].text).toBe("😀");
    // 吸附后的节选必须能通过严格校验
    expect(() => validateExcerpt(structuredClone(pack))).not.toThrow();
    expect(() => validateExcerpt(structuredClone(pack2))).not.toThrow();
  });

  it("他章/越界/塌缩/非数选区被丢弃；仍有有效选区时正常导出", () => {
    const book = testBook();
    const ch = flat(book).chapterById.get("c1")!;
    const pack = buildExcerpt(book, [], [
      { chapterId: "ghost", start: 0, end: 5 },
      { chapterId: "c1", start: 9999, end: 10000 },
      { chapterId: "c1", start: 3, end: 3 },
      { chapterId: "c1", start: NaN, end: 5 },
      rangeOf(book, "c1", "阳光洒在"),
    ]);
    expect(pack.book.chapters[0].paragraphs[0].text).toBe("阳光洒在");
    expect(ch.text.length).toBeGreaterThan(0);
  });

  it("跨章节选区各自成章、保持原章节顺序；未选章节不出现", () => {
    const book = testBook();
    const pack = buildExcerpt(book, [], [
      rangeOf(book, "c2", "料子"),
      rangeOf(book, "c1", "阳光"),
    ]);
    expect(pack.book.chapters.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("buildExcerpt 批注过滤与裁剪", () => {
  it("只导出与选区相交的、已定位且坐标有效的批注", () => {
    const book = testBook();
    const inside = annotate(book, "c1", "阳光洒在");
    const crossing = annotate(book, "c1", "王木匠推开店门");
    const outside = annotate(book, "c1", "传了三代");
    const otherChapter = annotate(book, "c2", "料子");
    const ambiguous: Annotation = {
      ...annotate(book, "c1", "他点了点头", { id: "amb" }),
      status: "ambiguous",
      candidates: [
        { chapterId: "c1", start: 0, end: 1, score: 0 },
      ],
    };
    const lost: Annotation = {
      ...annotate(book, "c1", "街坊们", { id: "lost" }),
      status: "lost",
    };
    // 旧锚点：状态仍是 anchored，但坐标与当前正文不符
    const stale = annotate(book, "c1", "阳光洒在", { id: "stale" });
    stale.anchor = { ...stale.anchor, text: "被删改的旧文字", end: stale.anchor.start + 1 };

    const pack = buildExcerpt(
      book,
      [inside, crossing, outside, otherChapter, ambiguous, lost, stale],
      [rangeOf(book, "c1", "阳光洒在"), rangeOf(book, "c1", "匠推开店门")],
    );
    const ids = pack.annotations.map((a) => a.id);
    expect(ids).toEqual([inside.id, crossing.id]);

    const serialized = JSON.stringify(pack);
    // 待裁决/失联证据、他章与未选文字一律不泄漏
    expect(serialized).not.toContain("他点了点头");
    expect(serialized).not.toContain("街坊们");
    expect(serialized).not.toContain("传了三代");
    expect(serialized).not.toContain("料子");
    expect(serialized).not.toContain("被删改的旧文字");
    expect(serialized).not.toContain("candidate");
  });

  it("跨边界批注裁剪到可见文字：位置、身份、锚点内容与节选一致", () => {
    const book = testBook();
    // 批注覆盖「清晨的阳光……王木匠」整个大跨度
    const ch = flat(book).chapterById.get("c1")!;
    const s = ch.text.indexOf("清晨的阳光");
    const e = ch.text.indexOf("推开店门") + "推开店门".length;
    const ann: Annotation = {
      id: "cross",
      note: "边界批注",
      status: "anchored",
      anchor: createAnchor(ch, s, e),
      createdAt: 42,
    };
    // 只分享两端，中间「洒在老街上，王木匠」之外的内容不分享
    const pack = buildExcerpt(book, [ann], [
      rangeOf(book, "c1", "清晨的阳光"),
      rangeOf(book, "c1", "王木匠推开店门"),
    ]);
    expect(pack.annotations).toHaveLength(1);
    const got = pack.annotations[0];
    expect(got.id).toBe("cross"); // 身份不变，且不重复
    expect(got.status).toBe("anchored");

    const exCh = flattenBook(pack.book).chapters[0];
    // 节选文字 = 两个分离片段
    expect(exCh.paragraphs.map((p) => p.norm.text)).toEqual([
      "清晨的阳光",
      "王木匠推开店门",
    ]);
    // 锚点覆盖两个片段的可见部分，坐标处文字必须逐字吻合
    expect(got.anchor.start).toBe(0);
    expect(got.anchor.end).toBe(exCh.text.length);
    expect(got.anchor.text).toBe("清晨的阳光\n王木匠推开店门");
    // 上下文只来自已分享文字，不含中间未选证据
    expect(got.anchor.prefix).toBe("");
    expect(got.anchor.suffix).toBe("");
    expect(JSON.stringify(got.anchor)).not.toContain("老街");

    // 严格校验通过（位置/身份/导出内容一致）
    const checked = validateExcerpt(structuredClone(pack));
    expect(checked.annotations[0].anchor).toEqual(got.anchor);
  });

  it("批注只在片段边缘相交时裁剪到相交子串", () => {
    const book = testBook();
    const ann = annotate(book, "c1", "王木匠推开店门");
    const pack = buildExcerpt(book, [ann], [rangeOf(book, "c1", "推开店门")]);
    expect(pack.annotations).toHaveLength(1);
    const got = pack.annotations[0];
    const exText = flattenBook(pack.book).chapters[0].text;
    expect(exText.slice(got.anchor.start, got.anchor.end)).toBe("推开店门");
  });

  it("同一批注被多个选区命中只出现一次（不重复导出）", () => {
    const book = testBook();
    const ch = flat(book).chapterById.get("c1")!;
    const s = ch.text.indexOf("清晨");
    const e = ch.text.indexOf("王木匠") + 3;
    const ann: Annotation = {
      id: "once",
      note: "",
      status: "anchored",
      anchor: createAnchor(ch, s, e),
      createdAt: 1,
    };
    const pack = buildExcerpt(book, [ann], [
      rangeOf(book, "c1", "清晨"),
      rangeOf(book, "c1", "王木匠"),
    ]);
    expect(pack.annotations.map((a) => a.id)).toEqual(["once"]);
  });
});

describe("节选文件独立性", () => {
  it("节选拥有独立 id（与原书不同且稳定），并记录来源", () => {
    const book = testBook();
    const ranges = [rangeOf(book, "c1", "阳光")];
    const p1 = buildExcerpt(book, [], ranges);
    const p2 = buildExcerpt(testBook(), [], ranges);
    expect(p1.book.id).not.toBe(book.id);
    expect(p1.book.id.startsWith("excerpt:book-x:")).toBe(true);
    expect(p1.book.id).toBe(p2.book.id); // 同书同选区 -> 稳定 id（覆盖同一存储槽）
    expect(p1.source).toEqual({ id: "book-x", title: "测试书", version: "7" });
    expect(p1.format).toBe("reader-excerpt");
    expect(p1.version).toBe(1);
  });

  it("在节选中继续编辑产生的锚点仍然只含节选文字", () => {
    const book = testBook();
    const pack = buildExcerpt(book, [], [rangeOf(book, "c1", "阳光洒在")]);
    // 校对员在节选中新增批注：锚点基于节选坐标，节选文字之外不可能被引用
    const exCh = flattenBook(pack.book).chapters[0];
    const fresh = createAnchor(exCh, 0, 2);
    expect(fresh.text).toBe("阳光");
    expect(fresh.prefix).toBe("");
  });
});

describe("validateExcerpt 严格校验", () => {
  const good = () =>
    buildExcerpt(testBook(), [annotate(testBook(), "c1", "阳光洒在")], [
      rangeOf(testBook(), "c1", "阳光洒在老街"),
    ]);

  it("合法文件通过并返回深拷贝", () => {
    const pack = good();
    const checked = validateExcerpt(structuredClone(pack));
    expect(checked).toEqual(pack);
  });

  it("拒绝格式/版本错误", () => {
    const pack = good();
    expect(() => validateExcerpt(null)).toThrow(ExcerptError);
    expect(() => validateExcerpt("x")).toThrow(ExcerptError);
    expect(() => validateExcerpt({ ...pack, format: "other" })).toThrow();
    expect(() => validateExcerpt({ ...pack, version: 2 })).toThrow();
  });

  it("拒绝结构不合法的书稿部分", () => {
    const pack = good();
    const broken = structuredClone(pack);
    broken.book.chapters = [];
    expect(() => validateExcerpt(broken)).toThrow(ExcerptError);
    const dup = structuredClone(pack);
    dup.book.chapters.push(structuredClone(dup.book.chapters[0]));
    expect(() => validateExcerpt(dup)).toThrow(ExcerptError);
  });

  it("拒绝失联/待裁决批注与候选证据", () => {
    const pack = good();
    const lost = structuredClone(pack);
    lost.annotations[0].status = "lost";
    expect(() => validateExcerpt(lost)).toThrow(/证据/);
    const amb = structuredClone(pack);
    amb.annotations[0].status = "ambiguous";
    amb.annotations[0].candidates = [];
    expect(() => validateExcerpt(amb)).toThrow();
  });

  it("拒绝坐标越界、塌缩、非整数、落在段界上", () => {
    const pack = good();
    const len = flattenBook(pack.book).chapters[0].text.length;
    const mutate = (fn: (a: any) => void) => {
      const p = structuredClone(pack);
      fn(p.annotations[0]);
      // 篡改后 anchor.text 等也会不一致；这里只断言一律拒绝
      expect(() => validateExcerpt(p)).toThrow(ExcerptError);
    };
    mutate((a) => (a.anchor.end = len + 5));
    mutate((a) => (a.anchor.start = a.anchor.end));
    mutate((a) => (a.anchor.start = 1.5));
    mutate((a) => {
      a.anchor.chapterId = "missing";
    });
  });

  it("拒绝锚点文字与节选正文不一致（旧锚点/损坏文件）", () => {
    const pack = good();
    const tampered = structuredClone(pack);
    tampered.annotations[0].anchor.text = "不存在的文字\n阳光洒在老街";
    expect(() => validateExcerpt(tampered)).toThrow(/不一致/);
  });

  it("拒绝夹带未分享上下文证据（prefix/suffix 与节选不符）", () => {
    const pack = good();
    const smuggled = structuredClone(pack);
    smuggled.annotations[0].anchor.prefix = "【未分享的秘密原文】";
    expect(() => validateExcerpt(smuggled)).toThrow(/上下文/);
  });

  it("拒绝重复批注 id 与字段缺失", () => {
    const pack = good();
    const dup = structuredClone(pack);
    dup.annotations.push(structuredClone(dup.annotations[0]));
    expect(() => validateExcerpt(dup)).toThrow(/重复/);
    const noId = structuredClone(pack) as unknown as ExcerptPackageMutable;
    delete noId.annotations[0].id;
    expect(() => validateExcerpt(noId)).toThrow();
    const badNote = structuredClone(pack) as unknown as ExcerptPackageMutable;
    badNote.annotations[0].note = 123;
    expect(() => validateExcerpt(badNote)).toThrow();
  });

  it("备注修改不影响校验（节选内继续编辑是合法的）", () => {
    const pack = good();
    pack.annotations[0].note = "校对员的新意见";
    expect(() => validateExcerpt(structuredClone(pack))).not.toThrow();
  });
});
