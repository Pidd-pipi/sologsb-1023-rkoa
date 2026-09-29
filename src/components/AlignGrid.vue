<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseCell from './BaseCell.vue';
import WitnessCell from './WitnessCell.vue';
import { useCollation } from '../composables/useCollation';
import type { AlignGroup } from '../types';

const {
  currentProject,
  baseVersion,
  witnessVersions,
  visibleGroups,
  chunks,
  getCellStatus,
  setActiveChunk,
  acceptVisible,
  nextDifference,
  realign,
  selectedGroupId,
  processing,
  progress,
  progressPhase,
  unresolvedCount
} = useCollation();

const onlyDifferences = ref(false);
const showCharDiff = ref(true);
const query = ref('');

const groups = computed(() => {
  let list: AlignGroup[] = visibleGroups.value;
  if (onlyDifferences.value) {
    list = list.filter((g) =>
      (currentProject.value?.witnessIds ?? []).some((wid) => getCellStatus(g, wid).status !== 'same')
    );
  }
  const q = query.value.trim().toLocaleLowerCase();
  if (q) {
    list = list.filter((g) => JSON.stringify(g.cells).length >= 0 && groupText(g).some((t) => t.toLocaleLowerCase().includes(q)));
  }
  return list;
});

function groupText(g: AlignGroup): string[] {
  const p = currentProject.value;
  if (!p) return [];
  const texts: string[] = [];
  if (g.baseSentenceId) {
    const s = baseVersion.value?.sentences.find((x) => x.id === g.baseSentenceId);
    if (s) texts.push(s.text);
  }
  for (const wid of p.witnessIds) {
    for (const sid of g.cells[wid] ?? []) {
      const s = p.versions.find((v) => v.id === wid)?.sentences.find((x) => x.id === sid);
      if (s) texts.push(s.text);
    }
  }
  return texts;
}

const gridStyle = computed(() => ({
  gridTemplateColumns: `56px minmax(260px, 1.15fr) repeat(${witnessVersions.value.length}, minmax(240px, 1fr))`
}));

function fullIndex(group: AlignGroup): number {
  return currentProject.value?.groups.findIndex((g) => g.id === group.id) ?? -1;
}

function prevParagraph(group: AlignGroup): number | null {
  const p = currentProject.value;
  if (!p) return null;
  const idx = fullIndex(group);
  for (let i = idx - 1; i >= 0; i -= 1) {
    const g = p.groups[i];
    if (g.baseSentenceId) return baseVersion.value?.sentences.find((s) => s.id === g.baseSentenceId)?.paragraphOrder ?? null;
  }
  return null;
}
function paragraphOf(group: AlignGroup): number | null {
  if (!group.baseSentenceId) return null;
  return baseVersion.value?.sentences.find((s) => s.id === group.baseSentenceId)?.paragraphOrder ?? null;
}
function showParagraphBreak(group: AlignGroup): boolean {
  const cur = paragraphOf(group);
  const prev = prevParagraph(group);
  return cur !== null && prev !== null && cur !== prev;
}

function selectGroup(group: AlignGroup) {
  selectedGroupId.value = group.id;
}
function isActive(group: AlignGroup) {
  return selectedGroupId.value === group.id;
}

function groupHasDiff(g: AlignGroup) {
  return (currentProject.value?.witnessIds ?? []).some((wid) => getCellStatus(g, wid).status !== 'same');
}
</script>

