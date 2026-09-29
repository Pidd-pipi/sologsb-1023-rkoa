import { computed, ref } from 'vue';
import type {
  AlignmentGroup,
  Annotation,
  Cell,
  CellStatus,
  ComparisonRules,
  Draft,
  PersistedState,
  VersionDocument
} from '../types';
import { statusLabelMap } from '../types';
import { alignVersions, recalculateStatuses } from '../lib/align';
import { hashText, uid } from '../lib/text';
import { buildDocument, createSampleDocuments } from '../data';

const STORAGE_KEY = 'collation-drafts-v2';
const HISTORY_LIMIT = 50;

export function statusLabel(status: CellStatus): string {
  return statusLabelMap[status];
}

const defaultRules: ComparisonRules = {
  ignorePunctuation: false,
  ignoreVariants: false,
  misalignThreshold: 0.35
};

// ---------- localStorage 读取 ----------
function loadStore(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.drafts && parsed.drafts[parsed.currentDraftId]) return migrate(parsed);
    }
  } catch {
    // 损坏数据则重建
  }
  return createInitialStore();
}

function migrate(parsed: PersistedState): PersistedState {
  Object.values(parsed.drafts).forEach((d) => {
    d.rules = { ...defaultRules, ...d.rules };
    d.annotations = d.annotations ?? {};
    d.activeVersionIds = (d.activeVersionIds ?? d.versions.map((v) => v.id)).filter((vid) =>
      d.versions.some((v) => v.id === vid)
    );
  });
  return { ...parsed, version: 2 };
}

function createInitialStore(): PersistedState {
  const docs = createSampleDocuments();
  const now = new Date().toISOString();
  const id = uid('draft');
  const initialDraft: Draft = {
    id,
    name: '《道德经》十五章 · 示例校勘',
    createdAt: now,
    updatedAt: now,
    versions: docs,
    baseVersionId: docs[0].id,
    activeVersionIds: docs.map((d) => d.id),
    groups: [],
    annotations: {},
    rules: { ...defaultRules },
    selectedGroupId: null
  };
  return {
    version: 2,
    currentDraftId: id,
    draftIds: [id],
    drafts: { [id]: initialDraft }
  };
}

interface SnapshotData extends Omit<Draft, 'id' | 'name' | 'createdAt' | 'updatedAt'> {}

