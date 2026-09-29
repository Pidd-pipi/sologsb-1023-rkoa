<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import AlignmentGrid from './components/AlignmentGrid.vue';
import { statusLabel, useCollation } from './composables/useCollation';
import type { CellStatus } from './types';

const collation = useCollation();
const {
  draft,
  versions,
  activeVersions,
  otherActiveVersions,
  baseVersionId,
  activeVersionIds,
  groups,
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
  addVersion,
  updateVersionText,
  toggleActiveVersion,
  setBaseAndRun,
  removeVersion,
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
} = collation;

// ---------- 弹窗与表单 ----------
const importVisible = ref(false);
const draftVisible = ref(false);
const editVersionId = ref<string | null>(null);
const importForm = ref({ name: '', source: '', text: '' });
const draftNameDraft = ref(draft.value.name);
const fileInput = ref<HTMLInputElement | null>(null);

function openImport() {
  editVersionId.value = null;
  importForm.value = {
    name: `导入版本 ${versions.value.length + 1}`,
    source: '',
    text: ''
  };
  importVisible.value = true;
}

function openDrafts() {
  draftNameDraft.value = draft.value.name;
  draftVisible.value = true;
}

function openEditVersion(versionId: string) {
  const version = versions.value.find((v) => v.id === versionId);
  if (!version) return;
  editVersionId.value = versionId;
  importForm.value = { name: version.name, source: version.source, text: version.text };
  importVisible.value = true;
}

function confirmImport() {
  if (!importForm.value.text.trim()) {
    Message.warning('请粘贴版本正文或选择文本文件');
    return;
  }
  if (editVersionId.value) {
    updateVersionText(editVersionId.value, importForm.value.name, importForm.value.source, importForm.value.text.trim());
  } else {
    const ok = addVersion(importForm.value.name, importForm.value.source, importForm.value.text.trim());
    if (!ok) return;
  }
  importVisible.value = false;
}

function handleFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    importForm.value.text = text;
    if (!importForm.value.name || importForm.value.name.startsWith('导入版本')) {
      importForm.value.name = file.name.replace(/\.[^.]+$/, '');
    }
  });
}

// ---------- 筛选 ----------
const onlyDifferences = ref(false);
const hideAccepted = ref(false);
const rowQuery = ref('');

const filteredGroups = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return groups.value.filter((group) => {
    if (onlyDifferences.value) {
      const hasDiff = Object.values(group.cells).some((c) =>
        ['changed', 'added', 'removed', 'misaligned'].includes(c.status)
      );
      if (!hasDiff) return false;
    }
    if (hideAccepted.value && group.accepted) return false;
    if (!query) return true;
    const haystack = [
      ...Object.values(group.cells).map((c) => c.unit?.text ?? ''),
      ...Object.entries(group.cells).map(([vid, c]) => getAnnotation(vid, c.unit?.text)?.note ?? ''),
      ...Object.entries(group.cells).map(([vid, c]) => getAnnotation(vid, c.unit?.text)?.source ?? '')
    ];
    return haystack.some((value) => value.toLocaleLowerCase().includes(query));
  });
});

// ---------- 网格引用 ----------
const gridRef = ref<InstanceType<typeof AlignmentGrid> | null>(null);
registerScrollToGroup((id) => {
  nextTick(() => gridRef.value?.scrollToGroupId(id));
});

function onSelectGroup(id: string) {
  selectedGroupId.value = id;
}

function onToggleCheck(id: string, checked: boolean) {
  if (checked) {
    if (!selectedGroupIds.value.includes(id)) selectedGroupIds.value = [...selectedGroupIds.value, id];
  } else {
    selectedGroupIds.value = selectedGroupIds.value.filter((g) => g !== id);
  }
}

// ---------- 右侧校记编辑 ----------
const noteVersionId = ref<string>('');
const noteText = ref('');
const noteSource = ref('');
const noteDraft = ref('');
const sourceDraft = ref('');

watch(
  selectedGroup,
  (group) => {
    if (!group) return;
    // 尽量保留用户正在看的版本页签；该版在新组无格时退回第一个有原句的版本
    const keep = activeVersions.value.find(
      (v) => v.id === noteVersionId.value && group.cells[v.id]
    );
    if (keep) {
      pickNoteCell(keep.id);
      return;
    }
    const firstVersion = activeVersions.value.find((v) => group.cells[v.id]);
    pickNoteCell(firstVersion?.id ?? '');
  },
  { immediate: true }
);

