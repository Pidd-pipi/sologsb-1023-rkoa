import { computed, ref } from 'vue';
import { sampleVersions } from '../data';
import { autoAlignGroups } from '../lib/align';
import { charDiff, hashText, makeVersion, normalizedSimilarity } from '../lib/text';
import { createAnnotation, migrateAnnotationsForResegment, migrateAnnotationsForVersionReplace } from '../lib/migrate';
import type {
  AlignGroup,
  Annotation,
  CellVerdict,
  CollationProject,
  ComparisonRules,
  DifferenceStatus,
  OrphanAnnotation,
  PersistedState,
  Sentence,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v2';
const LEGACY_KEY = 'sologsb-1023/multi-version-collation/v1';
const HISTORY_LIMIT = 50;
const MAX_VERSIONS = 5;

function defaultRules(): ComparisonRules {
  return {
    ignorePunctuation: true,
    ignoreVariants: true,
    matchThreshold: 0.45,
    crossParagraph: false,
    chunkSize: 60
  };
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function verdictKey(baseText: string, versionId: string, witnessText: string): string {
  return `${hashText(baseText)}|${versionId}|${hashText(witnessText)}`;
}

// ---------------------------------------------------------------------------
// 全局持久状态：多草稿项目
// ---------------------------------------------------------------------------
const projects = ref<CollationProject[]>([]);
const currentProjectId = ref<string>('');
const history = ref<string[]>([]);
const future = ref<string[]>([]);
const message = ref('正在载入本地校勘草稿…');
const processing = ref(false);
const progress = ref(0);
const progressPhase = ref('');
let loaded = false;

/** 当前选中的句子（跨组件共享）：groupId + versionId + sentenceId */
const selectedCell = ref<{ groupId: string; versionId: string; sentenceId: string } | null>(null);

const currentProject = computed<CollationProject | undefined>(() =>
  projects.value.find((p) => p.id === currentProjectId.value)
);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function snapshot(): string {
  return JSON.stringify({ projects: projects.value, currentProjectId: currentProjectId.value });
}

function persist() {
  const state: PersistedState = { version: 2, projects: projects.value, currentProjectId: currentProjectId.value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    message.value = '本地存储空间不足，请及时导出 JSON 备份';
    console.warn(error);
  }
}

function commit(label: string, mutate: () => void) {
  history.value.push(snapshot());
  if (history.value.length > HISTORY_LIMIT) history.value.shift();
  future.value = [];
  mutate();
  if (currentProject.value) currentProject.value.updatedAt = new Date().toISOString();
  message.value = label;
  persist();
}

function restoreSnapshot(raw: string) {
  const parsed = JSON.parse(raw) as { projects: CollationProject[]; currentProjectId: string };
  projects.value = parsed.projects;
  currentProjectId.value = parsed.currentProjectId;
  persist();
}

function undo() {
  const prev = history.value.pop();
  if (!prev) return;
  future.value.push(snapshot());
  restoreSnapshot(prev);
  message.value = '已撤销上一步操作';
}

function redo() {
  const next = future.value.pop();
  if (!next) return;
  history.value.push(snapshot());
  restoreSnapshot(next);
  message.value = '已重做上一步操作';
}

// ---------------------------------------------------------------------------
// 初始示例项目
// ---------------------------------------------------------------------------
async function buildSampleProject(): Promise<CollationProject> {
  const versions = clone(sampleVersions);
  const baseVersionId = versions[0].id;
  const witnessIds = versions.slice(1, 4).map((v) => v.id);
  const project: CollationProject = {
    schema: 2,
    id: uid('proj'),
    name: '《老子》第十五章异文校勘（示例）',
    versions,
    baseVersionId,
    witnessIds,
    groups: [],
    annotations: {},
    verdicts: {},
    orphans: [],
    rules: defaultRules(),
    selectedGroupId: '',
    activeChunk: 0,
    updatedAt: new Date().toISOString()
  };
  const base = versions.find((v) => v.id === baseVersionId)!;
  const witnesses = witnessIds.map((id) => versions.find((v) => v.id === id)!);
  project.groups = await autoAlignGroups({
    baseVersion: base,
    witnesses,
    rules: project.rules,
    onProgress: () => undefined
  });
  return project;
}

async function load() {
  if (loaded) return;
  loaded = true;
  let state: PersistedState | null = null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      state = JSON.parse(raw) as PersistedState;
    } catch {
      state = null;
    }
  }
  if (state && state.projects.length) {
    projects.value = state.projects;
    currentProjectId.value = state.currentProjectId || state.projects[0].id;
    message.value = '已恢复浏览器中的校勘草稿';
    return;
  }
  // 兼容 v1 草稿：不覆盖，提示用户旧草稿仍可打开
  const legacy = localStorage.getItem(LEGACY_KEY);
  message.value = legacy
    ? '检测到旧版两版对校草稿，可在「草稿管理」中查看；已载入新的多版本示例'
    : '已载入示例版本，正在自动对齐…';
  processing.value = true;
  const sample = await buildSampleProject();
  projects.value = [sample];
  currentProjectId.value = sample.id;
  processing.value = false;
  persist();
}

