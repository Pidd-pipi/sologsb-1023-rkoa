import { describe, it, expect, beforeEach } from 'vitest';
import { useCollation, __resetCollationForTests } from '../composables/useCollation';

const flush = () => new Promise((r) => setTimeout(r, 40));

describe('导出文件内容检查', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetCollationForTests();
  });

  it('生成多版本对照 HTML 与校勘记 Markdown，含逐版异文与校记', async () => {
    const c = useCollation();
    await c.load();
    await flush();
    const p = c.currentProject.value!;
    // 在底本首句和一个改动句上写校记
    const baseId = p.baseVersionId;
    const wid = p.witnessIds[0];
    const g = p.groups.find((x) => x.baseSentenceId && (x.cells[wid] ?? []).length && c.getCellStatus(x, wid).status !== 'same')!;
    c.saveAnnotation(wid, g.cells[wid][0], '「道」「士」异文，帛书作道', '马王堆帛书');
    c.saveAnnotation(baseId, g.baseSentenceId!, '底本句按王弼注本', '楼宇烈校释');

    // 通过返回值直接取得导出内容
    const md = c.exportMarkdown();
    const html = c.exportComparisonHtml();

    expect(md).toContain('底本：王弼注本');
    expect(md).toContain('参校本：帛书老子');
    expect(md).toContain('「道」「士」异文');
    expect(md).toContain('马王堆帛书');
    expect(md).toContain('改动');
    expect(html).toContain('王弼注本');
    expect(html).toContain('帛书老子');
    expect(html).toContain('景龙碑本');
    expect(html).toContain('多版本对照');
    expect(html).toContain('「道」「士」异文');
    // 颜色分类样式存在
    expect(html).toContain('td.changed');
  });
});