function pickNoteCell(versionId: string) {
  noteVersionId.value = versionId;
  const group = selectedGroup.value;
  const cell = group?.cells[versionId];
  const text = cell?.unit?.text ?? '';
  noteText.value = text;
  const anno = getAnnotation(versionId, text);
  const version = versions.value.find((v) => v.id === versionId);
  noteDraft.value = anno?.note ?? '';
  sourceDraft.value = anno?.source ?? version?.source ?? '';
}

function saveCurrentNote() {
  if (!noteVersionId.value || !noteText.value) {
    Message.warning('该格无原句，无法把校记锚定到句子');
    return;
  }
  saveAnnotation(noteVersionId.value, noteText.value, noteDraft.value, sourceDraft.value);
  Message.success('校记已保存');
}

function openAnnotate(groupId: string, versionId: string) {
  selectedGroupId.value = groupId;
  nextTick(() => pickNoteCell(versionId));
}

const noteStatusOptions: Array<{ value: CellStatus; label: string }> = [
  { value: 'same', label: '相同' },
  { value: 'changed', label: '改动' },
  { value: 'added', label: '新增' },
  { value: 'removed', label: '删减' },
  { value: 'misaligned', label: '疑错位' }
];

function selectedCellStatus(): CellStatus | '' {
  const group = selectedGroup.value;
  if (!group || !noteVersionId.value) return '';
  return group.cells[noteVersionId.value]?.status ?? '';
}

function changeStatus(status: unknown) {
  if (!selectedGroup.value || !noteVersionId.value) return;
  setCellStatus(selectedGroup.value.id, noteVersionId.value, String(status) as CellStatus);
}

// ---------- 版本勾选 ----------
function isActive(versionId: string): boolean {
  return activeVersionIds.value.includes(versionId);
}

// ---------- 导出 ----------
function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleExport(kind: 'md-all' | 'md-diff' | 'json') {
  if (kind === 'json') {
    download(`${draft.value.name}-校勘数据.json`, exportJson(), 'application/json;charset=utf-8');
  } else {
    download(`${draft.value.name}-校勘记.md`, exportMarkdown(kind === 'md-diff'), 'text/markdown;charset=utf-8');
  }
}

const draftFileInput = ref<HTMLInputElement | null>(null);
function handleDraftFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    if (importDraftJson(text)) {
      draftVisible.value = false;
      Message.success('旧草稿已打开');
    } else {
      Message.error('文件不是有效的校勘草稿 JSON');
    }
    target.value = '';
  });
}

function handleRename() {
  renameDraft(draftNameDraft.value);
  Message.success('草稿已重命名');
}