/** 仅供单元测试：重置模块单例状态 */
export function __resetCollationForTests() {
  projects.value = [];
  currentProjectId.value = '';
  history.value = [];
  future.value = [];
  selectedCell.value = null;
  processing.value = false;
  progress.value = 0;
  message.value = '';
  loaded = false;
}

// ---------------------------------------------------------------------------
// 派生查询
// ---------------------------------------------------------------------------
const baseVersion = computed<VersionDocument | undefined>(() =>
  currentProject.value?.versions.find((v) => v.id === currentProject.value?.baseVersionId)
);

/** 规则直接作用于当前项目；组件用 v-model 读、updateRules 写（写即重对齐） */
const rules = computed<ComparisonRules>(() => currentProject.value?.rules ?? defaultRules());

const witnessVersions = computed<VersionDocument[]>(() => {
  const p = currentProject.value;
  if (!p) return [];
  return p.witnessIds.map((id) => p.versions.find((v) => v.id === id)).filter(Boolean) as VersionDocument[];
});

const activeVersions = computed(() => {
  const b = baseVersion.value;
  return b ? [b, ...witnessVersions.value] : witnessVersions.value;
});

function sentenceById(versionId: string, sentenceId: string): Sentence | undefined {
  return currentProject.value?.versions.find((v) => v.id === versionId)?.sentences.find((s) => s.id === sentenceId);
}

/** 取一个组内底本应展示的句子（合并组含额外底本句，按正文先后） */
function baseSentencesOf(group: AlignGroup): Sentence[] {
  const p = currentProject.value;
  if (!p) return [];
  const ids = [...(group.baseExtraIds ?? []), group.baseSentenceId].filter(Boolean) as string[];
  const base = baseVersion.value;
  if (!base) return [];
  return ids
    .map((id) => base.sentences.find((s) => s.id === id))
    .filter((s): s is Sentence => Boolean(s))
    .sort((a, b) => a.globalOrder - b.globalOrder);
}

function groupIndex(groupId: string): number {
  return currentProject.value?.groups.findIndex((g) => g.id === groupId) ?? -1;
}

/** 单元格状态：人工裁定优先，否则自动判定 */
function baseTextOf(group: AlignGroup): string {
  return baseSentencesOf(group)
    .map((s) => s.text)
    .join('');
}

function witnessTextOf(group: AlignGroup, versionId: string): string {
  return (group.cells[versionId] ?? []).map((id) => sentenceById(versionId, id)?.text ?? '').join('');
}

function cellStatus(group: AlignGroup, versionId: string): { status: DifferenceStatus; similarity: number; manual: boolean } {
  const p = currentProject.value!;
  const witnessIds = group.cells[versionId] ?? [];
  const baseText = baseTextOf(group);
  const witnessText = witnessTextOf(group, versionId);
  const key = verdictKey(baseText, versionId, witnessText);
  const verdict = p.verdicts[key];
  const sim = baseText && witnessText ? normalizedSimilarity(baseText, witnessText, p.rules) : 0;

  let status: DifferenceStatus;
  if (!witnessIds.length) {
    status = group.baseSentenceId ? 'removed' : 'same';
  } else if (!group.baseSentenceId) {
    status = 'added';
  } else if (sim > 0.995) {
    status = 'same';
  } else if (sim >= 0.32) {
    status = 'changed';
  } else {
    status = 'misaligned';
  }
  return {
    status: verdict?.statusOverride ?? status,
    similarity: sim,
    manual: Boolean(verdict?.statusOverride)
  };
}

function cellAccepted(group: AlignGroup, versionId: string): boolean {
  const p = currentProject.value!;
  const key = verdictKey(baseTextOf(group), versionId, witnessTextOf(group, versionId));
  return Boolean(p.verdicts[key]?.accepted);
}

function setVerdict(group: AlignGroup, versionId: string, patch: CellVerdict) {
  const p = currentProject.value!;
  const key = verdictKey(baseTextOf(group), versionId, witnessTextOf(group, versionId));
  p.verdicts[key] = { ...p.verdicts[key], ...patch };
}

function cellDiffTokens(group: AlignGroup, versionId: string) {
  const p = currentProject.value!;
  void p;
  return charDiff(baseTextOf(group), witnessTextOf(group, versionId), currentProject.value!.rules);
}

// ---------------------------------------------------------------------------
// 分片（按底本句序，锁定组随其底本句位置自然落在片内）
// ---------------------------------------------------------------------------
interface ChunkInfo {
  index: number;
  startGroup: number;
  endGroup: number;
  baseStart: number;
  baseEnd: number;
  label: string;
}

