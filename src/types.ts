export type CellStatus = 'base' | 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

export interface TextUnit {
  id: string;
  versionId: string;
  paragraphOrder: number;
  /** 段内第几句，从 1 开始 */
  sentenceOrder: number;
  paragraphText: string;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

/** 一个对齐组：底本的一句，以及各参校本对应/新增/删减的单元 */
export interface AlignmentGroup {
  id: string;
  order: number;
  paragraphOrder: number;
  cells: Record<string, Cell>;
  accepted: boolean;
}

export interface Cell {
  /** 删减状态（底本有、此版无）时为空 */
  unit?: TextUnit;
  status: CellStatus;
  similarity: number;
  /** 人工挪动配对或手动改判后为 true，重算状态不再覆盖 */
  manuallyAdjusted: boolean;
  /** 人工指定的判定，重对齐后随原句保留 */
  manualStatus?: CellStatus;
}

export interface Annotation {
  key: string;
  versionId: string;
  textHash: number;
  note: string;
  source: string;
  updatedAt: string;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  /** 低于该相似度判为疑错位 */
  misalignThreshold: number;
}

export interface DraftMeta {
  id: string;
  name: string;
  updatedAt: string;
}

export interface Draft {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  versions: VersionDocument[];
  baseVersionId: string;
  activeVersionIds: string[];
  groups: AlignmentGroup[];
  annotations: Record<string, Annotation>;
  rules: ComparisonRules;
  selectedGroupId: string | null;
}

/** localStorage 中保存的索引与当前草稿 */
export interface PersistedState {
  version: 2;
  currentDraftId: string;
  draftIds: string[];
  drafts: Record<string, Draft>;
}

export const statusLabelMap: Record<CellStatus, string> = {
  base: '底本',
  same: '相同',
  changed: '改动',
  added: '新增',
  removed: '删减',
  misaligned: '疑错位'
};
