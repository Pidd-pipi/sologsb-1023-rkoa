<script setup lang="ts">
import { useCollation } from '../composables/useCollation';
import type { AlignGroup } from '../types';

const props = defineProps<{ group: AlignGroup }>();

const { baseVersion, baseSentencesOf, annotationFor, selectedCell, toggleLock, mergeWithNext, groupIndex, currentProject } =
  useCollation();

function select(sid: string) {
  selectedCell.value = { groupId: props.group.id, versionId: baseVersion.value!.id, sentenceId: sid };
}
function isSelected(sid: string) {
  return (
    selectedCell.value?.groupId === props.group.id &&
    selectedCell.value?.versionId === baseVersion.value?.id &&
    selectedCell.value?.sentenceId === sid
  );
}
function hasNote(sid: string) {
  return Boolean(annotationFor(baseVersion.value!.id, sid)?.note);
}
</script>

<template>
  <div class="bcell">
    <template v-if="baseSentencesOf(group).length">
      <div
        v-for="s in baseSentencesOf(group)"
        :key="s.id"
        class="base-sentence"
        :class="{ selected: isSelected(s.id), extra: group.baseExtraIds?.includes(s.id) }"
        @click="select(s.id)"
      >
        <div class="base-meta">
          <span>{{ s.paragraphOrder }} 段 · {{ s.sentenceInParagraph }} 句</span>
          <a-tooltip v-if="hasNote(s.id)" content="底本句已写校记">
            <a-tag size="small" color="arcoblue">记</a-tag>
          </a-tooltip>
        </div>
        <div class="base-text">{{ s.text }}</div>
      </div>
    </template>
    <div v-else class="insert-only">
      <a-tag color="green">各参校新增段</a-tag>
      <div class="insert-hint">底本无对应句</div>
    </div>

    <div class="group-tools" @click.stop>
      <a-tooltip :content="group.locked ? '已锁定：重对齐不动；点击解锁' : '锁定本组，重对齐时保持人工配对'">
        <a-button size="mini" :type="group.locked ? 'primary' : 'outline'" @click="toggleLock(group.id)">
          {{ group.locked ? '🔒' : '🔓' }}
        </a-button>
      </a-tooltip>
      <a-tooltip v-if="groupIndex(group.id) < (currentProject?.groups.length ?? 0) - 1" content="与下一组合并">
        <a-button size="mini" @click="mergeWithNext(group.id)">合下组</a-button>
      </a-tooltip>
    </div>
  </div>
</template>

<style scoped>
.bcell {
  position: relative;
  min-height: 64px;
}
.base-sentence + .base-sentence {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #c9cdd4;
}
.base-sentence.extra {
  opacity: 0.75;
}
.base-sentence.selected {
  background: #e8f3ff;
  border-radius: 5px;
  box-shadow: 0 0 0 2px #165dff;
}
.base-meta {
  display: flex;
  gap: 6px;
  align-items: center;
  color: #86909c;
  font-size: 10px;
  margin-bottom: 2px;
}
.base-text {
  font-family: "Songti SC", "Noto Serif SC", serif;
  font-size: 16px;
  line-height: 1.85;
  font-weight: 600;
  color: #1d2129;
}
.insert-only {
  padding: 10px 4px;
  text-align: center;
}
.insert-hint {
  margin-top: 6px;
  color: #86909c;
  font-size: 11px;
}
.group-tools {
  position: absolute;
  top: 0;
  right: 0;
  display: none;
  gap: 4px;
}
.bcell:hover .group-tools {
  display: flex;
}
.group-tools :deep(button) {
  padding: 0 6px;
  height: 24px;
  min-width: 28px;
  font-size: 12px;
}
</style>