const chunks = computed<ChunkInfo[]>(() => {
  const p = currentProject.value;
  if (!p || !baseVersion.value) return [];
  const size = Math.max(10, p.rules.chunkSize || 60);
  const baseOrder = new Map(baseVersion.value.sentences.map((s, i) => [s.id, i]));
  const result: ChunkInfo[] = [];
  let chunkIndex = 0;
  let start = 0;
  let baseCount = 0;
  for (let i = 0; i < p.groups.length; i += 1) {
    const g = p.groups[i];
    if (g.baseSentenceId && baseOrder.has(g.baseSentenceId)) baseCount += 1;
    if (baseCount >= size) {
      result.push(makeChunk(chunkIndex++, start, i + 1, baseOrder, p.groups, start, i + 1));
      start = i + 1;
      baseCount = 0;
    }
  }
  if (start < p.groups.length) {
    result.push(makeChunk(chunkIndex, start, p.groups.length, baseOrder, p.groups, start, p.groups.length));
  }
  return result;
});

function makeChunk(
  index: number,
  startGroup: number,
  endGroup: number,
  _baseOrder: Map<string, number>,
  _all: AlignGroup[],
  baseStart: number,
  baseEnd: number
): ChunkInfo {
  return {
    index,
    startGroup,
    endGroup,
    baseStart,
    baseEnd,
    label: `第 ${index + 1} 片（组 ${startGroup + 1}–${endGroup}）`
  };
}

const visibleGroups = computed<AlignGroup[]>(() => {
  const p = currentProject.value;
  if (!p) return [];
  const ci = p.activeChunk;
  const chunk = chunks.value[ci];
  if (!chunk) return p.groups;
  return p.groups.slice(chunk.startGroup, chunk.endGroup);
});

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
const stats = computed(() => {
  const p = currentProject.value;
  if (!p) return { differences: 0, unresolved: 0, accepted: 0, groups: 0, notes: 0, orphans: 0 };
  let differences = 0;
  let accepted = 0;
  for (const g of p.groups) {
    for (const wid of p.witnessIds) {
      const ids = g.cells[wid] ?? [];
      if (!g.baseSentenceId && !ids.length) continue;
      const { status } = cellStatus(g, wid);
      if (status !== 'same') differences += 1;
      if (cellAccepted(g, wid)) accepted += 1;
    }
  }
  return {
    differences,
    unresolved: unresolvedCount.value,
    accepted,
    groups: p.groups.length,
    notes: Object.keys(p.annotations).length,
    orphans: p.orphans.length
  };
});

const unresolvedCount = computed(() => {
  const p = currentProject.value;
  if (!p) return 0;
  let count = 0;
  for (const g of p.groups) {
    for (const wid of p.witnessIds) {
      if (!g.baseSentenceId && !(g.cells[wid] ?? []).length) continue;
      const { status } = cellStatus(g, wid);
      if (status !== 'same' && !cellAccepted(g, wid)) count += 1;
    }
  }
  return count;
});

// ---------------------------------------------------------------------------
// 操作：重新对齐、换底本、参校勾选、规则
// ---------------------------------------------------------------------------
async function realign(options?: { label?: string; forceAll?: boolean }) {
  const p = currentProject.value;
  if (!p || !baseVersion.value || processing.value) return;
  processing.value = true;
  progress.value = 0;
  progressPhase.value = '正在分片自动对齐…';
  const label = options?.label ?? '已按当前版本与规则重新对齐';
  history.value.push(snapshot());
  if (history.value.length > HISTORY_LIMIT) history.value.shift();
  future.value = [];
  try {
    // 锁定组（人工挪动过且已锁定，或合并/拆分产生的 manual 组）原样保留
    const lockedGroups = options?.forceAll ? [] : p.groups.filter((g) => g.locked);
    const result = await autoAlignGroups({
      baseVersion: baseVersion.value,
      witnesses: witnessVersions.value,
      rules: p.rules,
      lockedGroups,
      onProgress: (info) => {
        progress.value = info.percent;
        progressPhase.value = info.phase;
      }
    });
    p.groups = result;
    p.selectedGroupId = '';
    selectedCell.value = null;
    p.activeChunk = 0;
    message.value = `${label}：${lockedGroups.length} 个锁定组保持原位，校记与来源均已保留`;
    persist();
  } finally {
    processing.value = false;
  }
}

function setBaseVersion(versionId: string) {
  const p = currentProject.value;
  if (!p || versionId === p.baseVersionId) return;
  commit('已更换底本，原各版校记全部保留', () => {
    const oldBase = p.baseVersionId;
    p.baseVersionId = versionId;
    // 新底本从参校列表移除；旧底本若未超过参校上限则回到参校
    p.witnessIds = p.witnessIds.filter((id) => id !== versionId);
    if (!p.witnessIds.includes(oldBase) && p.versions.some((v) => v.id === oldBase)) {
      p.witnessIds.unshift(oldBase);
    }
    p.groups = [];
    p.activeChunk = 0;
  });
  void realign({ label: '底本已更换并完成对齐' });
}

function toggleWitness(versionId: string, checked: boolean) {
  const p = currentProject.value;
  if (!p) return;
  commit(checked ? `已加入参校：${versionName(versionId)}` : `已移出对照列：${versionName(versionId)}（校记保留）`, () => {
    if (checked) {
      if (!p.witnessIds.includes(versionId)) {
        if (p.witnessIds.length >= MAX_VERSIONS - 1) {
          message.value = `最多同时载入 ${MAX_VERSIONS} 个版本（含底本）`;
          return;
        }
        p.witnessIds.push(versionId);
      }
    } else {
      p.witnessIds = p.witnessIds.filter((id) => id !== versionId);
    }
    p.activeChunk = 0;
  });
  if (checked) void realign({ label: '参校版本已更新' });
}

