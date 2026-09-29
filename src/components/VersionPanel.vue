<script setup lang="ts">
import { computed, ref } from 'vue';
import { Message } from '@arco-design/web-vue';
import { useCollation } from '../composables/useCollation';
import type { VersionDocument } from '../types';

const emit = defineEmits<{
  (e: 'import'): void;
  (e: 'replace', version: VersionDocument): void;
  (e: 'editText', version: VersionDocument): void;
  (e: 'drafts'): void;
}>();

const {
  currentProject,
  baseVersion,
  witnessVersions,
  activeVersions,
  rules,
  chunks,
  stats,
  unresolvedCount,
  MAX_VERSIONS,
  setBaseVersion,
  toggleWitness,
  updateRules,
  setActiveChunk,
  deleteVersion,
  renameProject,
  realign
} = useCollation();

const editingName = ref(false);
const nameDraft = ref('');

function startRename() {
  nameDraft.value = currentProject.value?.name ?? '';
  editingName.value = true;
}
function confirmRename() {
  renameProject(nameDraft.value);
  editingName.value = false;
}

function onPickBase(id: string) {
  setBaseVersion(id);
}

function onToggleWitness(id: string, checked: unknown) {
  toggleWitness(id, Boolean(checked));
}

function onDelete(id: string) {
  const v = currentProject.value?.versions.find((item) => item.id === id);
  if (!v) return;
  if (currentProject.value && currentProject.value.versions.length <= 2) {
    Message.warning('至少保留两个版本才能对照');
    return;
  }
  deleteVersion(id);
}

const loadedCount = computed(() => activeVersions.value.length);
const chunkIndex = computed({
  get: () => currentProject.value?.activeChunk ?? 0,
  set: (v: number) => setActiveChunk(v)
});

const thresholdModel = computed({
  get: () => Math.round((rules.value?.matchThreshold ?? 0.45) * 100),
  set: () => undefined
});
const chunkSizeModel = computed(() => rules.value?.chunkSize ?? 60);
</script>

