import { describe, expect, it } from "vitest";
import type { Annotation, Book, Candidate } from "../types";
import { flattenBook } from "./flatten";
import {
  createAnchor,
  reanchorAll,
  reanchorOne,
  resolveCandidate,
  candidateSnippet,
} from "./anchor";
import { ensureAnchored } from "./validate";

function v1(): Book {
  return {
    id: "b",
    title: "t",
    version: "1",
    chapters: [
      {
        id: "c1",
        title: "第一章",
        paragraphs: [
          {
            id: "p1",
            text: "清晨的阳光洒在老街上，王木匠推开店门，开始了一天的活计。",
          },
          { id: "p2", text: "他点了点头。街坊们都知道，这门手艺传了三代。" },
          { id: "p3", text: "他点了点头。锯末飞扬之中，时光仿佛慢了下来。" },
          { id: "p4", text: "暮色四合时，老街上只剩一盏灯还亮着。" },
        ],
      },
    ],
  };
}

function v2(): Book {
  return {
    id: "b",
    title: "t",
    version: "2",
    chapters: [
      {
        id: "c1",
        title: "第一章",
        paragraphs: [
          { id: "p1", text: "清晨的阳光洒在老街上，" },
          { id: "p1b", text: "王木匠推开店门，开始了一天的活计。" },
          {
            id: "p2",
            text: "他点了点头。街坊们都知道，这门手艺在镇上足足传了三代。",
          },
          { id: "p3", text: "他点了点头。锯末飞扬之中，时光仿佛慢了下来。" },
          {
            id: "p4",
            text: "暮色四合时，老街尽头的茶馆熄了灯，四下再无人声。",
          },
        ],
      },
    ],
  };
}

function makeAnnotation(
  anchor: ReturnType<typeof createAnchor>,
  note = "",
): Annotation {
  return { id: "a1", note, status: "anchored", anchor, createdAt: 1 };
}