// ---------- 键盘 ----------
function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing =
    target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (typing || processing.value) return;
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    nextDifference();
  } else if (event.key.toLowerCase() === 'a' && selectedGroupIds.value.length) {
    acceptRows(selectedGroupIds.value);
  }
}
window.addEventListener('keydown', handleKeydown);
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown));

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (unresolvedCount.value > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
</script>

<template>
  <a-layout class="workbench-shell">
    <a-layout-header class="topbar">
      <div class="topbar-inner">
        <div class="brand-mark">校</div>
        <div>
          <h1 class="brand-title">校异斋 · 多版本校勘台</h1>
          <div class="brand-subtitle">一次载入 3–5 版 · 段句自动同组 · 校记随原句 · 分片不卡死</div>
        </div>
        <a-space style="margin-left: auto" wrap>
          <a-tag color="arcoblue" size="large">{{ draft.name }}</a-tag>
          <a-button :disabled="!canUndo" @click="undo">撤销</a-button>
          <a-button :disabled="!canRedo" @click="redo">重做</a-button>
          <a-button :loading="processing" type="primary" @click="runAlignment()">重新自动对齐</a-button>
          <a-button @click="openImport">导入版本</a-button>
          <a-button @click="openDrafts">草稿</a-button>
          <a-dropdown>
            <a-button status="success" type="outline">导出</a-button>
            <template #content>
              <a-doption @click="handleExport('md-all')">Markdown 全文对照</a-doption>
              <a-doption @click="handleExport('md-diff')">Markdown 仅异文校记</a-doption>
              <a-doption @click="handleExport('json')">JSON 完整数据</a-doption>
            </template>
          </a-dropdown>
        </a-space>
      </div>
    </a-layout-header>

    <a-layout class="main-layout">
      <!-- 左栏：版本与规则 -->
      <a-layout-sider class="left-panel" :width="286">
        <section class="panel-section">
          <div class="section-head">
            <h2 class="panel-title">工作台版本（{{ versions.length }}/{{ MAX_VERSIONS }}）</h2>
            <a-button size="mini" type="text" @click="openImport">＋ 导入</a-button>
          </div>
          <div class="version-list">
            <div v-for="version in versions" :key="version.id" class="version-item">
              <a-checkbox
                :model-value="isActive(version.id)"
                :disabled="version.id === baseVersionId"
                @change="() => toggleActiveVersion(version.id)"
              >
                <span :class="{ 'version-base-name': version.id === baseVersionId }">{{ version.name }}</span>
              </a-checkbox>
              <div class="version-meta">
                <a-radio
                  :model-value="baseVersionId"
                  :value="version.id"
                  @change="() => setBaseAndRun(version.id)"
                >底本</a-radio>
                <a-button size="mini" type="text" @click="openEditVersion(version.id)">替换正文</a-button>
                <a-popconfirm content="删除该版本？相关校记仍会保留在草稿中" @ok="removeVersion(version.id)">
                  <a-button size="mini" type="text" status="danger">删除</a-button>
                </a-popconfirm>
              </div>
            </div>
          </div>
          <a-alert v-if="versions.length < 2" type="warning" :show-icon="true" style="margin-top: 8px">
            至少导入底本和一个参校本（共 2 版）才能对齐，建议 3–5 版同校。
          </a-alert>
          <div class="version-source-tip">
            已选 {{ activeVersions.length }} 版同校；底本固定第一列，其余按参校列排开，挪动配对只在同版列内进行。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">比较规则</h2>
          <a-space direction="vertical" fill size="small">
            <a-checkbox
              :model-value="rules.ignorePunctuation"
              @change="(v: boolean | (string | number | boolean)[]) => { rules.ignorePunctuation = Boolean(v); recalculate(); }"
            >
              忽略标点差异
            </a-checkbox>
            <a-checkbox
              :model-value="rules.ignoreVariants"
              @change="(v: boolean | (string | number | boolean)[]) => { rules.ignoreVariants = Boolean(v); recalculate(); }"
            >
              忽略常见异体字 / 繁简字
            </a-checkbox>
            <div class="threshold-row">
              <span>疑错位阈值</span>
              <a-slider
                :model-value="Math.round(rules.misalignThreshold * 100)"
                :min="10"
                :max="80"
                :step="5"
                style="flex: 1"
                @change="(v: unknown) => { rules.misalignThreshold = Number(v) / 100; recalculate(); }"
              />
              <span class="threshold-value">{{ Math.round(rules.misalignThreshold * 100) }}%</span>
            </div>
          </a-space>
          <div class="hint-text">规则只重算相同/改动/疑错位，不重建对齐、不改原文、不丢校记。</div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">处理进度</h2>
          <a-progress v-if="processing" :percent="progress" size="small" />
          <div v-if="processing" class="hint-text">{{ progressPhase }} · 分片让出主线程中</div>
          <div class="stats-grid">
            <div class="stat-card"><div class="stat-number">{{ differenceGroups.length }}</div><div class="stat-label">差异组</div></div>
            <div class="stat-card"><div class="stat-number stat-warn">{{ unresolvedCount }}</div><div class="stat-label">待校勘</div></div>
            <div class="stat-card"><div class="stat-number stat-ok">{{ acceptedCount }}</div><div class="stat-label">已接受</div></div>
            <div class="stat-card"><div class="stat-number">{{ groups.length }}</div><div class="stat-label">对齐组</div></div>
          </div>
          <a-button long type="primary" status="success" :disabled="!unresolvedCount" style="margin-top: 10px" @click="acceptAll">
            一键接受全部建议
          </a-button>
          <a-button long style="margin-top: 8px" @click="nextDifference">跳到下一处未接受差异（Alt ↓）</a-button>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">键盘辅助</h2>
          <div class="keyhelp">
            <div><a-tag size="small">Alt ↓</a-tag> 下一处差异</div>
            <div><a-tag size="small">A</a-tag> 接受勾选组</div>
            <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
            <div><a-tag size="small">Ctrl/⌘ Y</a-tag> 重做</div>
          </div>
        </section>
      </a-layout-sider>

      <!-- 中栏：对齐组 -->
      <a-layout-content class="center-panel">
        <a-card :bordered="false" class="toolbar-card">
          <div class="toolbar">
            <a-input-search v-model="rowQuery" placeholder="搜索原句、校记或来源" allow-clear style="max-width: 300px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-checkbox v-model="hideAccepted">隐藏已接受</a-checkbox>
            <a-tag color="arcoblue">{{ filteredGroups.length }} / {{ groups.length }} 组</a-tag>
            <a-tag v-if="selectedGroupIds.length" color="green">{{ selectedGroupIds.length }} 组已勾选</a-tag>
            <a-button
              v-if="selectedGroupIds.length"
              type="primary"
              status="success"
              size="small"
              style="margin-left: auto"
              @click="acceptRows(selectedGroupIds)"
            >
              接受勾选组
            </a-button>
          </div>
        </a-card>

        <div class="grid-header-row">
          <div class="grid-header-gutter">组</div>
          <div
            v-for="version in activeVersions"
            :key="version.id"
            class="grid-header-cell"
            :class="{ 'header-base': version.id === baseVersionId }"
          >
            <div class="header-name">{{ version.name }}</div>
            <div class="header-source">{{ version.source || '未注来源' }}</div>
          </div>
        </div>

        <a-alert v-if="processing" type="info" :show-icon="true" style="border-radius: 0">
          {{ progressPhase }}（{{ progress }}%）· 长文本分片处理，界面保持可用
        </a-alert>

        <AlignmentGrid
          v-if="filteredGroups.length"
          ref="gridRef"
          :groups="filteredGroups"
          :versions="activeVersions"
          :base-version-id="baseVersionId"
          :selected-group-id="selectedGroupId"
          :selected-group-ids="selectedGroupIds"
          :rules="rules"
          :has-note="(versionId: string, text: string | undefined) => Boolean(getAnnotation(versionId, text)?.note)"
          @select="onSelectGroup"
          @toggle-check="onToggleCheck"
          @shift-cell="shiftCell"
          @move-group="moveGroup"
          @accept="(id) => acceptRows([id])"
          @set-status="setCellStatus"
          @annotate="openAnnotate"
        />
        <a-empty v-else class="empty-grid" description="暂无对齐组：请确认已选至少两个版本后点「重新自动对齐」" />
      </a-layout-content>

      <!-- 右栏：组详情与校记 -->
      <a-layout-sider class="right-panel" :width="348">
        <template v-if="selectedGroup">
          <section class="panel-section">
            <div class="section-head">
              <h2 class="panel-title" style="margin: 0">对齐组 #{{ selectedGroup.order }} · 段 {{ selectedGroup.paragraphOrder }}</h2>
              <a-tag :color="selectedGroup.accepted ? 'green' : 'orange'">{{ selectedGroup.accepted ? '已接受' : '待处理' }}</a-tag>
            </div>
            <div class="group-actions">
              <a-button size="small" @click="moveGroup(selectedGroup.id, -1)">整组上移</a-button>
              <a-button size="small" @click="moveGroup(selectedGroup.id, 1)">整组下移</a-button>
              <a-button
                size="small"
                :status="selectedGroup.accepted ? 'normal' : 'success'"
                :type="selectedGroup.accepted ? 'outline' : 'primary'"
                @click="acceptRows([selectedGroup.id])"
              >{{ selectedGroup.accepted ? '撤回接受' : '接受本组' }}</a-button>
            </div>
          </section>

          <section class="panel-section">
            <h2 class="panel-title">组内各版原句</h2>
            <div class="inspector-versions">
              <button
                v-for="version in activeVersions"
                :key="version.id"
                type="button"
                class="inspector-version"
                :class="{ active: noteVersionId === version.id }"
                @click="pickNoteCell(version.id)"
              >
                <span class="inspector-version-name">{{ version.name }}</span>
                <a-tag size="small" color="gray">{{ selectedGroup.cells[version.id] ? statusLabel(selectedGroup.cells[version.id].status) : '无' }}</a-tag>
              </button>
            </div>
            <div class="inspector-text">{{ selectedGroup.cells[noteVersionId]?.unit?.text || '（该版本在此组无原句：删减或未配对）' }}</div>
            <div class="inspector-controls">
              <a-select
                :model-value="selectedCellStatus()"
                size="small"
                style="width: 132px"
                @change="changeStatus"
              >
                <a-option v-for="opt in noteStatusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</a-option>
              </a-select>
              <a-button size="small" @click="shiftCell(selectedGroup.id, noteVersionId, -1)" :disabled="noteVersionId === baseVersionId">配对上移</a-button>
              <a-button size="small" @click="shiftCell(selectedGroup.id, noteVersionId, 1)" :disabled="noteVersionId === baseVersionId">配对下移</a-button>
            </div>
          </section>

          <section class="panel-section">
            <h2 class="panel-title">校勘说明（随此版此句）</h2>
            <a-textarea
              v-model="noteDraft"
              placeholder="记录字形、词句、标点或语义差异的判断依据"
              :auto-size="{ minRows: 4, maxRows: 10 }"
            />
            <a-input v-model="sourceDraft" placeholder="来源：刻本、馆藏、整理者等" style="margin-top: 8px" />
            <a-button long type="primary" style="margin-top: 8px" @click="saveCurrentNote">保存校记与来源</a-button>
            <div class="hint-text">校记按「版本 + 原句」锚定，换版本、改规则、重新对齐后仍跟原句走。</div>
          </section>
        </template>

        <div v-else class="inspector-empty">
          <div class="inspector-empty-mark">擇</div>
          <p>点选中间任一对齐组<br />即可逐版判异文、挪配对、写校记</p>
        </div>

        <section class="panel-section panel-footer">
          <div class="hint-text">最近状态：{{ message }}<br />数据自动保存在当前浏览器，旧草稿可从「草稿」按钮打开或导入。</div>
        </section>
      </a-layout-sider>
    </a-layout>
  </a-layout>

  <!-- 导入 / 替换版本 -->
  <a-modal
    v-model:visible="importVisible"
    :title="editVersionId ? '替换版本正文' : '导入同一作品的新版本'"
    width="720px"
    @ok="confirmImport"
  >
    <a-form :model="importForm" layout="vertical">
      <a-grid :cols="2" :col-gap="12">
        <a-grid-item>
          <a-form-item label="版本名称">
            <a-input v-model="importForm.name" placeholder="如：某刻本 / 某校点本" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="来源">
            <a-input v-model="importForm.source" placeholder="馆藏、整理者或文件来源" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="选择文本文件">
        <input ref="fileInput" type="file" accept=".txt,.md,text/plain,text/markdown" @change="handleFile" />
      </a-form-item>
      <a-form-item label="或直接粘贴正文">
        <a-textarea
          v-model="importForm.text"
          placeholder="空行分段（单个换行也会分段）；段内按 。！？；等句末标点自动分句"
          :auto-size="{ minRows: 8, maxRows: 16 }"
        />
      </a-form-item>
      <a-alert type="info" :show-icon="true">
        最多载入 {{ MAX_VERSIONS }} 个版本；替换正文会重新对齐，已写校记按原句内容保留。
      </a-alert>
    </a-form>
  </a-modal>

  <!-- 草稿管理 -->
  <a-modal v-model:visible="draftVisible" title="草稿管理：旧草稿可随时打开" width="760px" :footer="false">
    <div class="draft-toolbar">
      <a-button type="primary" @click="createBlankDraft('')">新建空白草稿</a-button>
      <a-button @click="createDraft('')">新建示例草稿</a-button>
      <a-button @click="draftFileInput?.click()">导入旧草稿 JSON</a-button>
      <input ref="draftFileInput" type="file" accept=".json,application/json" hidden @change="handleDraftFile" />
    </div>
    <a-table
      class="draft-table"
      :data="draftList"
      :pagination="false"
      :bordered="false"
      row-key="id"
      size="small"
    >
      <template #columns>
        <a-table-column title="草稿名称" data-index="name" />
        <a-table-column title="版本数">
          <template #cell="{ record }">{{ record.versions.length }}</template>
        </a-table-column>
        <a-table-column title="最近保存">
          <template #cell="{ record }">{{ formatTime(record.updatedAt) }}</template>
        </a-table-column>
        <a-table-column title="操作" :width="220">
          <template #cell="{ record }">
            <a-space size="mini">
              <a-button size="mini" type="primary" :disabled="record.id === draft.id" @click="switchDraft(record.id)">
                打开
              </a-button>
              <a-button
                size="mini"
                @click="download(`${record.name}-备份.json`, JSON.stringify(record, null, 2), 'application/json;charset=utf-8')"
              >备份</a-button>
              <a-popconfirm content="删除该草稿？删除前建议先备份 JSON" @ok="deleteDraft(record.id)">
                <a-button size="mini" status="danger">删除</a-button>
              </a-popconfirm>
            </a-space>
          </template>
        </a-table-column>
      </template>
    </a-table>

    <a-divider />
    <div class="draft-rename">
      <span>当前草稿：</span>
      <a-input v-model="draftNameDraft" style="max-width: 320px" />
      <a-button @click="handleRename">重命名</a-button>
    </div>
  </a-modal>
</template>