export function useCollation() {
  const store = ref<PersistedState>(loadStore());
  const draft = ref<Draft>(store.value.drafts[store.value.currentDraftId]);

  // ---------- 工作状态 ----------
  const processing = ref(false);
  const progress = ref(0);
  const progressPhase = ref('');
  const message = ref('草稿自动保存在当前浏览器，可随时切换或导出');
  const selectedGroupId = ref<string | null>(draft.value.selectedGroupId);
  const selectedGroupIds = ref<string[]>([]);
  const rules = ref<ComparisonRules>({ ...draft.value.rules });

  // ---------- 撤销 / 重做（仅内存，最多 50 步） ----------
  const past: string[] = [];
  const future: string[] = [];
  const canUndo = ref(false);
  const canRedo = ref(false);

  function snapshot(): string {
    return JSON.stringify({
      versions: draft.value.versions,
      baseVersionId: draft.value.baseVersionId,
      activeVersionIds: draft.value.activeVersionIds,
      groups: draft.value.groups,
      annotations: draft.value.annotations,
      rules: draft.value.rules,
      selectedGroupId: draft.value.selectedGroupId

    } satisfies SnapshotData);
  }

  function restore(json: string): void {
    const data = JSON.parse(json) as SnapshotData;
    draft.value.versions = data.versions;
    draft.value.baseVersionId = data.baseVersionId;
    draft.value.activeVersionIds = data.activeVersionIds;
    draft.value.groups = data.groups;
    draft.value.annotations = data.annotations;
    draft.value.rules = data.rules;
    draft.value.selectedGroupId = data.selectedGroupId;
    rules.value = { ...data.rules };
    selectedGroupId.value = data.selectedGroupId;
  }

  function pushHistory(): void {
    past.push(snapshot());
    if (past.length > HISTORY_LIMIT) past.shift();
    future.length = 0;
    canUndo.value = true;
    canRedo.value = false;
  }

  function undo(): void {
    const prev = past.pop();
    if (!prev) return;
    future.push(snapshot());
    restore(prev);
    canUndo.value = past.length > 0;
    canRedo.value = true;
    message.value = '已撤销';
    persist();
  }

  function redo(): void {
    const next = future.pop();
    if (!next) return;
    past.push(snapshot());
    restore(next);
    canUndo.value = true;
    canRedo.value = future.length > 0;
    message.value = '已重做';
    persist();
  }

  // ---------- 自动保存 ----------
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persist(): void {
    draft.value.updatedAt = new Date().toISOString();
    draft.value.selectedGroupId = selectedGroupId.value;
    draft.value.rules = rules.value;
    store.value.drafts[draft.value.id] = JSON.parse(JSON.stringify(draft.value)) as Draft;
    store.value.currentDraftId = draft.value.id;
    if (!store.value.draftIds.includes(draft.value.id)) store.value.draftIds.push(draft.value.id);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store.value));
    } catch {
      message.value = '本地存储空间不足，请及时导出 JSON 备份';
    }
  }

  function schedulePersist(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  }

  // ---------- 派生数据 ----------
  const versions = computed(() => draft.value.versions);

  const baseVersionId = computed({
    get: () => draft.value.baseVersionId,
    set: (value: string) => {
      if (value && value !== draft.value.baseVersionId) {
        pushHistory();
        draft.value.baseVersionId = value;
        if (!draft.value.activeVersionIds.includes(value)) draft.value.activeVersionIds.push(value);
        message.value = `底本已切换为《${versionName(value)}》，正在重新对齐`;
        persist();
        void runAlignment('底本切换后重新对齐');
      }
    }
  });

  const activeVersionIds = computed(() => draft.value.activeVersionIds);
  const groups = computed(() => draft.value.groups);
  const annotations = computed(() => draft.value.annotations);

  const activeVersions = computed(() =>
    draft.value.activeVersionIds
      .map((id) => draft.value.versions.find((v) => v.id === id))
      .filter((v): v is VersionDocument => Boolean(v))
  );
  const otherActiveVersions = computed(() => activeVersions.value.filter((v) => v.id !== draft.value.baseVersionId));

  function versionName(id: string): string {
    return draft.value.versions.find((v) => v.id === id)?.name ?? '未知版本';
  }

  function getVersion(id: string): VersionDocument | undefined {
    return draft.value.versions.find((v) => v.id === id);
  }

  const selectedGroup = computed(() => draft.value.groups.find((g) => g.id === selectedGroupId.value) ?? null);

  const differenceGroups = computed(() =>
    draft.value.groups.filter((g) =>
      Object.values(g.cells).some((c) => ['changed', 'added', 'removed', 'misaligned'].includes(c.status))
    )
  );
  const unresolvedCount = computed(() => differenceGroups.value.filter((g) => !g.accepted).length);
  const acceptedCount = computed(() => differenceGroups.value.filter((g) => g.accepted).length);

  // ---------- 校记：按 版本 + 原句内容哈希 锚定，重对齐不丢 ----------
  function annotationKey(versionId: string, text: string): string {
    return `${versionId}::${hashText(text)}`;
  }

  function getAnnotation(versionId: string, text: string | undefined): Annotation | undefined {
    if (!text) return undefined;
    return draft.value.annotations[annotationKey(versionId, text)];
  }

  function saveAnnotation(versionId: string, text: string | undefined, note: string, source: string): void {
    if (!text) return;
    pushHistory();
    const key = annotationKey(versionId, text);
    draft.value.annotations[key] = {
      key,
      versionId,
      textHash: hashText(text),
      note: note.trim(),
      source: source.trim(),
      updatedAt: new Date().toISOString()
    };
    message.value = '校记已保存，随原句走，重新对齐也会保留';
    persist();
  }

  // ---------- 自动对齐 ----------
  /** 人工改判记录：重新对齐后按 版本+句子内容 恢复 */
  function collectManualStatuses(): Map<string, CellStatus> {
    const map = new Map<string, CellStatus>();
    draft.value.groups.forEach((g) => {
      Object.values(g.cells).forEach((cell) => {
        if (cell.manuallyAdjusted && cell.unit && cell.manualStatus) {
          map.set(annotationKey(cell.unit.versionId, cell.unit.text), cell.manualStatus);
        }
      });
    });
    return map;
  }

  function reorderGroups(list: AlignmentGroup[]): AlignmentGroup[] {
    return list.map((g, index) => ({ ...g, order: index + 1 }));
  }

  async function runAlignment(label = '自动对齐完成'): Promise<void> {
    if (processing.value) return;
    const base = draft.value.versions.find((v) => v.id === draft.value.baseVersionId);
    if (!base) {
      message.value = '请先指定底本';
      return;
    }
    if (draft.value.activeVersionIds.length < 2) {
      message.value = '至少需要底本与一个参校本（共 2 个版本）才能对齐';
      pushHistory();
      draft.value.groups = [];
      persist();
      return;
    }
    processing.value = true;
    progress.value = 0;
    progressPhase.value = '准备对齐';
    pushHistory();
    const manualStatuses = collectManualStatuses();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await alignVersions(
        base,
        draft.value.versions,
        draft.value.activeVersionIds,
        rules.value,
        async (p) => {
          progress.value = p.percent;
          progressPhase.value = p.phase;
        }
      );
      result.forEach((g) => {
        Object.entries(g.cells).forEach(([versionId, cell]) => {
          if (cell.unit && versionId !== base.id) {
            const override = manualStatuses.get(annotationKey(versionId, cell.unit.text));
            // 新增/删减取决于配对结构，不跨配对恢复，只恢复句对层面的判定
            if (override && override !== 'added' && override !== 'removed') {
              cell.status = override;
              cell.manuallyAdjusted = true;
              cell.manualStatus = override;
            }
          }
        });
      });
      draft.value.groups = reorderGroups(result);
      if (!draft.value.groups.some((g) => g.id === selectedGroupId.value)) selectedGroupId.value = null;
      message.value = `${label}：${result.length} 个对齐组，校记与人工判定已尽量保留`;
    } finally {
      processing.value = false;
      persist();
    }
  }

  /** 改规则：只重算状态，不重建对齐，不动校记 */
  function recalculate(): void {
    pushHistory();
    draft.value.groups = recalculateStatuses(draft.value.groups, draft.value.baseVersionId, rules.value);
    message.value = '比较规则已应用，只重算判定，对齐结构与校记不变';
    persist();
  }

  // ---------- 人工挪动：只在同版列内交换，版本不串位 ----------
  /** 把某版本在本组的句与相邻（上/下）一个该版列句交换配对 */
  function shiftCell(groupId: string, versionId: string, dir: -1 | 1): void {
    const index = draft.value.groups.findIndex((g) => g.id === groupId);
    if (index < 0) return;
    let target = index + dir;
    while (target >= 0 && target < draft.value.groups.length && !draft.value.groups[target].cells[versionId]) {
      target += dir;
    }
    if (target < 0 || target >= draft.value.groups.length) {
      message.value = '已经到边，没有可交换的同版本句';
      return;
    }
    pushHistory();
    const a = draft.value.groups[index];
    const b = draft.value.groups[target];
    const cellA = a.cells[versionId];
    const cellB = b.cells[versionId];

    const movedA = cellB ? { ...cellB, manuallyAdjusted: true } : undefined;
    const movedB = cellA ? { ...cellA, manuallyAdjusted: true } : undefined;
    if (movedA) {
      a.cells[versionId] = movedA;
      settleCell(a, versionId);
    } else {
      delete a.cells[versionId];
    }
    if (movedB) {
      b.cells[versionId] = movedB;
      settleCell(b, versionId);
    } else {
      delete b.cells[versionId];
    }
    message.value = '已在同版列内交换配对，版本列未串位';
    persist();
  }

  /** 挪动后依据是否有底本、是否有句重新判定 */
  function settleCell(group: AlignmentGroup, versionId: string): void {
    if (versionId === draft.value.baseVersionId) return;
    const cell = group.cells[versionId];
    if (!cell) return;
    const baseCell = group.cells[draft.value.baseVersionId];
    if (!baseCell?.unit) {
      if (cell.unit) {
        cell.status = 'added';
        cell.manualStatus = 'added';
      }
      return;
    }
    if (!cell.unit) {
      cell.status = 'removed';
      cell.manualStatus = 'removed';
      return;
    }
    if (cell.manualStatus === 'added' || cell.manualStatus === 'removed') {
      cell.manualStatus = undefined;
    }
    cell.manuallyAdjusted = true;
  }

  /** 整组上下移动：组内各版绑定在一起，校记来源不脱钩 */
  function moveGroup(groupId: string, dir: -1 | 1): void {
    const index = draft.value.groups.findIndex((g) => g.id === groupId);
    const targetIndex = index + dir;
    if (index < 0 || targetIndex < 0 || targetIndex >= draft.value.groups.length) return;
    pushHistory();
    const list = [...draft.value.groups];
    const [item] = list.splice(index, 1);
    list.splice(targetIndex, 0, item);
    draft.value.groups = reorderGroups(list);
    message.value = '整组已移动，组内各版与校记保持绑定';
    persist();
  }

  /** 手动改判某格 */
  function setCellStatus(groupId: string, versionId: string, status: CellStatus): void {
    const group = draft.value.groups.find((g) => g.id === groupId);
    const cell = group?.cells[versionId];
    if (!cell) return;
    pushHistory();
    cell.status = status;
    cell.manuallyAdjusted = true;
    cell.manualStatus = status;
    message.value = `已标记为「${statusLabelMap[status]}」`;
    persist();
  }

  // ---------- 接受 ----------
  function setAccepted(ids: string[], accepted: boolean): void {
    pushHistory();
    draft.value.groups.forEach((g) => {
      if (ids.includes(g.id)) g.accepted = accepted;
    });
    message.value = accepted ? `已接受 ${ids.length} 组校勘建议` : '已撤回接受状态';
    persist();
  }

  function acceptRows(ids: string[]): void {
    setAccepted(ids, true);
  }

  function acceptAll(): void {
    const ids = differenceGroups.value.filter((g) => !g.accepted).map((g) => g.id);
    if (ids.length) acceptRows(ids);
  }

  // 由视图层注册滚动回调
  let scrollToGroupHandler: ((id: string) => void) | null = null;
  function registerScrollToGroup(handler: (id: string) => void): void {
    scrollToGroupHandler = handler;
  }

  function nextDifference(): void {
    const unresolved = differenceGroups.value.filter((g) => !g.accepted);
    if (!unresolved.length) {
      message.value = '所有差异都已处理';
      return;
    }
    const current = selectedGroupId.value;
    const idx = unresolved.findIndex((g) => g.id === current);
    const nextGroup = unresolved[(idx + 1) % unresolved.length];
    selectedGroupId.value = nextGroup.id;
    scrollToGroupHandler?.(nextGroup.id);
  }

  function scrollToGroup(id: string): void {
    scrollToGroupHandler?.(id);
  }

  // ---------- 版本管理 ----------
  const MAX_VERSIONS = 5;

  function addVersion(name: string, source: string, text: string): boolean {
    if (draft.value.versions.length >= MAX_VERSIONS) {
      message.value = `一个草稿最多载入 ${MAX_VERSIONS} 个版本`;
      return false;
    }
    pushHistory();
    const doc = buildDocument(name, source, text);
    draft.value.versions.push(doc);
    draft.value.activeVersionIds.push(doc.id);
    message.value = `已导入《${name}》，正在重新对齐`;
    persist();
    void runAlignment('导入版本后重新对齐');
    return true;
  }

  function updateVersionText(versionId: string, name: string, source: string, text: string): void {
    const doc = draft.value.versions.find((v) => v.id === versionId);
    if (!doc) return;
    pushHistory();
    const rebuilt = buildDocument(name || doc.name, source, text, versionId);
    rebuilt.createdAt = doc.createdAt;
    Object.assign(doc, rebuilt);
    message.value = `《${doc.name}》正文已更新，正在重新对齐`;
    persist();
    void runAlignment('更新正文后重新对齐');
  }

  function toggleActiveVersion(versionId: string): void {
    if (versionId === draft.value.baseVersionId) {
      message.value = '底本始终参与对照，不能取消';
      return;
    }
    pushHistory();
    if (draft.value.activeVersionIds.includes(versionId)) {
      draft.value.activeVersionIds = draft.value.activeVersionIds.filter((id) => id !== versionId);
    } else {
      if (draft.value.activeVersionIds.length >= MAX_VERSIONS) {
        message.value = `最多同时对照 ${MAX_VERSIONS} 个版本`;
        past.pop();
        canUndo.value = past.length > 0;
        return;
      }
      draft.value.activeVersionIds = [...draft.value.activeVersionIds, versionId];
    }
    message.value = '参与对照的版本已变更，正在重新对齐';
    persist();
    void runAlignment('版本选择变更后重新对齐');
  }

  function setBaseAndRun(versionId: string): void {
    baseVersionId.value = versionId;
  }

  function removeVersion(versionId: string): void {
    pushHistory();
    draft.value.versions = draft.value.versions.filter((v) => v.id !== versionId);
    draft.value.activeVersionIds = draft.value.activeVersionIds.filter((id) => id !== versionId);
    if (draft.value.baseVersionId === versionId) {
      draft.value.baseVersionId = draft.value.versions[0]?.id ?? '';
    }
    if (draft.value.versions.length >= 2 && draft.value.activeVersionIds.length >= 2) {
      message.value = '版本已删除，正在重新对齐';
      persist();
      void runAlignment('删除版本后重新对齐');
    } else {
      draft.value.groups = [];
      message.value = '版本已删除';
      persist();
    }
  }

  // ---------- 草稿管理 ----------
  const draftList = computed(() =>
    [...store.value.draftIds]
      .map((id) => store.value.drafts[id])
      .filter(Boolean)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  );

  function createDraft(name: string): void {
    persist();
    const docs = createSampleDocuments();
    const now = new Date().toISOString();
    const id = uid('draft');
    const fresh: Draft = {
      id,
      name: name || `校勘草稿 ${store.value.draftIds.length + 1}`,
      createdAt: now,
      updatedAt: now,
      versions: docs,
      baseVersionId: docs[0].id,
      activeVersionIds: docs.map((d) => d.id),
      groups: [],
      annotations: {},
      rules: { ...defaultRules },
      selectedGroupId: null
    };
    store.value.drafts[id] = fresh;
    store.value.draftIds.push(id);
    switchDraft(id);
  }

  function createBlankDraft(name: string): void {
    persist();
    const now = new Date().toISOString();
    const id = uid('draft');
    const fresh: Draft = {
      id,
      name: name || `校勘草稿 ${store.value.draftIds.length + 1}`,
      createdAt: now,
      updatedAt: now,
      versions: [],
      baseVersionId: '',
      activeVersionIds: [],
      groups: [],
      annotations: {},
      rules: { ...defaultRules },
      selectedGroupId: null
    };
    store.value.drafts[id] = fresh;
    store.value.draftIds.push(id);
    switchDraft(id);
  }

  function switchDraft(id: string): void {
    const target = store.value.drafts[id];
    if (!target || id === draft.value.id) return;
    persist();
    past.length = 0;
    future.length = 0;
    canUndo.value = false;
    canRedo.value = false;
    draft.value = target;
    rules.value = { ...target.rules };
    selectedGroupId.value = target.selectedGroupId;
    selectedGroupIds.value = [];
    store.value.currentDraftId = id;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.value));
    message.value = `已打开草稿《${target.name}》，校记与历史对齐均已载入`;
  }

  function renameDraft(name: string): void {
    if (name.trim()) {
      draft.value.name = name.trim();
      persist();
    }
  }

  function deleteDraft(id: string): void {
    delete store.value.drafts[id];
    store.value.draftIds = store.value.draftIds.filter((d) => d !== id);
    if (store.value.currentDraftId === id) store.value.currentDraftId = '';
    const nextId = store.value.draftIds[0];
    if (nextId) {
      switchDraft(nextId);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store.value));
      createBlankDraft('校勘草稿 1');
    }
  }

  /** 导入旧草稿 JSON（兼容本工具导出的完整数据） */
  function importDraftJson(json: string): boolean {
    try {
      const data = JSON.parse(json) as Draft;
      if (!data.versions || !data.id) return false;
      const id = !store.value.drafts[data.id] ? data.id : uid('draft');
      const now = new Date().toISOString();
      const imported: Draft = {
        ...data,
        id,
        updatedAt: now,
        versions: data.versions ?? [],
        activeVersionIds: (data.activeVersionIds ?? data.versions.map((v) => v.id)).filter((vid) =>
          (data.versions ?? []).some((v) => v.id === vid)
        ),
        groups: data.groups ?? [],
        annotations: data.annotations ?? {},
        rules: { ...defaultRules, ...data.rules },
        selectedGroupId: null
      };
      store.value.drafts[id] = imported;
      if (!store.value.draftIds.includes(id)) store.value.draftIds.push(id);
      switchDraft(id);
      message.value = '旧草稿已打开，原有校记与对齐数据均已恢复';
      return true;
    } catch {
      return false;
    }
  }

  // ---------- 导出 ----------
  function exportMarkdown(onlyDifferences = false): string {
    const out: string[] = [];
    const baseName = versionName(draft.value.baseVersionId);
    out.push(`# ${draft.value.name} · 多版本校勘记`);
    out.push('');
    out.push(`- 底本：${baseName || '（未指定）'}`);
    out.push(`- 参校本：${otherActiveVersions.value.map((v) => v.name).join('、') || '（无）'}`);
    out.push(
      `- 规则：${rules.value.ignorePunctuation ? '忽略标点' : '保留标点'}；${
        rules.value.ignoreVariants ? '忽略常见异体字' : '不忽略异体字'
      }；疑错位阈值 ${Math.round(rules.value.misalignThreshold * 100)}%`
    );
    out.push(`- 导出时间：${new Date().toLocaleString()}`);
    out.push('');

    const list = onlyDifferences ? differenceGroups.value : draft.value.groups;
    let diffNo = 0;
    list.forEach((group) => {
      const isDiff = Object.values(group.cells).some((c) =>
        ['changed', 'added', 'removed', 'misaligned'].includes(c.status)
      );
      if (onlyDifferences && !isDiff) return;
      out.push(
        onlyDifferences
          ? `## 校 ${++diffNo}（段 ${group.paragraphOrder}）`
          : `## 段 ${group.paragraphOrder} · 组 ${group.order}`
      );
      out.push('');
      activeVersions.value.forEach((version) => {
        const cell = group.cells[version.id];
        if (!cell) {
          out.push(`- **${version.name}**［未参与本组］：（空）`);
          return;
        }
        const tag = cell.status === 'base' ? '底本' : statusLabelMap[cell.status];
        const text = cell.unit?.text ?? '（本版无此句，删减）';
        out.push(`- **${version.name}**［${tag}］：${text}`);
        const anno = getAnnotation(version.id, cell.unit?.text);
        if (anno?.note) out.push(`  - 校记：${anno.note}`);
        const source = anno?.source || version.source;
        if (source) out.push(`  - 来源：${source}`);
      });
      if (group.accepted) out.push('- 状态：已接受');
      out.push('');
    });
    return out.join('\n');
  }

  function exportJson(): string {
    persist();
    return JSON.stringify(draft.value, null, 2);
  }

  // ---------- 初始化 ----------
  if (!draft.value.groups.length && draft.value.versions.length >= 2) {
    void runAlignment('载入示例并自动对齐');
  }

  return {
    draft,
    versions,
    activeVersions,
    otherActiveVersions,
    baseVersionId,
    activeVersionIds,
    groups,
    annotations,
    rules,
    processing,
    progress,
    progressPhase,
    message,
    selectedGroupId,
    selectedGroupIds,
    selectedGroup,
    differenceGroups,
    unresolvedCount,
    acceptedCount,
    canUndo,
    canRedo,
    draftList,
    MAX_VERSIONS,
    runAlignment,
    recalculate,
    undo,
    redo,
    shiftCell,
    moveGroup,
    setCellStatus,
    acceptRows,
    acceptAll,
    nextDifference,
    scrollToGroup,
    addVersion,
    updateVersionText,
    toggleActiveVersion,
    setBaseAndRun,
    removeVersion,
    getVersion,
    versionName,
    getAnnotation,
    saveAnnotation,
    createDraft,
    createBlankDraft,
    switchDraft,
    renameDraft,
    deleteDraft,
    importDraftJson,
    exportMarkdown,
    exportJson,
    registerScrollToGroup
  };
}
