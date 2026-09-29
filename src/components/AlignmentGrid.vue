<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { AlignmentGroup, Cell, CellStatus, TextUnit, VersionDocument } from '../types';
import { statusLabelMap } from '../types';
import type { ComparisonRules } from '../types';
import { diffChars, type DiffToken } from '../lib/text';

const props = defineProps<{
  groups: AlignmentGroup[];
  versions: VersionDocument[];
  baseVersionId: string;
  selectedGroupId: string | null;
  selectedGroupIds: string[];
  rules: ComparisonRules;
  hasNote?: (versionId: string, text: string | undefined) => boolean;
}>();

const emit = defineEmits<{
  (e: 'select', id: string): void;
  (e: 'toggle-check', id: string, checked: boolean): void;
  (e: 'shift-cell', groupId: string, versionId: string, dir: -1 | 1): void;
  (e: 'move-group', groupId: string, dir: -1 | 1): void;
  (e: 'accept', id: string): void;
  (e: 'set-status', groupId: string, versionId: string, status: CellStatus): void;
  (e: 'annotate', groupId: string, versionId: string): void;
}>();

const scrollEl = ref<HTMLElement | null>(null);
const ROW_HEIGHT = 132;
const OVERSCAN = 6;
const scrollTop = ref(0);
const viewportHeight = ref(600);
const heights = ref<number[]>([]);

const offsets = computed(() => {
  const result: number[] = [];
  let acc = 0;
  props.groups.forEach((_, i) => {
    result.push(acc);
    acc += heights.value[i] ?? ROW_HEIGHT;
  });
  return result;
});

const totalHeight = computed(() => {
  let acc = 0;
  props.groups.forEach((_, i) => {
    acc += heights.value[i] ?? ROW_HEIGHT;
  });
  return acc;
});

const visibleRange = computed(() => {
  const top = scrollTop.value;
  const bottom = top + viewportHeight.value;
  let start = 0;
  while (start < offsets.value.length && (offsets.value[start] + (heights.value[start] ?? ROW_HEIGHT)) < top - OVERSCAN * 40) {
    start += 1;
  }
  let end = start;
  while (end < offsets.value.length && offsets.value[end] < bottom + OVERSCAN * 40) {
    end += 1;
  }
  return { start: Math.max(0, start - 2), end: Math.min(props.groups.length, end + 2) };
});

const visibleRows = computed(() =>
  props.groups.slice(visibleRange.value.start, visibleRange.value.end).map((group, i) => ({
    group,
    index: visibleRange.value.start + i,
    top: offsets.value[visibleRange.value.start + i]
  }))
);

function onScroll() {
  scrollTop.value = scrollEl.value?.scrollTop ?? 0;
}

let resizeObserver: ResizeObserver | null = null;
const rowRefs = new Map<string, HTMLElement>();

function setRowRef(el: Element | unknown, group: AlignmentGroup) {
  if (el instanceof HTMLElement) {
    rowRefs.set(group.id, el);
    resizeObserver?.observe(el);
  } else {
    const old = rowRefs.get(group.id);
    if (old) resizeObserver?.unobserve(old);
    rowRefs.delete(group.id);
  }
}

function measure() {
  const changed: Array<{ index: number; height: number }> = [];
  props.groups.forEach((group, index) => {
    const el = rowRefs.get(group.id);
    if (el) {
      const h = el.offsetHeight;
      if (h && h !== heights.value[index]) changed.push({ index, height: h });
    }
  });
  if (changed.length) {
    const next = [...heights.value];
    changed.forEach(({ index, height }) => {
      next[index] = height;
    });
    heights.value = next;
  }
}

onMounted(() => {
  viewportHeight.value = scrollEl.value?.clientHeight ?? 600;
  resizeObserver = new ResizeObserver(() => measure());
  const ro = new ResizeObserver(() => {
    viewportHeight.value = scrollEl.value?.clientHeight ?? 600;
  });
  if (scrollEl.value) ro.observe(scrollEl.value);
  window.addEventListener('resize', onScroll);
  nextTick(measure);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', onScroll);
});

watch(
  () => props.groups.length,
  () => {
    heights.value = new Array(props.groups.length).fill(ROW_HEIGHT);
    nextTick(measure);
  },
  { immediate: true }
);

watch(visibleRows, () => nextTick(measure));

