import { describe, expect, it } from "vitest";
import { parseBook, BookParseError } from "./parseBook";

describe("parseBook", () => {
  it("接受字符串或 {id,text} 段落", () => {
    const b = parseBook(
      JSON.stringify({
        id: "x",
        title: "T",
        chapters: [{ id: "c", paragraphs: ["一", { id: "p2", text: "二" }] }],
      }),
    );
    expect(b.chapters[0].paragraphs[1].id).toBe("p2");
  });

  it.each([
    ["非 JSON", "{"],
    ["顶层非对象", "[]"],
    ["缺 id", '{"title":"t","chapters":[]}'],
    ["chapters 非数组", '{"id":"b","title":"t","chapters":{}}'],
    [
      "章节 id 重复",
      '{"id":"b","title":"t","chapters":[{"id":"c","paragraphs":[]},{"id":"c","paragraphs":[]}]}',
    ],
    [
      "段落非法",
      '{"id":"b","title":"t","chapters":[{"id":"c","paragraphs":[5]}]}',
    ],
    ["空书", '{"id":"b","title":"t","chapters":[]}'],
  ])("拒绝非法输入：%s", (_name, json) => {
    expect(() => parseBook(json)).toThrow(BookParseError);
  });
});
