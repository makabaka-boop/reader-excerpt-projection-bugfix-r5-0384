import { describe, expect, it } from "vitest";
import { normalizeText } from "./normalize";

describe("normalizeText", () => {
  it("原样保留普通文字", () => {
    const n = normalizeText("王木匠推开店门");
    expect(n.text).toBe("王木匠推开店门");
    expect(n.map).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("折叠前导/尾随/内部连续空白", () => {
    const n = normalizeText("   第二日，一个\t外乡人\n\n来到  店门 ");
    expect(n.text).toBe("第二日，一个 外乡人 来到 店门");
  });

  it("NFKC：全角与兼容字符归一", () => {
    expect(normalizeText("ＡＢＣﬁ").text).toBe("ABCfi");
  });

  it("逆映射：原始偏移总能映射到合理的规范化位置（单调非降）", () => {
    const raw = "  甲 乙  ";
    const n = normalizeText(raw);
    expect(n.text).toBe("甲 乙");
    for (let i = 1; i < n.inv.length; i++) {
      expect(n.inv[i]).toBeGreaterThanOrEqual(n.inv[i - 1]);
    }
    // 前导空白吸附到段首
    expect(n.inv[0]).toBe(0);
    expect(n.inv[1]).toBe(0);
    // 第一个字「甲」
    expect(n.inv[2]).toBe(0);
  });

  it("展开型 NFKC（ﬁ -> fi）的映射不越界", () => {
    const n = normalizeText("aﬁb");
    expect(n.text).toBe("afib");
    // 原位置 1（ﬁ 起点）映射到 f；位置 2（b）映射到 i+1
    expect(n.text[n.inv[2]]).toBe("b");
  });
});