<template>
  <div class="side-panel">
    <section class="panel-section">
      <div class="project-name-row">
        <template v-if="!editingName">
          <h2 class="project-name" :title="currentProject?.name">{{ currentProject?.name }}</h2>
          <a-button size="mini" type="text" @click="startRename">改名</a-button>
        </template>
        <template v-else>
          <a-input v-model="nameDraft" size="small" @press-enter="confirmRename" />
          <a-button size="mini" type="primary" @click="confirmRename">确定</a-button>
        </template>
      </div>
      <a-space size="small">
        <a-button size="mini" long @click="emit('drafts')">草稿 / 备份</a-button>
        <a-button size="mini" long type="outline" @click="realign()">重新对齐</a-button>
      </a-space>
    </section>

    <section class="panel-section">
      <div class="section-head">
        <h3 class="panel-title">载入版本（{{ loadedCount }}/{{ MAX_VERSIONS }}）</h3>
        <a-button size="mini" type="text" :disabled="loadedCount >= MAX_VERSIONS" @click="emit('import')">＋导入</a-button>
      </div>
      <a-alert v-if="loadedCount < 3" type="warning" :show-icon="true" style="margin-bottom: 8px">
        建议一次载入 3–5 个版本，当前只有 {{ loadedCount }} 个
      </a-alert>
      <a-radio-group
        :model-value="baseVersion?.id"
        direction="vertical"
        class="version-radio-group"
        @change="(val) => onPickBase(String(val))"
      >
        <ul class="version-list">
        <li
          v-for="v in currentProject?.versions ?? []"
          :key="v.id"
          class="version-item"
          :class="{ 'is-base': v.id === baseVersion?.id, 'is-active': v.id === baseVersion?.id || witnessVersions.some((w) => w.id === v.id) }"
        >
          <a-radio :value="v.id">
            <span class="version-name">{{ v.name }}</span>
          </a-radio>
          <div class="version-meta">{{ v.source || '未注来源' }} · {{ v.sentences.length }} 句</div>
          <div class="version-actions">
            <a-checkbox
              :model-value="witnessVersions.some((w) => w.id === v.id)"
              :disabled="v.id === baseVersion?.id"
              @change="(val) => onToggleWitness(v.id, val)"
            >
              参校
            </a-checkbox>
            <a-button size="mini" type="text" @click="emit('replace', v)">替换</a-button>
            <a-button size="mini" type="text" @click="emit('editText', v)">改文</a-button>
            <a-popconfirm content="删除该版本？该版校记会转入失主池，不会丢失" @ok="onDelete(v.id)">
              <a-button size="mini" type="text" status="danger">删</a-button>
            </a-popconfirm>
          </div>
        </li>
        </ul>
      </a-radio-group>
      <div class="hint">底本为对齐基准；勾选「参校」即加入同屏对照。换底本或增减版本会自动重对齐，已写校记按句保留。</div>
    </section>

    <section class="panel-section">
      <h3 class="panel-title">比较规则（改动即重对齐）</h3>
      <a-space direction="vertical" fill :size="10">
        <a-checkbox :model-value="rules.ignorePunctuation" @change="(v) => updateRules({ ignorePunctuation: Boolean(v) })">
          忽略标点差异
        </a-checkbox>
        <a-checkbox :model-value="rules.ignoreVariants" @change="(v) => updateRules({ ignoreVariants: Boolean(v) })">
          忽略常见异体字 / 繁简
        </a-checkbox>
        <a-checkbox :model-value="rules.crossParagraph" @change="(v) => updateRules({ crossParagraph: Boolean(v) })">
          允许跨段落配对
        </a-checkbox>
        <div>
          <div class="rule-label">句匹配阈值 {{ thresholdModel }}%</div>
          <a-slider
            :model-value="thresholdModel"
            :min="20"
            :max="85"
            :step="5"
            @change="(v) => updateRules({ matchThreshold: Number(v) / 100 })"
          />
        </div>
        <div>
          <div class="rule-label">长文本分片：每片 {{ chunkSizeModel }} 句</div>
          <a-slider
            :model-value="chunkSizeModel"
            :min="20"
            :max="200"
            :step="20"
            @change="(v) => updateRules({ chunkSize: Number(v) })"
          />
        </div>
      </a-space>
      <div class="hint">规则只影响自动判定与配对，原始正文与人工校记始终不改写。</div>
    </section>

    <section class="panel-section">
      <h3 class="panel-title">长文本分片</h3>
      <a-select v-model="chunkIndex" size="small">
        <a-option v-for="c in chunks" :key="c.index" :value="c.index">{{ c.label }}</a-option>
      </a-select>
      <div class="hint">按底本句序分片，逐片让出主线程；锁定的人工配对随片固定。</div>
    </section>

    <section class="panel-section">
      <h3 class="panel-title">处理进度</h3>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-number">{{ stats.differences }}</div><div class="stat-label">差异单元格</div></div>
        <div class="stat-card"><div class="stat-number warn">{{ unresolvedCount }}</div><div class="stat-label">待校勘</div></div>
        <div class="stat-card"><div class="stat-number ok">{{ stats.accepted }}</div><div class="stat-label">已接受</div></div>
        <div class="stat-card"><div class="stat-number">{{ stats.groups }}</div><div class="stat-label">对齐组</div></div>
      </div>
      <a-tag v-if="stats.orphans" color="orangered" style="margin-top: 8px">{{ stats.orphans }} 条失主校记待指认</a-tag>
    </section>
  </div>
</template>

<style scoped>
.side-panel {
  padding-bottom: 24px;
}
.project-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.project-name {
  margin: 0;
  flex: 1;
  font-family: "Songti SC", "Noto Serif SC", serif;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.version-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.version-radio-group {
  width: 100%;
}
.version-radio-group :deep(.arco-radio) {
  align-items: flex-start;
  margin-right: 0;
}
.version-item {
  padding: 8px 10px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  background: #fff;
}
.version-item.is-base {
  border-color: #165dff;
  background: #f2f7ff;
}
.version-item:not(.is-active) {
  opacity: 0.62;
}
.version-name {
  font-size: 13px;
  font-weight: 600;
}
.version-meta {
  margin: 3px 0 3px 24px;
  color: #86909c;
  font-size: 11px;
}
.version-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 24px;
  flex-wrap: wrap;
}
.rule-label {
  color: #4e5969;
  font-size: 12px;
  margin-bottom: 2px;
}
.hint {
  margin-top: 8px;
  color: #86909c;
  font-size: 11px;
  line-height: 1.7;
}
.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.stat-card {
  padding: 10px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  background: #fff;
}
.stat-number {
  font-size: 20px;
  font-weight: 650;
}
.stat-number.warn {
  color: #d25f00;
}
.stat-number.ok {
  color: #00875a;
}
.stat-label {
  color: #86909c;
  font-size: 11px;
}
</style>
