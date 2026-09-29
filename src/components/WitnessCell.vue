<script setup lang="ts">
import { computed } from 'vue';
import { useCollation } from '../composables/useCollation';
import type { AlignGroup, DifferenceStatus } from '../types';

const props = defineProps<{
  group: AlignGroup;
  versionId: string;
  showCharDiff: boolean;
}>();

const {
  currentProject,
  getCellStatus,
  getCellAccepted,
  getCellDiff,
  acceptCell,
  unacceptCell,
  overrideStatus,
  clearOverride,
  moveSentence,
  detachSentence,
  annotationFor,
  sentenceById,
  selectedCell,
  groupIndex
} = useCollation();

const statusInfo = computed(() => getCellStatus(props.group, props.versionId));
const accepted = computed(() => getCellAccepted(props.group, props.versionId));
const sentenceIds = computed(() => props.group.cells[props.versionId] ?? []);

const tokens = computed(() => (props.showCharDiff ? getCellDiff(props.group, props.versionId) : []));

const statusOptions: { value: DifferenceStatus; label: string }[] = [
  { value: 'same', label: '相同' },
  { value: 'changed', label: '改动' },
  { value: 'added', label: '新增' },
  { value: 'removed', label: '删减' },
  { value: 'misaligned', label: '疑错位' }
];

const statusColor: Record<DifferenceStatus, string> = {
  same: 'gray',
  changed: 'orange',
  added: 'green',
  removed: 'red',
  misaligned: 'arcoblue'
};
const statusText: Record<DifferenceStatus, string> = {
  same: '相同',
  changed: '改动',
  added: '新增',
  removed: '删减',
  misaligned: '疑错位'
};

function select(sentenceId: string) {
  selectedCell.value = { groupId: props.group.id, versionId: props.versionId, sentenceId };
}
function isSelected(sentenceId: string) {
  return selectedCell.value?.groupId === props.group.id &&
    selectedCell.value?.versionId === props.versionId &&
    selectedCell.value?.sentenceId === sentenceId;
}

function hasNote(sid: string) {
  return Boolean(annotationFor(props.versionId, sid)?.note);
}

function canMove(direction: -1 | 1) {
  const idx = groupIndex(props.group.id);
  return idx + direction >= 0 && idx + direction < (currentProject.value?.groups.length ?? 0);
}

function onPickStatus(value: unknown) {
  overrideStatus(props.group.id, props.versionId, String(value) as DifferenceStatus);
}
</script>