function versionName(versionId: string): string {
  return currentProject.value?.versions.find((v) => v.id === versionId)?.name ?? versionId;
}

function updateRules(patch: Partial<ComparisonRules>) {
  const p = currentProject.value;
  if (!p) return;
  commit('比较规则已修改', () => {
    Object.assign(p.rules, patch);
  });
  void realign({ label: '已按新规则重新对齐' });
}

function setActiveChunk(index: number) {
  const p = currentProject.value;
  if (!p) return;
  p.activeChunk = index;
  persist();
}

// ---------------------------------------------------------------------------
// 操作：单元格裁定
// ---------------------------------------------------------------------------
function overrideStatus(groupId: string, versionId: string, status: DifferenceStatus) {
  const p = currentProject.value;
  if (!p) return;
  const group = p.groups.find((g) => g.id === groupId);
  if (!group) return;
  commit('已人工标记差异类别', () => {
    setVerdict(group, versionId, { statusOverride: status });
    const cell = group.cells[versionId] ?? [];
    void cell;
  });
}

function clearOverride(groupId: string, versionId: string) {
  const p = currentProject.value;
  if (!p) return;
  const group = p.groups.find((g) => g.id === groupId);
  if (!group) return;
  commit('已恢复自动判定', () => {
    const key = verdictKey(baseTextOf(group), versionId, witnessTextOf(group, versionId));
    const v = p.verdicts[key];
    if (v) {
      delete v.statusOverride;
      if (!v.accepted) delete p.verdicts[key];
    }
  });
}

function acceptCell(groupId: string, versionId: string) {
  const p = currentProject.value;
  if (!p) return;
  const group = p.groups.find((g) => g.id === groupId);
  if (!group) return;
  commit('已接受该单元格的差异判断', () => setVerdict(group, versionId, { accepted: true }));
}

function unacceptCell(groupId: string, versionId: string) {
  const p = currentProject.value;
  if (!p) return;
  const group = p.groups.find((g) => g.id === groupId);
  if (!group) return;
  commit('已撤回接受', () => {
    const key = verdictKey(baseTextOf(group), versionId, witnessTextOf(group, versionId));
    if (p.verdicts[key]) p.verdicts[key].accepted = false;
  });
}

