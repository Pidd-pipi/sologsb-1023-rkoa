<script setup lang="ts">
import { ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { useCollation } from '../composables/useCollation';
import type { VersionDocument } from '../types';

const props = defineProps<{
  visible: boolean;
  mode: 'import' | 'replace' | 'edit';
  target?: VersionDocument | null;
}>();
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'done'): void }>();

const { importVersion, replaceVersion, resegmentVersion, currentProject } = useCollation();

const name = ref('');
const source = ref('');
const text = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    if (props.mode !== 'import' && props.target) {
      name.value = props.target.name;
      source.value = props.target.source;
      text.value = props.target.text;
    } else {
      name.value = `新版本 ${(currentProject.value?.versions.length ?? 0) + 1}`;
      source.value = '';
      text.value = '';
    }
  }
);

const title = { import: '导入同一作品的新版本', replace: '替换版本（校记自动迁移）', edit: '修订正文并重新分句' }[props.mode];

function close() {
  emit('update:visible', false);
}

async function confirm() {
  if (!text.value.trim()) {
    Message.warning('请粘贴正文或选择 .txt 文件');
    return;
  }
  if (props.mode === 'import') {
    const ok = await importVersion(name.value, source.value, text.value.trim());
    if (ok) {
      Message.success('版本已导入并纳入对齐');
      close();
      emit('done');
    }
  } else if (props.mode === 'replace' && props.target) {
    await replaceVersion(props.target.id, name.value, source.value, text.value.trim());
    Message.success('版本已替换，校记已按句迁移');
    close();
    emit('done');
  } else if (props.mode === 'edit' && props.target) {
    if (name.value.trim() !== props.target.name || source.value.trim() !== props.target.source) {
      props.target.name = name.value.trim() || props.target.name;
      props.target.source = source.value.trim();
    }
    resegmentVersion(props.target.id, text.value.trim());
    Message.success('正文已更新并重新分句');
    close();
    emit('done');
  }
}

function pickFile() {
  fileInput.value?.click();
}
function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  file.text().then((content) => {
    text.value = content;
    if (!name.value || name.value.startsWith('新版本')) name.value = file.name.replace(/\.[^.]+$/, '');
  });
}
</script>

<template>
  <a-modal :visible="visible" :title="title" width="720px" :mask-closable="false" @ok="confirm" @cancel="close">
    <a-form layout="vertical" :model="{ name, source, text }">
      <a-grid :cols="2" :col-gap="12">
        <a-grid-item>
          <a-form-item label="版本名称">
            <a-input v-model="name" placeholder="如：帛书本 / 某刻本 / 某校点本" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="来源">
            <a-input v-model="source" placeholder="馆藏、整理者或文件来源" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="正文文件">
        <input ref="fileInput" type="file" accept=".txt,.md,text/plain" style="display: none" @change="onFile" />
        <a-button type="outline" long @click="pickFile">选择 .txt / .md 文件</a-button>
      </a-form-item>
      <a-form-item label="或直接粘贴正文">
        <a-textarea v-model="text" :auto-size="{ minRows: 10, maxRows: 20 }" placeholder="每行（或空行之间）为一段；句号、问号、感叹号、分号后自动分句" />
      </a-form-item>
      <a-alert type="info" :show-icon="true">
        <template v-if="mode === 'replace'">替换后按句间相似度迁移旧校记，无法自动归位的进「失主校记」可手动指认，绝不丢弃。</template>
        <template v-else-if="mode === 'edit'">修订正文会重新分句；原校记按相似度迁移，失主校记可在「草稿 / 备份」中找回。</template>
        <template v-else>空行或换行分段；分句规则各版本一致。导入只存本机浏览器，对齐分片执行，原文不被改写。</template>
      </a-alert>
    </a-form>
  </a-modal>
</template>
