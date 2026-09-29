<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { useCollation } from '../composables/useCollation';
import type { DifferenceStatus } from '../types';

const {
  currentProject,
  baseVersion,
  witnessVersions,
  selectedCell,
  selectedGroupId,
  sentenceById,
  annotationFor,
  saveAnnotation,
  getCellStatus,
  overrideStatus,
  acceptCell,
  unacceptCell,
  getCellAccepted,
  toggleLock,
  currentProjectId
} = useCollation();

void currentProjectId;

const noteDraft = ref('');
const sourceDraft = ref('');

const selectedSentence = computed(() => {
  const c = selectedCell.value;
  if (!c || !c.sentenceId) return null;
  return {
    versionId: c.versionId,
    sentence: sentenceById(c.versionId, c.sentenceId)
  };
});

const selectedVersion = computed(() =>
  currentProject.value?.versions.find((v) => v.id === selectedCell.value?.versionId)
);

const selectedGroup = computed(() =>
  currentProject.value?.groups.find((g) => g.id === (selectedCell.value?.groupId ?? selectedGroupId.value))
);

const existingAnnotation = computed(() =>
  selectedSentence.value ? annotationFor(selectedSentence.value.versionId, selectedSentence.value.sentence!.id) : undefined
);

const cellState = computed(() => {
  if (!selectedGroup.value || !selectedCell.value) return null;
  return {
    status: getCellStatus(selectedGroup.value, selectedCell.value.versionId),
    accepted: getCellAccepted(selectedGroup.value, selectedCell.value.versionId),
    isBase: selectedCell.value.versionId === currentProject.value?.baseVersionId
  };
});

watch(
  selectedSentence,
  () => {
    noteDraft.value = existingAnnotation.value?.note ?? '';
    sourceDraft.value = existingAnnotation.value?.source ?? '';
  },
  { immediate: true }
);

const statusOptions: { value: DifferenceStatus; label: string }[] = [
  { value: 'same', label: '相同' },
  { value: 'changed', label: '改动' },
  { value: 'added', label: '新增' },
  { value: 'removed', label: '删减' },
  { value: 'misaligned', label: '疑错位' }
];

function save() {
  if (!selectedSentence.value) return;
  saveAnnotation(
    selectedSentence.value.versionId,
    selectedSentence.value.sentence!.id,
    noteDraft.value.trim(),
    sourceDraft.value.trim()
  );
  Message.success('校记与来源已保存，随原句走');
}

function pickStatus(value: unknown) {
  if (!selectedGroup.value || !selectedCell.value) return;
  overrideStatus(selectedGroup.value.id, selectedCell.value.versionId, String(value) as DifferenceStatus);
}

function toggleAccept() {
  if (!selectedGroup.value || !selectedCell.value) return;
  const { id } = selectedGroup.value;
  const vid = selectedCell.value.versionId;
  getCellAccepted(selectedGroup.value, vid) ? unacceptCell(id, vid) : acceptCell(id, vid);
}

function statusColor(status: DifferenceStatus): string {
  return { same: 'gray', changed: 'orange', added: 'green', removed: 'red', misaligned: 'arcoblue' }[status];
}
</script>