function acceptVisible() {
  const p = currentProject.value;
  if (!p) return;
  commit('已批量接受本片全部差异', () => {
    for (const g of visibleGroups.value) {
      for (const wid of p.witnessIds) {
        const { status } = cellStatus(g, wid);
        if (status !== 'same') setVerdict(g, wid, { accepted: true });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 操作：人工挪动配对（只在本版列内移动，禁止跨版串位）
// ---------------------------------------------------------------------------
/** 把某版列中 group 内的第 idx 个句子上移/下移到相邻组 */
function moveSentence(groupId: string, versionId: string, sentenceId: string, direction: -1 | 1) {
  const p = currentProject.value;
  if (!p) return;
  const gi = groupIndex(groupId);
  const target = gi + direction;
  if (gi < 0 || target < 0 || target >= p.groups.length) return;
  const from = p.groups[gi];
  const to = p.groups[target];
  // 底本列不允许直接移句（底本为锚），底本调整通过合并/拆分组完成
  if (versionId === p.baseVersionId) return;
  // 插入组（底本为空）只与同是插入组或带底本组交换该列句；不允许跨版
  commit(direction < 0 ? '已将该句在本版列内上移配对' : '已将该句在本版列内下移配对', () => {
    const fromList = [...(from.cells[versionId] ?? [])];
    const at = fromList.indexOf(sentenceId);
    if (at < 0) return;
    fromList.splice(at, 1);
    setCellList(from, versionId, fromList);
    const toList = [...(to.cells[versionId] ?? [])];
    // 下移放表头，上移放表尾，符合直觉
    if (direction > 0) toList.unshift(sentenceId);
    else toList.push(sentenceId);
    setCellList(to, versionId, toList);
    from.manual = true;
    to.manual = true;
    from.locked = true;
    to.locked = true;
  });
}

function setCellList(group: AlignGroup, versionId: string, ids: string[]) {
  if (ids.length) group.cells[versionId] = ids;
  else delete group.cells[versionId];
}

/** 把该句从所在组拆出（本版列），并在该位置新建一个只含该句的插入组（同版） */
function detachSentence(groupId: string, versionId: string, sentenceId: string) {
  const p = currentProject.value;
  if (!p || versionId === p.baseVersionId) return;
  const gi = groupIndex(groupId);
  if (gi < 0) return;
  commit('已将该句拆出原配对组', () => {
    const source = p.groups[gi];
    const list = [...(source.cells[versionId] ?? [])];
    const at = list.indexOf(sentenceId);
    if (at < 0) return;
    list.splice(at, 1);
    setCellList(source, versionId, list);
    const created: AlignGroup = {
      id: uid('grp'),
      baseSentenceId: null,
      cells: { [versionId]: [sentenceId] },
      locked: true,
      manual: true
    };
    p.groups.splice(gi + 1, 0, created);
    source.manual = true;
    source.locked = true;
  });
}

/** 合并相邻两组（底本句仍保留两组？——合并为单组：底本句取后者，前者底本句也并入底本列概念不存在） */
function mergeWithNext(groupId: string) {
  const p = currentProject.value;
  if (!p) return;
  const gi = groupIndex(groupId);
  if (gi < 0 || gi + 1 >= p.groups.length) return;
  commit('已合并相邻两组', () => {
    const a = p.groups[gi];
    const b = p.groups[gi + 1];
    const merged: AlignGroup = {
      id: uid('grp'),
      // 两个底本句：以 a 的底本句为主，b 的底本句若不同则无法放入底本列；
      // 为避免丢句，把 b 的底本句在底本列特殊处理：记录到 baseExtraIds
      baseSentenceId: a.baseSentenceId ?? b.baseSentenceId,
      cells: {},
      locked: true,
      manual: true
    };
    for (const g of [a, b]) {
      for (const [vid, ids] of Object.entries(g.cells)) {
        merged.cells[vid] = [...(merged.cells[vid] ?? []), ...ids];
      }
    }
    const extraBase = [a, b].map((g) => g.baseSentenceId).filter((id): id is string => Boolean(id) && id !== merged.baseSentenceId);
    if (extraBase.length) {
      merged.baseExtraIds = extraBase;
    }
    p.groups.splice(gi, 2, merged);
  });
}

function toggleLock(groupId: string) {
  const p = currentProject.value;
  if (!p) return;
  const group = p.groups.find((g) => g.id === groupId);
  if (!group) return;
  commit(group.locked ? '已解锁该组，重新对齐时可自动调整' : '已锁定该组，重新对齐时保持不动', () => {
    group.locked = !group.locked;
    if (group.locked) group.manual = true;
  });
}

// ---------------------------------------------------------------------------
// 校记（挂在版本+句子上，每句一篇）
// ---------------------------------------------------------------------------
function annotationFor(versionId: string, sentenceId: string | null): Annotation | undefined {
  const p = currentProject.value;
  if (!p || !sentenceId) return undefined;
  return Object.values(p.annotations).find((a) => a.versionId === versionId && a.sentenceId === sentenceId);
}

function saveAnnotation(versionId: string, sentenceId: string, note: string, source: string) {
  const p = currentProject.value;
  if (!p) return;
  commit('校记与来源已保存（随原句走）', () => {
    const existing = annotationFor(versionId, sentenceId);
    if (existing) {
      existing.note = note;
      existing.source = source;
      existing.updatedAt = new Date().toISOString();
    } else {
      const ann = createAnnotation(versionId, sentenceId, note, source);
      p.annotations[ann.id] = ann;
    }
  });
}

function claimOrphan(orphanId: string, versionId: string, sentenceId: string) {
  const p = currentProject.value;
  if (!p) return;
  commit('失主校记已重新指认到句子', () => {
    const idx = p.orphans.findIndex((o) => o.id === orphanId);
    if (idx < 0) return;
    const [orphan] = p.orphans.splice(idx, 1);
    const ann: Annotation = {
      ...orphan,
      versionId,
      sentenceId,
      updatedAt: new Date().toISOString()
    };
    delete (ann as Partial<OrphanAnnotation>).originalText;
    delete (ann as Partial<OrphanAnnotation>).originalVersionId;
    p.annotations[ann.id] = ann;
  });
}

function deleteOrphan(orphanId: string) {
  const p = currentProject.value;
  if (!p) return;
  commit('已删除失主校记', () => {
    p.orphans = p.orphans.filter((o) => o.id !== orphanId);
  });
}

// ---------------------------------------------------------------------------
// 版本导入 / 替换 / 删除
// ---------------------------------------------------------------------------
async function importVersion(name: string, source: string, text: string): Promise<boolean> {
  const p = currentProject.value;
  if (!p) return false;
  if (p.versions.length >= MAX_VERSIONS) {
    message.value = `最多保留 ${MAX_VERSIONS} 个版本，请先删除或替换旧版本`;
    return false;
  }
  const id = uid('version');
  const doc = makeVersion(id, name.trim() || `版本 ${p.versions.length + 1}`, source.trim() || '手工导入', text);
  commit(`已导入版本：${doc.name}`, () => {
    p.versions.push(doc);
    if (p.versions.length <= MAX_VERSIONS) p.witnessIds.push(id);
  });
  await realign({ label: '新版本已纳入对齐' });
  return true;
}

async function replaceVersion(versionId: string, name: string, source: string, text: string) {
  const p = currentProject.value;
  if (!p) return;
  const old = p.versions.find((v) => v.id === versionId);
  if (!old) return;
  const id = uid('version');
  const doc = makeVersion(id, name.trim() || old.name, source.trim() || old.source, text);
  history.value.push(snapshot());
  if (history.value.length > HISTORY_LIMIT) history.value.shift();
  future.value = [];
  // 校记迁移
  const migration = migrateAnnotationsForVersionReplace(p.annotations, p.orphans, old, doc, p.rules);
  p.annotations = migration.annotations;
  p.orphans = migration.orphans;
  p.versions = p.versions.map((v) => (v.id === versionId ? doc : v));
  if (p.baseVersionId === versionId) p.baseVersionId = id;
  p.witnessIds = p.witnessIds.map((wid) => (wid === versionId ? id : wid));
  message.value = `已替换《${doc.name}》：${migration.migrated} 条校记自动跟随，${migration.orphaned} 条进入失主池`;
  persist();
  await realign({ label: '版本替换后已重新对齐' });
}

function deleteVersion(versionId: string) {
  const p = currentProject.value;
  if (!p || p.versions.length <= 1) return;
  const name = versionName(versionId);
  commit(`已删除版本：${name}（其校记进入失主池备查）`, () => {
    // 该版本上的校记转失主，不直接删除
    for (const ann of Object.values(p.annotations)) {
      if (ann.versionId === versionId && ann.sentenceId) {
        const sentence = sentenceById(versionId, ann.sentenceId);
        p.orphans.push({
          ...ann,
          sentenceId: null,
          originalText: sentence?.text ?? '',
          originalVersionId: versionId
        });
      }
    }
    p.annotations = Object.fromEntries(Object.values(p.annotations).filter((a) => a.versionId !== versionId).map((a) => [a.id, a]));
    p.versions = p.versions.filter((v) => v.id !== versionId);
    p.witnessIds = p.witnessIds.filter((id) => id !== versionId);
    if (p.baseVersionId === versionId) {
      p.baseVersionId = p.versions[0].id;
      p.witnessIds = p.versions.slice(1, MAX_VERSIONS).map((v) => v.id);
    }
  });
  void realign({ label: '版本删除后已重新对齐' });
}

/** 重新分句（规则变化等场景）后迁移校记并重对齐 */
function resegmentVersion(versionId: string, text: string) {
  const p = currentProject.value;
  if (!p) return;
  const old = p.versions.find((v) => v.id === versionId);
  if (!old) return;
  commit('已按新文本重新分句并迁移校记', () => {
    const updated = makeVersion(versionId, old.name, old.source, text, old.createdAt);
    const migration = migrateAnnotationsForResegment(p.annotations, p.orphans, old.sentences, updated.sentences, p.rules, versionId);
    p.annotations = migration.annotations;
    p.orphans = migration.orphans;
    p.versions = p.versions.map((v) => (v.id === versionId ? updated : v));
    message.value = `重新分句：${migration.migrated} 条校记跟随，${migration.orphaned} 条进入失主池`;
  });
  void realign({ label: '重新分句后已重新对齐' });
}

// ---------------------------------------------------------------------------
// 跳转下一处差异（在当前片内循环，越片自动翻片）
// ---------------------------------------------------------------------------
const selectedGroupId = computed({
  get: () => currentProject.value?.selectedGroupId ?? '',
  set: (value: string) => {
    if (currentProject.value) {
      currentProject.value.selectedGroupId = value;
      persist();
    }
  }
});

function nextDifference() {
  const p = currentProject.value;
  if (!p) return;
  const groups = visibleGroups.value;
  const start = groups.findIndex((g) => g.id === p.selectedGroupId);
  for (let off = 1; off <= groups.length; off += 1) {
    const g = groups[(start + off) % groups.length];
    if (!g) continue;
    for (const wid of p.witnessIds) {
      const { status } = cellStatus(g, wid);
      if (status !== 'same' && !cellAccepted(g, wid)) {
        p.selectedGroupId = g.id;
        persist();
        return;
      }
    }
  }
  // 本片无差异，尝试跳到下一片
  const nextChunk = p.activeChunk + 1;
  if (chunks.value[nextChunk]) {
    p.activeChunk = nextChunk;
    persist();
    window.setTimeout(() => nextDifference(), 50);
  } else {
    message.value = '已到最后一片，没有更多未接受差异';
  }
}

// ---------------------------------------------------------------------------
// 多草稿管理
// ---------------------------------------------------------------------------
const draftList = computed(() =>
  [...projects.value]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, versions: p.versions.length }))
);

function switchProject(id: string) {
  if (id === currentProjectId.value) return;
  history.value = [];
  future.value = [];
  currentProjectId.value = id;
  const p = currentProject.value;
  if (p && p.activeChunk >= chunks.value.length) p.activeChunk = 0;
  selectedCell.value = null;
  message.value = `已打开草稿：${p?.name ?? ''}`;
  persist();
}

function renameProject(name: string) {
  const p = currentProject.value;
  if (!p) return;
  commit('草稿已重命名', () => {
    p.name = name.trim() || p.name;
  });
}

async function newProject(name: string) {
  const id = uid('proj');
  const versions = clone(sampleVersions).slice(0, 3);
  const project: CollationProject = {
    schema: 2,
    id,
    name: name.trim() || `新校勘项目 ${projects.value.length + 1}`,
    versions,
    baseVersionId: versions[0].id,
    witnessIds: versions.slice(1).map((v) => v.id),
    groups: [],
    annotations: {},
    verdicts: {},
    orphans: [],
    rules: defaultRules(),
    selectedGroupId: '',
    activeChunk: 0,
    updatedAt: new Date().toISOString()
  };
  projects.value.push(project);
  currentProjectId.value = id;
  history.value = [];
  future.value = [];
  persist();
  await realign({ label: '新项目已创建并对齐' });
}

async function importProjectFile(json: string): Promise<boolean> {
  try {
    const data = JSON.parse(json) as CollationProject;
    if (!data.schema || !Array.isArray(data.versions)) throw new Error('bad');
    data.id = uid('proj');
    data.groups = data.groups ?? [];
    data.annotations = data.annotations ?? {};
    data.verdicts = data.verdicts ?? {};
    data.orphans = data.orphans ?? [];
    data.rules = { ...defaultRules(), ...data.rules };
    projects.value.push(data);
    currentProjectId.value = data.id;
    history.value = [];
    future.value = [];
    persist();
    if (!data.groups.length) await realign({ label: '导入项目已自动对齐' });
    message.value = `已打开旧草稿：${data.name}`;
    return true;
  } catch {
    return false;
  }
}

function exportProjectJson(): string {
  return JSON.stringify(currentProject.value, null, 2);
}

// ---------------------------------------------------------------------------
// 导出：Markdown 校勘记（多版本对照）
// ---------------------------------------------------------------------------
function statusLabel(status: DifferenceStatus): string {
  return { same: '相同', changed: '改动', added: '新增', removed: '删减', misaligned: '疑错位' }[status];
}

function exportMarkdown(): string {
  const p = currentProject.value;
  if (!p || !baseVersion.value) return '';
  const lines: string[] = [];
  lines.push(`# ${p.name} · 校勘记`, '');
  lines.push(`- 底本：${baseVersion.value.name}${baseVersion.value.source ? `（${baseVersion.value.source}）` : ''}`);
  for (const w of witnessVersions.value) {
    lines.push(`- 参校本：${w.name}${w.source ? `（${w.source}）` : ''}`);
  }
  lines.push(`- 比较规则：忽略标点 ${p.rules.ignorePunctuation ? '是' : '否'}；忽略异体字 ${p.rules.ignoreVariants ? '是' : '否'}；句匹配阈值 ${p.rules.matchThreshold}`);
  lines.push(`- 导出时间：${new Date().toLocaleString('zh-CN')}`, '');

  let counter = 0;
  p.groups.forEach((group, gi) => {
    // 插入组中「本版无句」是空白格而非差异；只有真正改/增/删/错位或有校记才成条
    const statuses = p.witnessIds.map((wid) => ({ wid, info: cellStatus(group, wid), ids: group.cells[wid] ?? [] }));
    const hasRealDiff = statuses.some(({ info, ids }) => {
      if (info.status === 'same') return false;
      return Boolean(ids.length) || Boolean(group.baseSentenceId);
    });
    const hasNote = p.witnessIds.some((wid) =>
      (group.cells[wid] ?? []).some((sid) => annotationFor(wid, sid))
    );
    const baseSentence = group.baseSentenceId ? sentenceById(p.baseVersionId, group.baseSentenceId) : undefined;
    const baseAnn = baseSentence ? annotationFor(p.baseVersionId, baseSentence.id) : undefined;
    if (!hasRealDiff && !hasNote && !baseAnn?.note) return;
    counter += 1;
    lines.push(`## ${counter}. 第 ${gi + 1} 组${baseSentence ? `（底本段 ${baseSentence.paragraphOrder}·句 ${baseSentence.sentenceInParagraph}）` : '（底本无对应句·新增）'}`);
    lines.push('');
    lines.push(`- **底本**：${baseSentence?.text ?? '（无）'}`);
    if (baseAnn?.note) lines.push(`  - 底本校记：${baseAnn.note}`);
    if (baseAnn?.source) lines.push(`  - 底本来源：${baseAnn.source}`);
    for (const { wid, info, ids } of statuses) {
      const w = p.versions.find((v) => v.id === wid);
      const texts = ids.map((sid) => sentenceById(wid, sid)?.text ?? '').filter(Boolean);
      if (!ids.length && !group.baseSentenceId) continue;
      const accepted = cellAccepted(group, wid);
      const tag = info.status === 'same' && texts.length ? '' : `【${statusLabel(info.status)}${accepted ? '·已接受' : ''}】`;
      lines.push(`- **${w?.name ?? wid}**${tag}：${texts.join(' / ') || '（无）'}`);
      for (const sid of ids) {
        const ann = annotationFor(wid, sid);
        if (ann?.note) lines.push(`  - 校记：${ann.note}`);
        if (ann?.source) lines.push(`  - 来源：${ann.source}`);
      }
    }
    lines.push('');
  });
  lines.push(`共 ${counter} 组差异记录，失主校记 ${p.orphans.length} 条。`);
  return lines.join('\n');
}

/** 导出对照全文：每组都列出，即使相同 */
function exportComparisonHtml(): string {
  const p = currentProject.value;
  if (!p || !baseVersion.value) return '';
  const esc = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const cols = [baseVersion.value, ...witnessVersions.value];
  const rows = p.groups
    .map((g, gi) => {
      const baseTexts = baseSentencesOf(g).map((s) => s.text);
      const baseNotesHtml = baseSentencesOf(g)
        .map((s) => annotationFor(p.baseVersionId, s.id))
        .filter(Boolean)
        .map((a) => `<div class="note">底本校记：${esc(a!.note)}${a!.source ? `（${esc(a!.source)}）` : ''}</div>`)
        .join('');
      const tds = cols
        .map((v) => {
          if (v.id === p.baseVersionId) {
            return `<td class="base">${baseTexts.map(esc).join('<br>') || '—'}${baseNotesHtml}</td>`;
          }
          const sids = g.cells[v.id] ?? [];
          const txt = sids.map((sid) => sentenceById(v.id, sid)?.text ?? '').join(' / ');
          const { status } = cellStatus(g, v.id);
          const notes = sids
            .map((sid) => annotationFor(v.id, sid))
            .filter(Boolean)
            .map((a) => `<div class="note">校记：${esc(a!.note)}${a!.source ? `（${esc(a!.source)}）` : ''}</div>`)
            .join('');
          return `<td class="${status}">${esc(txt) || '—'}${notes}</td>`;
        })
        .join('');
      return `<tr><td class="idx">${gi + 1}</td>${tds}</tr>`;
    })
    .join('\n');
  const headers = cols.map((v) => `<th>${esc(v.name)}<br><small>${esc(v.source)}</small></th>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(p.name)} 多版本对照</title>
<style>
body{font-family:"Songti SC","Noto Serif SC",serif;margin:24px;color:#1d2129}
h1{font-size:20px}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{border:1px solid #c9cdd4;padding:8px 10px;vertical-align:top;line-height:1.8;min-width:180px}
th{background:#f2f3f5;position:sticky;top:0}
td.base{background:#f7f8fa;font-weight:600}
td.changed{background:#fff7e8}td.added{background:#e8ffea}td.removed{background:#ffece8}td.misaligned{background:#e8f3ff}
.idx{color:#86909c;width:40px;text-align:center}
.note{margin-top:6px;color:#0e42d2;font-size:13px;font-family:sans-serif}
small{color:#86909c;font-weight:400}
</style></head><body>
<h1>${esc(p.name)} · 多版本对照</h1>
<p>底本：${esc(baseVersion.value.name)} ｜ 导出时间：${new Date().toLocaleString('zh-CN')} ｜ 共 ${p.groups.length} 组</p>
<table><thead><tr><th>#</th>${headers}</tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeFileName(name: string) {
  return name.replaceAll(/[\\/:*?"<>|]/g, '_');
}

function handleExport(kind: 'markdown' | 'json' | 'html') {
  const p = currentProject.value;
  if (!p) return;
  const base = safeFileName(p.name);
  if (kind === 'markdown') download(`${base}-校勘记.md`, exportMarkdown(), 'text/markdown;charset=utf-8');
  else if (kind === 'html') download(`${base}-多版本对照.html`, exportComparisonHtml(), 'text/html;charset=utf-8');
  else download(`${base}-校勘数据.json`, exportProjectJson(), 'application/json;charset=utf-8');
}

// 供 UI 调用的取数工具
function getCellDiff(group: AlignGroup, versionId: string) {
  return cellDiffTokens(group, versionId);
}
function getCellStatus(group: AlignGroup, versionId: string) {
  return cellStatus(group, versionId);
}
function getCellAccepted(group: AlignGroup, versionId: string) {
  return cellAccepted(group, versionId);
}

export function useCollation() {
  return {
    // state
    projects,
    currentProjectId,
    currentProject,
    history,
    future,
    message,
    processing,
    progress,
    progressPhase,
    // derived
    baseVersion,
    witnessVersions,
    activeVersions,
    visibleGroups,
    chunks,
    stats,
    unresolvedCount,
    rules,
    selectedGroupId,
    selectedCell,
    draftList,
    MAX_VERSIONS,
    // lifecycle
    load,
    undo,
    redo,
    // alignment & config
    realign,
    setBaseVersion,
    toggleWitness,
    updateRules,
    setActiveChunk,
    // verdicts
    getCellStatus,
    getCellAccepted,
    getCellDiff,
    overrideStatus,
    clearOverride,
    acceptCell,
    unacceptCell,
    acceptVisible,
    // manual editing
    moveSentence,
    detachSentence,
    mergeWithNext,
    toggleLock,
    // annotations
    annotationFor,
    saveAnnotation,
    claimOrphan,
    deleteOrphan,
    sentenceById,
    baseSentencesOf,
    // versions
    importVersion,
    replaceVersion,
    deleteVersion,
    resegmentVersion,
    // navigation
    nextDifference,
    groupIndex,
    // drafts
    switchProject,
    renameProject,
    newProject,
    importProjectFile,
    handleExport,
    exportMarkdown,
    exportComparisonHtml,
    download,
    statusLabel
  };
}
