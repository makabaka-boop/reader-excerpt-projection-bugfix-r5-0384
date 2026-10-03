import type { Book, Chapter, Paragraph, RawBookInput } from "../types";

export class BookParseError extends Error {}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** 解析并校验导入的 JSON 书稿；任何结构问题都抛出 BookParseError，绝不静默猜测。 */
export function parseBook(jsonText: string): Book {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new BookParseError(`JSON 解析失败：${(e as Error).message}`);
  }
  return bookFromUnknown(raw);
}

/** 校验已解析的 JSON 值是否为合法书稿（节选文件等场景复用同一套规则）。 */
export function bookFromUnknown(raw: unknown): Book {
  const obj = asObject(raw);
  if (!obj) throw new BookParseError("书稿顶层必须是对象");

  const input = obj as RawBookInput;
  const id = asString(input.id);
  if (!id) throw new BookParseError("缺少字符串字段 id（书籍身份）");
  const title = asString(input.title);
  if (!title) throw new BookParseError("缺少字符串字段 title");
  if (!Array.isArray(input.chapters))
    throw new BookParseError("chapters 必须是数组");

  const chapterIds = new Set<string>();
  const chapters: Chapter[] = input.chapters.map((cv, ci) => {
    const co = asObject(cv);
    if (!co) throw new BookParseError(`第 ${ci + 1} 章不是对象`);
    const cid = asString(co.id);
    if (!cid) throw new BookParseError(`第 ${ci + 1} 章缺少字符串字段 id`);
    if (chapterIds.has(cid)) throw new BookParseError(`章节 id 重复：${cid}`);
    chapterIds.add(cid);
    const ctitle = asString(co.title) ?? cid;
    if (!Array.isArray(co.paragraphs))
      throw new BookParseError(`章节「${cid}」的 paragraphs 必须是数组`);

    const paragraphs: Paragraph[] = co.paragraphs.map((pv, pi) => {
      const po = asObject(pv);
      if (po !== null) {
        const text = asString(po.text);
        if (text === null)
          throw new BookParseError(
            `章节「${cid}」第 ${pi + 1} 段缺少字符串字段 text`,
          );
        const pid = asString(po.id);
        return pid ? { id: pid, text } : { text };
      }
      if (typeof pv === "string") return { text: pv };
      throw new BookParseError(
        `章节「${cid}」第 ${pi + 1} 段必须是字符串或对象`,
      );
    });

    return { id: cid, title: ctitle, paragraphs };
  });

  if (chapters.length === 0) throw new BookParseError("书稿至少需要一个章节");

  const book: Book = { id, title, chapters };
  const version = asString(input.version);
  if (version) book.version = version;
  return book;
}