<template>
  <div class="wcell" :class="['st-' + statusInfo.status, { accepted: accepted, multi: sentenceIds.length > 1 }]">
    <!-- 有配对句 -->
    <template v-if="sentenceIds.length">
      <div
        v-for="sid in sentenceIds"
        :key="sid"
        class="sentence-block"
        :class="{ selected: isSelected(sid) }"
        @click="select(sid)"
      >
        <div class="sentence-meta">
          <span>{{ sentenceById(versionId, sid)?.paragraphOrder }}段{{ sentenceById(versionId, sid)?.sentenceInParagraph }}句</span>
          <a-tooltip v-if="hasNote(sid)" content="该句已写校记（随句保留）">
            <a-tag size="small" color="arcoblue">记</a-tag>
          </a-tooltip>
        </div>
        <!-- 字符级 diff：改动/疑错位时高亮，相同/新增时直接显示 -->
        <div v-if="showCharDiff && (statusInfo.status === 'changed' || statusInfo.status === 'misaligned')" class="diff-render">
          <template v-for="(tok, i) in tokens" :key="i">
            <span v-if="tok.op === 'equal'">{{ tok.text }}</span>
            <ins v-else-if="tok.op === 'insert'" class="ch-insert">{{ tok.text }}</ins>
            <del v-else class="ch-delete">{{ tok.text }}</del>
          </template>
        </div>
        <div v-else class="plain-text">
          <span v-for="s2 in [sentenceById(versionId, sid)]" :key="sid">{{ s2?.text }}</span>
        </div>
        <div class="sentence-tools">
          <a-tooltip content="在本版列内上移到上一组（不跨版本）">
            <a-button size="mini" :disabled="!canMove(-1)" @click.stop="moveSentence(group.id, versionId, sid, -1)">↑</a-button>
          </a-tooltip>
          <a-tooltip content="在本版列内下移到下一组（不跨版本）">
            <a-button size="mini" :disabled="!canMove(1)" @click.stop="moveSentence(group.id, versionId, sid, 1)">↓</a-button>
          </a-tooltip>
          <a-tooltip content="把该句从本组拆出">
            <a-button size="mini" @click.stop="detachSentence(group.id, versionId, sid)">拆</a-button>
          </a-tooltip>
        </div>
      </div>
    </template>

    <!-- 底本有、本版无：删减 -->
    <div v-else-if="group.baseSentenceId" class="missing" @click="selectedCell = { groupId: group.id, versionId, sentenceId: '' }">
      本版无此句（删减）
    </div>
    <!-- 插入组里本版也没有：留空 -->
    <div v-else class="empty-cell">—</div>

    <!-- 单元格裁定条 -->
    <div v-if="sentenceIds.length || group.baseSentenceId" class="verdict-bar" @click.stop>
      <a-tooltip content="点右侧「类别」可人工改判，重对齐也不丢">
        <a-tag :color="statusColor[statusInfo.status]" class="clickable">
          {{ statusText[statusInfo.status] }}{{ statusInfo.manual ? '·人' : '' }}
        </a-tag>
      </a-tooltip>
      <a-tooltip :content="accepted ? '撤回接受' : '接受此判断'">
        <a-button
          size="mini"
          :type="accepted ? 'outline' : 'primary'"
          :status="accepted ? 'normal' : 'success'"
          @click="accepted ? unacceptCell(group.id, versionId) : acceptCell(group.id, versionId)"
        >
          {{ accepted ? '已接受' : '接受' }}
        </a-button>
      </a-tooltip>
      <a-button v-if="statusInfo.manual" size="mini" type="text" @click="clearOverride(group.id, versionId)">复自动</a-button>
      <span class="sim">似 {{ Math.round(statusInfo.similarity * 100) }}%</span>
      <a-dropdown trigger="click" position="top" @select="onPickStatus">
        <a-button size="mini" type="text">类别▾</a-button>
        <template #content>
          <a-doption v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</a-doption>
        </template>
      </a-dropdown>
    </div>
  </div>
</template>

<style scoped>
.wcell {
  position: relative;
  min-height: 64px;
  border-radius: 6px;
  padding: 4px 6px;
}
.wcell.st-same { background: #fafbfc; }
.wcell.st-changed { background: #fff7e8; }
.wcell.st-added { background: #e8ffea; }
.wcell.st-removed { background: #ffece8; }
.wcell.st-misaligned { background: #e8f3ff; }
.wcell.accepted { outline: 2px solid rgba(0, 135, 90, 0.25); }
.sentence-block {
  position: relative;
  padding: 4px 6px 4px 6px;
  border-radius: 5px;
  cursor: text;
}
.sentence-block + .sentence-block {
  margin-top: 6px;
  border-top: 1px dashed #c9cdd4;
  padding-top: 8px;
}
.sentence-block.selected {
  background: #fff;
  box-shadow: 0 0 0 2px #165dff;
}
.sentence-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #86909c;
  font-size: 10px;
  margin-bottom: 2px;
}
.diff-render,
.plain-text {
  font-family: "Songti SC", "Noto Serif SC", serif;
  font-size: 15px;
  line-height: 1.85;
  color: #1d2129;
}
:deep(.ch-insert) {
  background: #aff0b5;
  color: #0f7b45;
  text-decoration: none;
  padding: 0 1px;
  border-radius: 2px;
}
:deep(.ch-delete) {
  background: #ffd0c4;
  color: #a8071a;
  text-decoration: line-through;
  padding: 0 1px;
  border-radius: 2px;
}
.sentence-tools {
  position: absolute;
  top: 2px;
  right: 2px;
  display: none;
  gap: 2px;
}
.sentence-block:hover .sentence-tools,
.sentence-block.selected .sentence-tools {
  display: flex;
}
.sentence-tools :deep(button) {
  padding: 0 5px;
  min-width: 22px;
  height: 22px;
  font-size: 12px;
}
.missing {
  color: #a8071a;
  font-size: 12px;
  padding: 16px 4px;
  text-align: center;
  border: 1px dashed #f7b5ab;
  border-radius: 5px;
}
.empty-cell {
  color: #c9cdd4;
  text-align: center;
  padding: 16px 0;
}
.verdict-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dotted #e5e6eb;
  flex-wrap: wrap;
}
.clickable {
  cursor: pointer;
}
.sim {
  color: #a9aeb8;
  font-size: 10px;
  margin-left: auto;
}
</style>
