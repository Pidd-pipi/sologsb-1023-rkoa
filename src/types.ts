/**
 * 多版本文本校勘的核心数据模型。
 * 关键约束：校记(Annotation) 挂在「版本 + 句子稳定 ID」上，不隶属于对齐组，
 * 因此换底本、切换参校、改规则重新对齐、重新分句都不会丢校记。
 */

export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

/** 句子：导入时分句生成，id 在该版本内稳定（v{versionId}p{段}s{段内序}g{全局序}） */
export interface Sentence {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  /** 段内第几句 */
  sentenceInParagraph: number;
  /** 全版本内第几句（稳定序号，便于引用） */
  globalOrder: number;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  sentences: Sentence[];
}

export interface Annotation {
  id: string;
  versionId: string;
  /** 挂载的句子 id；失主校记中为 null */
  sentenceId: string | null;
  note: string;
  source: string;
  updatedAt: string;
}

/** 失主校记：重新分句/换版本后无法自动归位的校记，保留原句文本供人工指认 */
export interface OrphanAnnotation extends Annotation {
  sentenceId: null;
  originalText: string;
  originalVersionId: string;
}

/** 单元格级人工裁定：接受建议 / 手动指定类别。键为「句签名」，重对齐后按签名迁移 */
export interface CellVerdict {
  statusOverride?: DifferenceStatus;
  accepted?: boolean;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  /** 句匹配相似度阈值，低于此值不自动配对（0~1） */
  matchThreshold: number;
  /** 是否允许跨段落配对 */
  crossParagraph: boolean;
  /** 每片对齐多少句（让出主线程，避免长文本卡死） */
  chunkSize: number;
}

/** 一个对齐组：底本一句（插入组为 null）对应各参校的零至多个句子 */
export interface AlignGroup {
  id: string;
  /** 底本句 id；底本没有对应句（参校插入段）时为 null */
  baseSentenceId: string | null;
  /** 版本 id -> 该版本落在本组的句子 id（有序，支持一对多） */
  cells: Record<string, string[]>;
  /** 人工锁定：重新对齐时原样保留，不参与自动重算 */
  locked: boolean;
  /** 人工合并/拆分组：重对齐时在其边界处不再自动跨组配对 */
  manual: boolean;
  /** 人工合并两个带底本句的组时，并入的额外底本句 id */
  baseExtraIds?: string[];
}

export interface ProjectDraft {
  id: string;
  name: string;
  updatedAt: string;
}

export interface CollationProject {
  schema: 2;
  id: string;
  name: string;
  versions: VersionDocument[];
  baseVersionId: string;
  /** 参与同屏对照的参校版本 id（3~5 版含底本） */
  witnessIds: string[];
  groups: AlignGroup[];
  annotations: Record<string, Annotation>;
  /** 键：baseSentenceId|versionId|witnessSentenceId|baseTextHash|witnessTextHash */
  verdicts: Record<string, CellVerdict>;
  orphans: OrphanAnnotation[];
  rules: ComparisonRules;
  selectedGroupId: string;
  /** 当前分片（按底本句序切分），从 0 开始；-1 表示全文 */
  activeChunk: number;
  updatedAt: string;
}

export interface PersistedState {
  version: 2;
  projects: CollationProject[];
  currentProjectId: string;
}

export type CellStatus = DifferenceStatus;