<template>
  <div class="align-grid-wrap">
    <!-- 工具条 -->
    <div class="grid-toolbar">
      <a-input-search v-model="query" placeholder="搜正文（限当前片）" allow-clear size="small" style="width: 220px" />
      <a-checkbox v-model="onlyDifferences">只看差异组</a-checkbox>
      <a-checkbox v-model="showCharDiff">字符级增删高亮</a-checkbox>
      <a-button size="small" status="success" type="outline" @click="acceptVisible">接受本片全部差异</a-button>
      <a-button size="small" type="primary" @click="nextDifference">下一处差异 <a-tag size="small" color="red" style="margin-left:4px">{{ unresolvedCount }}</a-tag></a-button>
      <div class="toolbar-right">
        <a-button size="small" :disabled="(currentProject?.activeChunk ?? 0) <= 0" @click="setActiveChunk((currentProject?.activeChunk ?? 0) - 1)">上一片</a-button>
        <a-tag>{{ (currentProject?.activeChunk ?? 0) + 1 }} / {{ chunks.length }}</a-tag>
        <a-button size="small" :disabled="(currentProject?.activeChunk ?? 0) >= chunks.length - 1" @click="setActiveChunk((currentProject?.activeChunk ?? 0) + 1)">下一片</a-button>
        <a-button size="small" type="outline" :loading="processing" @click="realign()">重对齐</a-button>
      </div>
    </div>

    <a-progress v-if="processing" :percent="progress" size="small" />
    <div v-if="processing" class="processing-hint">{{ progressPhase }} · 分片让出主线程，界面可继续操作</div>

    <div class="grid-scroll">
      <div class="align-grid" :style="gridStyle">
        <!-- 表头 -->
        <div class="grid-head idx-head">#</div>
        <div class="grid-head base-head">底本 · {{ baseVersion?.name }}</div>
        <div v-for="w in witnessVersions" :key="w.id" class="grid-head witness-head">
          {{ w.name }}
          <div class="head-source">{{ w.source }}</div>
        </div>

        <template v-for="group in groups" :key="group.id">
          <div v-if="showParagraphBreak(group)" class="paragraph-break" :style="{ gridColumn: `1 / span ${witnessVersions.length + 2}` }">
            第 {{ paragraphOf(group) }} 段
          </div>
          <div
            class="grid-row idx-cell"
            :class="{ active: isActive(group), locked: group.locked, plain: !groupHasDiff(group) }"
            @click="selectGroup(group)"
          >
            <span>{{ fullIndex(group) + 1 }}</span>
            <span v-if="group.locked" class="lock-ico" title="已锁定">🔒</span>
          </div>
          <div class="grid-row base-row" :class="{ active: isActive(group) }" @click="selectGroup(group)">
            <BaseCell :group="group" />
          </div>
          <div
            v-for="w in witnessVersions"
            :key="w.id"
            class="grid-row witness-row"
            :class="{ active: isActive(group) }"
            @click="selectGroup(group)"
          >
            <WitnessCell :group="group" :version-id="w.id" :show-char-diff="showCharDiff" />
          </div>
        </template>
      </div>

      <a-empty v-if="!groups.length" description="当前片没有符合条件的对齐组" style="padding: 60px 0" />
    </div>
  </div>
</template>

<style scoped>
.align-grid-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;
  border-radius: 10px;
  border: 1px solid #e5e6eb;
  overflow: hidden;
}
.grid-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid #e5e6eb;
  background: #fafbfc;
  flex-wrap: wrap;
}
.toolbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.processing-hint {
  padding: 4px 14px;
  color: #86909c;
  font-size: 11px;
  background: #fff7e8;
}
.grid-scroll {
  flex: 1;
  overflow: auto;
}
.align-grid {
  display: grid;
  min-width: 100%;
}
.grid-head {
  position: sticky;
  top: 0;
  z-index: 5;
  padding: 10px 12px;
  background: #f2f3f5;
  border-bottom: 1px solid #e5e6eb;
  font-size: 13px;
  font-weight: 650;
  color: #1d2129;
}
.idx-head {
  text-align: center;
}
.base-head {
  border-right: 2px solid #c9cdd4;
}
.head-source {
  font-weight: 400;
  color: #86909c;
  font-size: 11px;
  margin-top: 2px;
}
.paragraph-break {
  background: #f7f8fa;
  color: #4e5969;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 14px;
  border-top: 1px solid #e5e6eb;
  border-bottom: 1px solid #e5e6eb;
  letter-spacing: 0.1em;
}
.grid-row {
  padding: 8px 10px;
  border-bottom: 1px solid #f2f3f5;
  border-right: 1px solid #f2f3f5;
  min-width: 0;
}
.grid-row.active {
  background: #e8f3ff;
}
.idx-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: #86909c;
  font-size: 12px;
  text-align: center;
}
.idx-cell.plain span:first-child {
  color: #c9cdd4;
}
.idx-cell.locked {
  background: #fffbe8;
}
.lock-ico {
  font-size: 11px;
}
.base-row {
  background: #fcfcfd;
  border-right: 2px solid #e5e6eb;
}
.base-row.active {
  background: #e8f3ff;
}
</style>