function scrollToIndex(index: number) {
  nextTick(() => {
    const top = offsets.value[index] ?? 0;
    scrollEl.value?.scrollTo({ top: top - 8, behavior: 'smooth' });
  });
}

function scrollToGroupId(id: string) {
  const index = props.groups.findIndex((g) => g.id === id);
  if (index >= 0) scrollToIndex(index);
}

defineExpose({ scrollToGroupId });

// ---------- 单元格差异渲染 ----------
function charDiff(baseText: string | undefined, cell: Cell): DiffToken[] | null {
  if (!baseText || !cell.unit || cell.status === 'same' || cell.status === 'base') return null;
  if (cell.status === 'added' || cell.status === 'removed' || cell.status === 'misaligned') return null;
  return diffChars(baseText, cell.unit.text, props.rules);
}

function isChecked(group: AlignmentGroup): boolean {
  return props.selectedGroupIds.includes(group.id);
}

const statusColor: Record<CellStatus, string> = {
  base: 'arcoblue',
  same: 'gray',
  changed: 'orange',
  added: 'green',
  removed: 'red',
  misaligned: 'purple'
};

function diffSpanClass(tok: { type: 'equal' | 'insert' | 'delete' }): string {
  return tok.type === 'insert' ? 'tok-insert' : tok.type === 'delete' ? 'tok-delete' : '';
}

function unitLabel(unit: TextUnit | undefined): string {
  if (!unit) return '';
  return `段${unit.paragraphOrder}·句${unit.sentenceOrder}`;
}
</script>

<template>
  <div ref="scrollEl" class="align-scroll" @scroll.passive="onScroll">
    <div class="align-spacer" :style="{ height: `${totalHeight}px` }">
      <div
        v-for="row in visibleRows"
        :key="row.group.id"
        :ref="(el) => setRowRef(el, row.group)"
        class="align-row"
        :class="{ 'row-active': row.group.id === selectedGroupId }"
        :style="{ transform: `translateY(${row.top}px)` }"
        @click="emit('select', row.group.id)"
      >
        <div class="row-gutter">
          <a-checkbox
            :model-value="isChecked(row.group)"
            :aria-label="`勾选对齐组 ${row.group.order}`"
            @click.stop
            @change="(v: unknown) => emit('toggle-check', row.group.id, Boolean(v))"
          />
          <div class="row-order">{{ row.group.order }}</div>
          <div class="gutter-buttons">
            <a-button mini size="mini" title="整组上移" @click.stop="emit('move-group', row.group.id, -1)">↑</a-button>
            <a-button mini size="mini" title="整组下移" @click.stop="emit('move-group', row.group.id, 1)">↓</a-button>
          </div>
          <a-button
            size="mini"
            :type="row.group.accepted ? 'outline' : 'primary'"
            :status="row.group.accepted ? 'normal' : 'success'"
            @click.stop="emit('accept', row.group.id)"
          >
            {{ row.group.accepted ? '已接受' : '接受' }}
          </a-button>
        </div>

        <div class="row-cells">
          <div
            v-for="version in versions"
            :key="version.id"
            class="cell-column"
            :class="[`cell-${row.group.cells[version.id]?.status ?? 'empty'}`, { 'col-base': version.id === baseVersionId }]"
          >
            <template v-if="row.group.cells[version.id]">
              <div class="cell-head">
                <a-tag
                  size="small"
                  :color="statusColor[row.group.cells[version.id].status]"
                  @click.stop="emit('select', row.group.id)"
                >
                  {{ statusLabelMap[row.group.cells[version.id].status] }}
                </a-tag>
                <span class="cell-loc">{{ unitLabel(row.group.cells[version.id].unit) }}</span>
                <a-dropdown v-if="version.id !== baseVersionId" trigger="click" @click.stop>
                  <a-button size="mini" type="text" class="cell-menu">⋯</a-button>
                  <template #content>
                    <a-doption @click="emit('shift-cell', row.group.id, version.id, -1)">配对上移</a-doption>
                    <a-doption @click="emit('shift-cell', row.group.id, version.id, 1)">配对下移</a-doption>
                    <a-doption
                      :disabled="!row.group.cells[version.id].unit"
                      @click="emit('set-status', row.group.id, version.id, 'changed')"
                    >标为改动</a-doption>
                    <a-doption
                      :disabled="!row.group.cells[version.id].unit"
                      @click="emit('set-status', row.group.id, version.id, 'misaligned')"
                    >标为疑错位</a-doption>
                    <a-doption @click="emit('set-status', row.group.id, version.id, 'added')">标为新增</a-doption>
                    <a-doption @click="emit('set-status', row.group.id, version.id, 'removed')">标为删减</a-doption>
                    <a-doption @click="emit('set-status', row.group.id, version.id, 'same')">标为相同</a-doption>
                  </template>
                </a-dropdown>
              </div>

              <div v-if="row.group.cells[version.id].unit" class="cell-text">
                <template v-if="charDiff(row.group.cells[baseVersionId]?.unit?.text, row.group.cells[version.id])">
                  <span
                    v-for="(tok, ti) in charDiff(row.group.cells[baseVersionId]?.unit?.text, row.group.cells[version.id])"
                    :key="ti"
                    :class="diffSpanClass(tok)"
                    >{{ tok.text }}</span
                  >
                </template>
                <template v-else>{{ row.group.cells[version.id]?.unit?.text }}</template>
              </div>
              <div v-else class="cell-text cell-missing">（本版无此句 · 删减）</div>

              <div class="cell-foot">
                <span class="sim-hint" v-if="version.id !== baseVersionId && row.group.cells[version.id].unit">
                  相似度 {{ Math.round(row.group.cells[version.id].similarity * 100) }}%
                </span>
                <a-button size="mini" type="text" @click.stop="emit('annotate', row.group.id, version.id)">
                  {{ hasNote?.(version.id, row.group.cells[version.id].unit?.text) ? '📝 有校记' : '✎ 校记' }}
                </a-button>
                <span v-if="row.group.cells[version.id].manuallyAdjusted" class="manual-hint">人工</span>
              </div>            </template>
            <div v-else class="cell-empty">
              <span>—</span>
              <div class="cell-empty-actions">
                <a-button size="mini" type="text" title="把下方同版句挪上来" @click.stop="emit('shift-cell', row.group.id, version.id, 1)">配对↓</a-button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.align-scroll {
  position: relative;
  height: calc(100vh - 232px);
  min-height: 320px;
  overflow: auto;
  background: #f2f3f5;
}