describe("锚点与重锚", () => {
  it("锚点记录章节身份、位置、选中文字与两侧上下文", () => {
    const ch = flattenBook(v1()).chapters[0];
    const start = ch.text.indexOf("王木匠");
    const anchor = createAnchor(ch, start, start + "王木匠推开店门".length);
    expect(anchor.chapterId).toBe("c1");
    expect(anchor.text).toBe("王木匠推开店门");
    expect(anchor.prefix.endsWith("清晨的阳光洒在老街上，")).toBe(true);
    expect(anchor.suffix.startsWith("，开始了")).toBe(true);
  });

  it("段落拆分：唯一匹配自动迁移，忽略新的段界定符", () => {
    const old = flattenBook(v1()).chapters[0];
    const start = old.text.indexOf("王木匠推开店门");
    const annotation = makeAnnotation(
      createAnchor(old, start, start + "王木匠推开店门".length),
    );
    const result = reanchorOne(annotation, flattenBook(v2()));
    expect(result.status).toBe("anchored");
    const nextCh = flattenBook(v2()).chapters[0];
    // 落点从新的 p1b 段首开始（p1 已在「，」处拆开）
    expect(result.anchor.start).toBe(nextCh.paragraphs[1].start);
    expect(result.anchor.end).toBeGreaterThan(nextCh.paragraphs[1].start);
    expect(result.anchor.text.replace(/\n/g, "")).toBe("王木匠推开店门");
  });

  it("跨节点选区：选区横跨两段时锚点文字保留段界标记", () => {
    const ch = flattenBook(v1()).chapters[0];
    const p1End = ch.paragraphs[0].textEnd;
    const anchor = createAnchor(ch, p1End - 4, ch.paragraphs[1].start + 5);
    expect(anchor.text).toContain("\n");
    // 重锚到 v2（p1 被拆分，段界数量增加）仍能凭连续文字唯一命中
    const result = reanchorOne(makeAnnotation(anchor), flattenBook(v2()));
    expect(result.status).toBe("anchored");
    expect(result.anchor.text.replace(/\n/g, "")).toBe(
      anchor.text.replace(/\n/g, ""),
    );
  });

  it("重复短句：两处匹配列为待裁决，不自动猜测，候选按上下文评分排序", () => {
    const old = flattenBook(v1()).chapters[0];
    const start = old.text.indexOf("他点了点头。");
    const annotation = makeAnnotation(createAnchor(old, start, start + 6));
    const result = reanchorOne(annotation, flattenBook(v2()));
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    // 第一处后面是「街坊们都知道」，与保存的前缀/后缀更吻合，应排在前面
    const snippets = result.candidates!.map((c) =>
      candidateSnippet(flattenBook(v2()), c).after.slice(0, 4),
    );
    expect(snippets[0]).toBe("街坊们都");
  });

  it("文字插入：插入点之后的唯一匹配随插入内容右移（坐标漂移纠正）", () => {
    const old = flattenBook(v1()).chapters[0];
    const needle = "传了三代。";
    const start = old.text.indexOf(needle);
    const annotation = makeAnnotation(
      createAnchor(old, start, start + needle.length),
    );
    const result = reanchorOne(annotation, flattenBook(v2()));
    expect(result.status).toBe("anchored");
    // v2 在该句之前插入了「在镇上足足」（5 字），加上 p1/p1b 之间多一个段界定符
    expect(result.anchor.start).toBe(start + "在镇上足足".length + 1);
    expect(result.anchor.text.replace(/\n/g, "")).toBe("传了三代。");
  });

  it("找不到匹配：保留失联状态与原文证据，绝不放置猜测位置", () => {
    const old = flattenBook(v1()).chapters[0];
    const needle = "只剩一盏灯还亮着";
    const start = old.text.indexOf(needle);
    const annotation = makeAnnotation(
      createAnchor(old, start, start + needle.length),
    );
    const result = reanchorOne(annotation, flattenBook(v2()));
    expect(result.status).toBe("lost");
    // 原锚点完整保留
    expect(result.anchor.text).toBe(needle);
    expect(result.anchor.start).toBe(start);
    expect(result.anchor.prefix).toBe(annotation.anchor.prefix);
    expect(result.candidates).toBeUndefined();
  });

  it("章节删除：失联且原锚点原样保留", () => {
    const old = flattenBook(v1()).chapters[0];
    const annotation = makeAnnotation(createAnchor(old, 0, 3));
    const flat = flattenBook({
      ...v2(),
      chapters: v2().chapters.filter((c) => c.id !== "c1"),
    });
    const result = reanchorOne(annotation, flat);
    expect(result.status).toBe("lost");
    expect(result.anchor).toEqual(annotation.anchor);
  });

  it("人工裁决：采用候选后锚点迁移到该候选", () => {
    const oldFlat = flattenBook(v1());
    const ch = oldFlat.chapters[0];
    const start = ch.text.indexOf("他点了点头。");
    const annotation = makeAnnotation(createAnchor(ch, start, start + 6));
    const newFlat = flattenBook(v2());
    const ambiguous = reanchorOne(annotation, newFlat);
    const second: Candidate = ambiguous.candidates![1];
    const resolved = resolveCandidate(ambiguous, second, newFlat);
    expect(resolved.status).toBe("anchored");
    expect(resolved.anchor.start).toBe(second.start);
    expect(resolved.anchor.end).toBe(second.end);
  });

  it("重排稳定：同一版本重新载入时坐标与文字吻合的批注原样保留（不依赖像素）", () => {
    const flat = flattenBook(v1());
    const ch = flat.chapters[0];
    const start = ch.text.indexOf("王木匠");
    const annotation = makeAnnotation(createAnchor(ch, start, start + 3));
    // 改字号 / 窗口宽度完全不影响文字坐标；再次扁平化后 ensureAnchored 应保留
    const again = ensureAnchored([annotation], flattenBook(v1()));
    expect(again[0].status).toBe("anchored");
    expect(again[0].anchor).toEqual(annotation.anchor);
  });

  it("批量重锚：各条独立判定", () => {
    const oldFlat = flattenBook(v1());
    const ch = oldFlat.chapters[0];
    const mk = (needle: string, id: string): Annotation => {
      const s = ch.text.indexOf(needle);
      return {
        id,
        note: "",
        status: "anchored",
        anchor: createAnchor(ch, s, s + needle.length),
        createdAt: 1,
      };
    };
    const all = reanchorAll(
      [
        mk("王木匠推开店门", "a"),
        mk("他点了点头。", "b"),
        mk("只剩一盏灯还亮着", "c"),
      ],
      flattenBook(v2()),
    );
    expect(all.map((a) => [a.id, a.status])).toEqual([
      ["a", "anchored"],
      ["b", "ambiguous"],
      ["c", "lost"],
    ]);
  });
});
