/**
 * 文字规范化：受控 NFKC + 空白折叠（不区分换行/制表/连续空格），逐段进行。
 *
 * 关键：NFKC 会把中文全角标点「，。：；」映射成 ASCII 标点，破坏中文书稿，
 * 因此只对「规范化结果为纯 ASCII」的字素簇应用 NFKC（兼容连字 ﬁ、全角
 * 字母数字等），中文标点与其他非 ASCII 符号一律原样保留。
 *
 * 所有偏移量均为 UTF-16 代码单元下标，与浏览器 DOM 的 offset 语义一致。
 */
export interface Normalized {
  /** 规范化后的文字。 */
  text: string;
  /** map[i]：规范化位置 i 对应的原始下标。 */
  map: number[];
  /** inv[i]：原始下标 i 对应的规范化下标（单调非降）。 */
  inv: number[];
}

const isWs = (ch: string | undefined): boolean =>
  ch !== undefined && /\s/u.test(ch);
const isAscii = (s: string): boolean => /^[\x00-\x7F]*$/.test(s);

/**
 * 全角标点（U+FF01–FF65）经 NFKC 会变成 ASCII 标点，必须保留中文原样；
 * 其中全角字母/数字仍可归一：FF10–FF19 数字、FF21–FF3A 大写、FF41–FF5A 小写。
 */
function isProtectedFullwidth(cp: number): boolean {
  if (cp < 0xff01 || cp > 0xff65) return false;
  const isAlnum =
    (cp >= 0xff10 && cp <= 0xff19) ||
    (cp >= 0xff21 && cp <= 0xff3a) ||
    (cp >= 0xff41 && cp <= 0xff5a);
  return !isAlnum;
}

function containsProtected(s: string): boolean {
  for (const ch of s) {
    if (isProtectedFullwidth(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

/**
 * 规范化单个段落原文。
 *
 * 第一步按字素簇做受控 NFKC（逐簇处理以建立映射）；
 * 第二步去除首尾空白，内部连续空白折叠为单个空格。
 */
export function normalizeText(raw: string): Normalized {
  // ---- 第一步：逐字素簇受控 NFKC ----
  const a: string[] = [];
  const aMap: number[] = []; // a 中位置 -> raw 下标
  const aInv: number[] = new Array(raw.length).fill(0); // raw 下标 -> a 中位置
  let aCursor = 0;
  for (const seg of segmenter.segment(raw)) {
    const start = seg.index;
    const src = seg.segment;
    const nfkc = src.normalize("NFKC");
    const out = isAscii(nfkc) && !containsProtected(src) ? nfkc : src;
    for (let i = 0; i < out.length; i++) {
      a.push(out[i]);
      // 展开（如 ﬁ -> fi）时多个输出位置都指向该原始簇起点。
      aMap.push(start + Math.min(i, src.length - 1));
    }
    for (let i = 0; i < src.length; i++) {
      // 收缩时多个原始位置指向最后一个输出位置。
      aInv[start + i] = aCursor + Math.min(i, Math.max(out.length - 1, 0));
    }
    aCursor += out.length;
  }

  // ---- 第二步：空白折叠 ----
  const out: string[] = [];
  const map: number[] = [];
  const aToOut: number[] = new Array(a.length).fill(0);
  let cursor = 0;
  let i = 0;
  while (i < a.length && isWs(a[i])) {
    aToOut[i] = 0; // 前导空白 -> 段首
    i++;
  }
  let pending = false;
  for (; i < a.length; i++) {
    if (isWs(a[i])) {
      pending = true;
      aToOut[i] = cursor;
      continue;
    }
    if (pending) {
      out.push(" ");
      map.push(aMap[i]);
      cursor++;
      pending = false;
    }
    aToOut[i] = cursor;
    out.push(a[i]);
    map.push(aMap[i]);
    cursor++;
  }
  // 尾随空白吸附到串尾。
  for (let j = 0; j < a.length; j++) {
    if (isWs(a[j])) aToOut[j] = Math.min(aToOut[j], out.length);
  }

  const inv = aInv.map((p) => aToOut[p] ?? 0);
  return { text: out.join(""), map, inv };
}
