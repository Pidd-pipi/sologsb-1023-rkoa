<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import VersionPanel from './components/VersionPanel.vue';
import AlignGrid from './components/AlignGrid.vue';
import Inspector from './components/Inspector.vue';
import ImportVersionModal from './components/ImportVersionModal.vue';
import DraftsModal from './components/DraftsModal.vue';
import { useCollation } from './composables/useCollation';
import type { VersionDocument } from './types';

const {
  load,
  undo,
  redo,
  history,
  future,
  message,
  nextDifference,
  handleExport,
  stats,
  processing
} = useCollation();

const importVisible = ref(false);
const draftsVisible = ref(false);
const modalMode = ref<'import' | 'replace' | 'edit'>('import');
const modalTarget = ref<VersionDocument | null>(null);

function openImport() {
  modalMode.value = 'import';
  modalTarget.value = null;
  importVisible.value = true;
}
function openReplace(v: VersionDocument) {
  modalMode.value = 'replace';
  modalTarget.value = v;
  importVisible.value = true;
}
function openEditText(v: VersionDocument) {
  modalMode.value = 'edit';
  modalTarget.value = v;
  importVisible.value = true;
}

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing =
    target?.tagName === 'INPUT' ||
    target?.tagName === 'TEXTAREA' ||
    target?.isContentEditable ||
    target?.tagName === 'SELECT';
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
  if (typing) return;
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    nextDifference();
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  await load();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <a-layout class="shell">
    <a-layout-header class="topbar">
      <div class="topbar-inner">
        <div class="brand-row">
          <div class="brand-mark">校</div>
          <div>
            <h1 class="brand-title">校异斋 · 多版本古籍校勘台</h1>
            <div class="brand-sub">3–5 版同屏组对齐 · 逐版标改/增/删 · 校记随句走不丢失</div>
          </div>
        </div>
        <a-space wrap>
          <a-tooltip content="Ctrl/⌘ Z">
            <a-button :disabled="!history.length" @click="undo">撤销</a-button>
          </a-tooltip>
          <a-tooltip content="Ctrl/⌘ Shift Z">
            <a-button :disabled="!future.length" @click="redo">重做</a-button>
          </a-tooltip>
          <a-button @click="draftsVisible = true">
            草稿/备份<a-badge v-if="stats.orphans" :count="stats.orphans" :max-count="99" style="margin-left: 6px" />
          </a-button>
          <a-dropdown>
            <a-button type="primary">导出 ▾</a-button>
            <template #content>
              <a-doption @click="handleExport('html')">多版本对照 HTML</a-doption>
              <a-doption @click="handleExport('markdown')">校勘记 Markdown</a-doption>
              <a-doption @click="handleExport('json')">完整 JSON 备份</a-doption>
            </template>
          </a-dropdown>
        </a-space>
      </div>
      <div class="status-line" :class="{ busy: processing }">
        <span class="status-dot" />{{ message }}
      </div>
    </a-layout-header>

    <a-layout class="body-layout">
      <a-layout-sider class="pane pane-left" :width="300">
        <VersionPanel @import="openImport" @replace="openReplace" @edit-text="openEditText" @drafts="draftsVisible = true" />
      </a-layout-sider>

      <a-layout-content class="pane pane-center">
        <AlignGrid />
      </a-layout-content>

      <a-layout-sider class="pane pane-right" :width="340">
        <Inspector />
      </a-layout-sider>
    </a-layout>

    <ImportVersionModal v-model:visible="importVisible" :mode="modalMode" :target="modalTarget" />
    <DraftsModal v-model:visible="draftsVisible" />
  </a-layout>
</template>

<style scoped></style>