.align-spacer {
  position: relative;
  width: max-content;
  min-width: 100%;
}

.align-row {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  width: max-content;
  min-width: 100%;
  padding: 0 10px;
  will-change: transform;
}

.row-active .row-gutter,
.row-active .cell-column {
  box-shadow: inset 0 0 0 2px #165dff;
}

.row-gutter {
  display: flex;
  flex: 0 0 64px;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  background: #fff;
  border: 1px solid #e5e6eb;
  border-right: 0;
  border-radius: 8px 0 0 8px;
}

.row-order {
  color: #86909c;
  font-size: 11px;
}

.gutter-buttons {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-cells {
  display: flex;
  flex: 1;
}

.cell-column {
  display: flex;
  flex: 0 0 248px;
  flex-direction: column;
  min-height: 120px;
  padding: 8px 10px;
  background: #fff;
  border: 1px solid #e5e6eb;
  border-left: 0;
}

.cell-column:last-child {
  border-right: 1px solid #e5e6eb;
  border-radius: 0 8px 8px 0;
}

.col-base {
  background: #f7faff;
}

.cell-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.cell-menu {
  margin-left: auto;
  padding: 0 4px;
}

.cell-loc {
  color: #86909c;
  font-size: 11px;
}

.cell-text {
  flex: 1;
  color: #1d2129;
  font-family: "Songti SC", "Noto Serif SC", serif;
  font-size: 15px;
  line-height: 1.75;
  white-space: pre-wrap;
}

.cell-missing {
  color: #cb2634;
  background: #fff7f8;
}

.cell-changed .cell-text {
  background: #fff8ef;
}

.cell-added {
  background: #f2fffb;
}

.cell-added .cell-text {
  color: #0d7a52;
}

.cell-removed {
  background: #fff4f5;
}

.cell-misaligned .cell-text {
  background: #f5f0ff;
}

.cell-empty {
  display: grid;
  flex: 1;
  place-items: center;
  color: #c9cdd4;
}

.cell-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.sim-hint,
.manual-hint {
  color: #a9aeb8;
  font-size: 11px;
}

.manual-hint {
  color: #165dff;
}

.tok-insert {
  background: #d1f4e3;
  color: #0a6b46;
  border-radius: 3px;
}

.tok-delete {
  background: #ffd8de;
  color: #b42331;
  text-decoration: line-through;
  border-radius: 3px;
}
</style>
