<script setup lang="ts">
import { computed, ref } from 'vue';
import { Message } from '@arco-design/web-vue';
import { useCollation } from '../composables/useCollation';

defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>();

const {
  draftList,
  currentProjectId,
  switchProject,
  newProject,
  importProjectFile,
  handleExport,
  currentProject,
  claimOrphan,
  deleteOrphan,
  sentenceById
} = useCollation();

const tab = ref<'drafts' | 'orphans' | 'backup'>('drafts');
const fileInput = ref<HTMLInputElement | null>(null);
const newName = ref('');
const claimTarget = ref<Record<string, string>>({});

const orphans = computed(() => currentProject.value?.orphans ?? []);
const versionOptions = computed(() => currentProject.value?.versions ?? []);

function close() {
  emit('update:visible', false);
}

function open(id: string) {
  switchProject(id);
  close();
}

async function create() {
  await newProject(newName.value);
  newName.value = '';
  Message.success('新草稿已创建');
  close();
}

function pickJson() {
  fileInput.value?.click();
}
async function onJson(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const text = await file.text();
  const ok = await importProjectFile(text);
  if (ok) {
    Message.success('旧草稿已打开');
    close();
  } else {
    Message.error('文件不是有效的校勘 JSON');
  }
}

function candidateSentences(versionId: string) {
  return currentProject.value?.versions.find((v) => v.id === versionId)?.sentences.slice(0, 4000) ?? [];
}

function doClaim(orphanId: string) {
  const target = claimTarget.value[orphanId];
  if (!target || !target.includes('::')) {
    Message.warning('请先选择要指认到的版本与句子');
    return;
  }
  const [versionId, sentenceId] = target.split('::');
  claimOrphan(orphanId, versionId, sentenceId);
  Message.success('校记已重新挂载到该句');
}
</script>

<template>
  <a-modal :visible="visible" title="草稿、失主校记与备份" width="860px" :footer="false" @cancel="close">
    <a-tabs v-model:active-key="tab">
      <!-- 草稿列表 -->
      <a-tab-pane key="drafts" title="旧草稿">
        <div style="display: flex; gap: 8px; margin-bottom: 12px">
          <a-input v-model="newName" placeholder="新草稿名称" style="max-width: 260px" @press-enter="create" />
          <a-button type="primary" @click="create">新建空白草稿</a-button>
        </div>
        <a-list :data="draftList" :bordered="false" split>
          <template #item="{ item }">
            <a-list-item class="draft-item">
              <a-list-item-meta :title="item.name">
                <template #description>
                  {{ item.versions }} 个版本 · 更新于 {{ new Date(item.updatedAt).toLocaleString('zh-CN') }}
                </template>
              </a-list-item-meta>
              <template #actions>
                <a-button v-if="item.id !== currentProjectId" size="small" type="primary" @click="open(item.id)">打开</a-button>
                <a-tag v-else color="green">当前</a-tag>
              </template>
            </a-list-item>
          </template>
        </a-list>
        <div class="tip">所有草稿存在本机浏览器 localStorage，可在「备份」页导出 JSON 长期保存。</div>
      </a-tab-pane>

      <!-- 失主校记 -->
      <a-tab-pane key="orphans" :title="`失主校记（${orphans.length}）`">
        <a-empty v-if="!orphans.length" description="没有失主校记——所有校记都已挂在原句上" />
        <div v-else class="orphan-list">
          <div v-for="o in orphans" :key="o.id" class="orphan-card">
            <div class="orphan-meta">
              原属：{{ versionOptions.find((v) => v.id === o.originalVersionId)?.name ?? '已删除版本' }}
              · 更新 {{ new Date(o.updatedAt).toLocaleDateString('zh-CN') }}
            </div>
            <div class="orphan-text">{{ o.originalText || '（原句文本缺失）' }}</div>
            <div class="orphan-note">校记：{{ o.note }}<span v-if="o.source">（来源：{{ o.source }}）</span></div>
            <div class="orphan-actions">
              <a-select
                :model-value="claimTarget[o.id]"
                placeholder="选择版本…"
                size="small"
                style="width: 200px"
                @change="(v) => (claimTarget[o.id] = String(v))"
              >
                <a-option v-for="v in versionOptions" :key="v.id" :value="`${v.id}::`">{{ v.name }}</a-option>
              </a-select>
              <a-select
                :model-value="claimTarget[o.id]?.split('::')[1] || ''"
                placeholder="选择句子…"
                size="small"
                style="flex: 1; min-width: 240px"
                :disabled="!claimTarget[o.id]"
                @change="(sid) => (claimTarget[o.id] = `${claimTarget[o.id].split('::')[0]}::${String(sid)}`)"
              >
                <a-option
                  v-for="s in candidateSentences(claimTarget[o.id]?.split('::')[0] || '')"
                  :key="s.id"
                  :value="s.id"
                >
                  {{ s.paragraphOrder }}段{{ s.sentenceInParagraph }}句：{{ s.text.slice(0, 24) }}…
                </a-option>
              </a-select>
              <a-button size="small" type="primary" @click="doClaim(o.id)">指认</a-button>
              <a-popconfirm content="确定删除这条失主校记？" @ok="deleteOrphan(o.id)">
                <a-button size="small" status="danger" type="text">删除</a-button>
              </a-popconfirm>
            </div>
          </div>
        </div>
      </a-tab-pane>

      <!-- 备份 -->
      <a-tab-pane key="backup" title="备份 / 打开旧稿">
        <div class="backup-grid">
          <div class="backup-card">
            <h4>导出当前项目</h4>
            <p>完整保存版本正文、对齐组、人工锁定、校记、来源、规则。</p>
            <a-space>
              <a-button type="primary" @click="handleExport('json')">下载 JSON 备份</a-button>
              <a-button @click="handleExport('markdown')">校勘记 Markdown</a-button>
              <a-button @click="handleExport('html')">多版本对照 HTML</a-button>
            </a-space>
          </div>
          <div class="backup-card">
            <h4>打开旧稿</h4>
            <p>从 JSON 备份恢复为一个新草稿（不覆盖当前草稿）。</p>
            <input ref="fileInput" type="file" accept=".json,application/json" style="display: none" @change="onJson" />
            <a-button type="outline" @click="pickJson">选择 JSON 文件</a-button>
          </div>
        </div>
      </a-tab-pane>
    </a-tabs>
  </a-modal>
</template>

<style scoped>
.draft-item {
  padding: 8px 0;
}
.tip {
  margin-top: 10px;
  color: #86909c;
  font-size: 12px;
}
.orphan-list {
  display: grid;
  gap: 10px;
  max-height: 480px;
  overflow: auto;
}
.orphan-card {
  border: 1px solid #ffd8a8;
  background: #fff9f0;
  border-radius: 8px;
  padding: 10px 12px;
}
.orphan-meta {
  color: #86909c;
  font-size: 11px;
}
.orphan-text {
  font-family: "Songti SC", serif;
  margin: 6px 0;
  line-height: 1.7;
}
.orphan-note {
  color: #4e5969;
  font-size: 13px;
  margin-bottom: 8px;
}
.orphan-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.backup-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.backup-card {
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  padding: 14px;
}
.backup-card h4 {
  margin: 0 0 6px;
}
.backup-card p {
  color: #86909c;
  font-size: 12px;
  line-height: 1.7;
  margin: 0 0 10px;
}
</style>
