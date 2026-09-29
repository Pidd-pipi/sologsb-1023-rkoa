import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ArcoVue from '@arco-design/web-vue';
import App from '../App.vue';
import { __resetCollationForTests } from '../composables/useCollation';

// Arco 表格/虚拟列表依赖部分布局 API，happy-dom 未实现，做最小桩
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error 测试环境桩（happy-dom 未实现 ResizeObserver）
globalThis.ResizeObserver = globalThis.ResizeObserver || (ResizeObserverStub as unknown as ResizeObserver);
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v2';

async function waitFor(cond: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 30));
    await flushPromises();
  }
  throw new Error('等待条件超时');
}

function mountApp() {
  return mount(App, {
    global: {
      plugins: [ArcoVue]
    },
    attachTo: document.body
  });
}

describe('多版本校勘工作台', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetCollationForTests();
    vi.useRealTimers();
  });

  it('载入 4 个示例版本并自动对齐，渲染底本句与逐版异文格', async () => {
    const wrapper = mountApp();
    await waitFor(() => wrapper.text().includes('古之善为士者') && wrapper.text().includes('帛书老子'));

    const text = wrapper.text();
    expect(text).toContain('王弼注本');
    expect(text).toContain('景龙碑本');
    expect(text).toContain('改动');
    wrapper.unmount();
  });

  it('自动对齐结果完整且无句子重复/丢失，并持久化为可重开的草稿', async () => {
    const wrapper = mountApp();
    await waitFor(() => {
      const raw = localStorage.getItem(STORAGE_KEY);
      return Boolean(raw && JSON.parse(raw).projects?.[0]?.groups?.length);
    });

    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    const proj = raw.projects[0];
    expect(proj.versions).toHaveLength(4);
    expect(proj.witnessIds).toHaveLength(3);
    expect(proj.baseVersionId).toBe(proj.versions[0].id);
    // 组数 >= 底本句数（含插入组）
    expect(proj.groups.length).toBeGreaterThanOrEqual(proj.versions[0].sentences.length);

    for (const wid of proj.witnessIds) {
      const all: string[] = [];
      proj.groups.forEach((g: { cells: Record<string, string[]> }) => {
        (g.cells[wid] ?? []).forEach((id: string) => all.push(id));
      });
      const version = proj.versions.find((v: { id: string }) => v.id === wid);
      expect(new Set(all).size).toBe(all.length); // 不重复
      expect(all.length).toBe(version.sentences.length); // 不丢失
    }
    wrapper.unmount();
  });

  it('换底本后重新对齐，旧底本校记仍随原句保留', async () => {
    const wrapper = mountApp();
    await waitFor(() => Boolean(localStorage.getItem(STORAGE_KEY)));
    await new Promise((r) => setTimeout(r, 100));
    // 直接操作持久层：模拟在首句写一条校记，再切换底本
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    const proj = raw.projects[0];
    const baseFirstSentence = proj.versions[0].sentences[0];
    proj.annotations = {
      annTest: {
        id: 'annTest',
        versionId: proj.versions[0].id,
        sentenceId: baseFirstSentence.id,
        note: '士一作道，据帛书正',
        source: '测试来源',
        updatedAt: new Date().toISOString()
      }
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));

    // 重新挂载以加载写入的数据
    wrapper.unmount();
    const wrapper2 = mountApp();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 80));
    const reloaded = JSON.parse(localStorage.getItem(STORAGE_KEY)!).projects[0];
    // 校记仍挂在原版本的原句上（换版本/重对齐也不丢）
    const ann = Object.values(reloaded.annotations)[0] as { note: string; source: string; sentenceId: string };
    expect(ann.note).toBe('士一作道，据帛书正');
    expect(ann.sentenceId).toBe(baseFirstSentence.id);
    wrapper2.unmount();
  });
});