<template>
  <div class="inspector">
    <template v-if="selectedSentence && selectedSentence.sentence">
      <section class="panel-section">
        <div class="insp-head">
          <a-tag :color="cellState?.isBase ? 'arcoblue' : 'purple'">{{ cellState?.isBase ? '底本句' : '参校句' }}</a-tag>
          <div class="ver-name">{{ selectedVersion?.name }}</div>
        </div>
        <div class="sentence-loc">
          第 {{ selectedSentence.sentence.paragraphOrder }} 段 · 第 {{ selectedSentence.sentence.sentenceInParagraph }} 句
        </div>
        <div class="sentence-quote">{{ selectedSentence.sentence.text }}</div>
      </section>

      <section v-if="!cellState?.isBase && cellState" class="panel-section">
        <div class="insp-label">差异裁定（组内该版）</div>
        <a-radio-group
          :model-value="cellState.status.status"
          type="button"
          size="small"
          style="flex-wrap: wrap; gap: 4px"
          @change="pickStatus"
        >
          <a-radio v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</a-radio>
        </a-radio-group>
        <div class="sim-line">
          自动相似度 {{ Math.round(cellState.status.similarity * 100) }}%
          <span v-if="cellState.status.manual"> · 已人工改判</span>
        </div>
        <a-space style="margin-top: 8px; width: 100%">
          <a-button size="small" long :status="cellState.accepted ? 'normal' : 'success'" :type="cellState.accepted ? 'outline' : 'primary'" @click="toggleAccept">
            {{ cellState.accepted ? '撤回接受' : '接受该判断' }}
          </a-button>
          <a-button size="small" @click="selectedGroup && toggleLock(selectedGroup.id)">
            {{ selectedGroup?.locked ? '解锁本组' : '锁定本组' }}
          </a-button>
        </a-space>
      </section>

      <section class="panel-section">
        <div class="insp-label">校勘说明</div>
        <a-textarea
          v-model="noteDraft"
          placeholder="记录异文判断依据，如：某字当作某，据某本正之"
          :auto-size="{ minRows: 5, maxRows: 12 }"
        />
        <a-input v-model="sourceDraft" placeholder="来源，如：景龙碑 / 某学者校记 / 某馆藏本" style="margin-top: 8px" />
        <div class="source-hint">校记与来源挂在「版本 + 此句」上，换底本、改规则重对齐、重新分句都会跟随；无法自动归位时进失主池。</div>
        <a-button type="primary" long style="margin-top: 10px" @click="save">保存校记 / 来源</a-button>
        <div v-if="existingAnnotation" class="saved-meta">
          上次保存：{{ new Date(existingAnnotation.updatedAt).toLocaleString('zh-CN') }}
        </div>
      </section>

      <section class="panel-section">
        <div class="insp-label">同组对照速览</div>
        <div class="quick-base">
          <span class="quick-tag">底本</span>{{ baseVersion?.sentences.find((s) => s.id === selectedGroup?.baseSentenceId)?.text ?? '（新增段，底本无）' }}
        </div>
        <div v-for="w in witnessVersions" :key="w.id" class="quick-witness">
          <div class="quick-name">
            <span class="quick-tag wit">{{ w.name }}</span>
            <a-tag size="small" v-if="selectedGroup" :color="statusColor(getCellStatus(selectedGroup, w.id).status)">
              {{ getCellStatus(selectedGroup, w.id).status === 'same' ? '相同' : getCellStatus(selectedGroup, w.id).status === 'changed' ? '改动' : getCellStatus(selectedGroup, w.id).status === 'added' ? '新增' : getCellStatus(selectedGroup, w.id).status === 'removed' ? '删减' : '疑错位' }}
            </a-tag>
          </div>
          <div class="quick-text">
            <template v-if="selectedGroup && (selectedGroup.cells[w.id] ?? []).length">
              <span v-for="sid in selectedGroup.cells[w.id]" :key="sid">{{ sentenceById(w.id, sid)?.text }} </span>
            </template>
            <span v-else class="muted">—</span>
          </div>
        </div>
      </section>
    </template>

    <div v-else-if="selectedGroup" class="panel-section empty-hint">
      <a-tag color="orange">删减格</a-tag>
      <p>该版本在此组无对应句。点击有文字的句子格可写校记；底本缺失内容请在底本列对应句上记录。</p>
      <button class="link-btn" @click="selectedCell = null">取消选择</button>
    </div>

    <div v-else class="inspector-empty">
      <div class="empty-glyph">勘</div>
      <p>点击中间任意一句<br />在此填写校记、来源并裁定异文</p>
      <div class="shortcut-tip">
        <div><a-tag size="small">Alt ↓</a-tag> 下一处差异</div>
        <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
        <div><a-tag size="small">Ctrl/⌘ Shift Z</a-tag> 重做</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inspector {
  height: 100%;
  overflow-y: auto;
  background: #fff;
}
.insp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.ver-name {
  font-size: 13px;
  font-weight: 650;
}
.sentence-loc {
  color: #86909c;
  font-size: 11px;
  margin-bottom: 6px;
}
.sentence-quote {
  font-family: "Songti SC", "Noto Serif SC", serif;
  font-size: 16px;
  line-height: 1.9;
  background: #f7f8fa;
  border-radius: 6px;
  padding: 8px 10px;
}
.insp-label {
  color: #4e5969;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
}
.sim-line {
  margin-top: 8px;
  color: #86909c;
  font-size: 11px;
}
.source-hint {
  margin-top: 6px;
  color: #a9aeb8;
  font-size: 11px;
  line-height: 1.6;
}
.saved-meta {
  margin-top: 6px;
  color: #a9aeb8;
  font-size: 11px;
  text-align: right;
}
.empty-hint p {
  color: #86909c;
  font-size: 12px;
  line-height: 1.7;
}
.link-btn {
  border: 0;
  background: none;
  color: #165dff;
  cursor: pointer;
  padding: 0;
  font-size: 12px;
}
.inspector-empty {
  display: grid;
  place-items: center;
  min-height: 420px;
  text-align: center;
  color: #86909c;
  padding: 20px;
}
.empty-glyph {
  font-family: "Songti SC", serif;
  font-size: 40px;
  color: #c9cdd4;
  margin-bottom: 12px;
}
.shortcut-tip {
  margin-top: 24px;
  font-size: 12px;
  line-height: 2.4;
}
.quick-base {
  font-family: "Songti SC", "Noto Serif SC", serif;
  font-size: 14px;
  line-height: 1.8;
  background: #f7f8fa;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.quick-tag {
  display: inline-block;
  background: #165dff;
  color: #fff;
  font-size: 10px;
  border-radius: 3px;
  padding: 1px 5px;
  margin-right: 6px;
  vertical-align: 2px;
}
.quick-tag.wit {
  background: #722ed1;
}
.quick-witness {
  padding: 6px 0;
  border-bottom: 1px dashed #f2f3f5;
}
.quick-name {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}
.quick-text {
  font-family: "Songti SC", "Noto Serif SC", serif;
  font-size: 14px;
  line-height: 1.8;
  padding-left: 4px;
}
.muted {
  color: #c9cdd4;
}
</style>
