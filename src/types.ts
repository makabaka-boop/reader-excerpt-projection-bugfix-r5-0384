export interface Paragraph {
  id?: string;
  text: string;
}

export interface Chapter {
  id: string;
  title: string;
  paragraphs: Paragraph[];
}

export interface Book {
  id: string;
  title: string;
  version?: string;
  chapters: Chapter[];
}

/** 锚点：同时记录章节身份、规范化文字位置、选中文字及两侧上下文。 */
export interface Anchor {
  chapterId: string;
  start: number;
  end: number;
  text: string;
  prefix: string;
  suffix: string;
}

export type AnnotationStatus = "anchored" | "ambiguous" | "lost";

export interface Candidate {
  chapterId: string;
  start: number;
  end: number;
  score: number;
}

export interface Annotation {
  id: string;
  note: string;
  status: AnnotationStatus;
  anchor: Anchor;
  /** 裁决用候选（status === 'ambiguous' 时存在）。 */
  candidates?: Candidate[];
  /** 创建时间戳。 */
  createdAt: number;
}

/** 导入 JSON 的宽松结构。 */
export interface RawBookInput {
  id?: unknown;
  title?: unknown;
  version?: unknown;
  chapters?: unknown;
}
