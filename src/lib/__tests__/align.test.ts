import { describe, it, expect } from 'vitest';
import { autoAlignGroups } from '../align';
import { charDiff, makeVersion } from '../text';
import { migrateAnnotationsForResegment } from '../migrate';
import type { ComparisonRules } from '../../types';

const rules: ComparisonRules = {
  ignorePunctuation: true,
  ignoreVariants: true,
  matchThreshold: 0.45,
  crossParagraph: false,
  chunkSize: 3
};

const A = `古之善为士者，微妙玄通，深不可识。夫唯不可识，故强为之容。
豫兮若冬涉川，犹兮若畏四邻。
孰能浊以静之徐清？保此道者不欲盈。
夫唯不盈，故能蔽不新成。`;

const B = `古之善为道者，微玅玄通，深不可識。夫唯不可識，故強為之容。
與呵其若冬涉水，猶呵其若畏四鄰。嚴呵其若客。
孰能濁以靜之徐清？葆此道者不欲盈。
夫唯不欲盈，是以能敝而不成。此句帛书独有。`;

const C = `古之善為士者，微妙玄通，深不可識。
豫焉若冬涉川，猶兮若畏四鄰。儼兮其若容。
敦兮其若樸。
孰能濁以靜之徐清？保此道者不欲盈。
夫唯不盈，故能蔽不新成。`;

describe('多版本两级对齐算法', () => {
  it('整段插入不导致后续错位、各版句子不丢不重不串位', async () => {
    const base = makeVersion('vb', '底本', '', A);
    const w1 = makeVersion('w1', '帛书', '', B);
    const w2 = makeVersion('w2', '碑本', '', C);
    const groups = await autoAlignGroups({ baseVersion: base, witnesses: [w1, w2], rules, onProgress: () => {} });

    // 每个底本句恰好属于一个组
    const baseUsed = groups.filter((g) => g.baseSentenceId).map((g) => g.baseSentenceId);
    expect(new Set(baseUsed).size).toBe(baseUsed.length);
    expect(baseUsed.length).toBe(base.sentences.length);
    expect(groups.length).toBeGreaterThanOrEqual(base.sentences.length);

    for (const w of [w1, w2]) {
      const used: string[] = [];
      groups.forEach((g) => (g.cells[w.id] ?? []).forEach((id) => used.push(id)));
      expect(used.length).toBe(w.sentences.length);
      expect(new Set(used).size).toBe(used.length);
      // 配对句按底本锚点保序
      const matched = groups
        .filter((g) => g.baseSentenceId)
        .flatMap((g) => g.cells[w.id] ?? [])
        .map((id) => w.sentences.find((s) => s.id === id)!.globalOrder);
      expect(matched).toEqual([...matched].sort((a, b) => a - b));
      // 插入句保序
      const inserted = groups
        .filter((g) => !g.baseSentenceId)
        .flatMap((g) => g.cells[w.id] ?? [])
        .map((id) => w.sentences.find((s) => s.id === id)!.globalOrder);
      expect(inserted).toEqual([...inserted].sort((a, b) => a - b));
    }

    // 首句配对
    const g0 = groups.find((g) => g.baseSentenceId === base.sentences[0].id)!;
    expect(g0.cells[w1.id]).toHaveLength(1);
    expect(g0.cells[w2.id]).toHaveLength(1);

    // 帛书独有句在新增组，碑本该组为空
    const insertSent = w1.sentences.find((s) => s.text.includes('独有'))!;
    const insertGroup = groups.find((g) => !g.baseSentenceId && g.cells[w1.id]?.includes(insertSent.id))!;
    expect(insertGroup).toBeTruthy();
    expect(w2.id in insertGroup.cells).toBe(false);

    // 碑本插入段「敦兮」必须在「保此道」之前，且后续「保此道」仍正确同组
    const baoBase = base.sentences.find((s) => s.text.includes('保此道'))!;
    const baoGroup = groups.find((g) => g.baseSentenceId === baoBase.id)!;
    expect(baoGroup.cells[w2.id]).toHaveLength(1);
    const dunIdx = groups.findIndex((g) =>
      !g.baseSentenceId && (g.cells[w2.id] ?? []).some((id) => w2.sentences.find((s) => s.id === id)!.text.includes('敦兮'))
    );
    expect(dunIdx).toBeGreaterThanOrEqual(0);
    expect(dunIdx).toBeLessThan(groups.indexOf(baoGroup));

    // 末句两版都配对
    const lastBase = base.sentences[base.sentences.length - 1];
    const lastGroup = groups.find((g) => g.baseSentenceId === lastBase.id)!;
    expect(lastGroup.cells[w1.id]).toHaveLength(1);
    expect(lastGroup.cells[w2.id]).toHaveLength(1);
  });

  it('字符级 diff 标出新增/删除并保留公共部分', () => {
    const diff = charDiff('古之善为士者', '古之善为道者', rules);
    expect(diff.some((t) => t.op === 'delete' && t.text.includes('士'))).toBe(true);
    expect(diff.some((t) => t.op === 'insert' && t.text.includes('道'))).toBe(true);
    expect(diff.filter((t) => t.op === 'equal').map((t) => t.text).join('')).toBe('古之善为者');
  });

  it('重新分句迁移校记；找不到对应句则进失主池并保留原文', async () => {
    const base = makeVersion('vb', '底本', '', A);
    const ann = { id: 'a1', versionId: 'vb', sentenceId: base.sentences[0].id, note: '士一作道', source: 'x', updatedAt: '' };
    const reText = A.replace('。夫唯不可识', '，夫唯不可识');
    const resegmented = makeVersion('vb', '底本', '', reText);
    expect(resegmented.sentences.length).not.toBe(base.sentences.length);

    const mig = migrateAnnotationsForResegment({ a1: ann }, [], base.sentences, resegmented.sentences, rules, 'vb');
    expect(mig.orphaned).toBe(0);
    expect(Object.values(mig.annotations)[0].sentenceId).toBe(resegmented.sentences[0].id);

    const other = makeVersion('vb', '底本', '', '完全无关的内容。另一句话。');
    const mig2 = migrateAnnotationsForResegment({ a1: ann }, [], base.sentences, other.sentences, rules, 'vb');
    expect(mig2.orphaned).toBe(1);
    expect(mig2.orphans[0].originalText).toContain('善为士');
  });

  it('锁定组重对齐后人工配对原样保留、句子不重复出现', async () => {
    const base = makeVersion('vb', '底本', '', A);
    const w1 = makeVersion('w1', '帛书', '', B);
    const w2 = makeVersion('w2', '碑本', '', C);
    const initial = await autoAlignGroups({ baseVersion: base, witnesses: [w1, w2], rules, onProgress: () => {} });

    const locked = initial.map((g) => ({ ...g, cells: JSON.parse(JSON.stringify(g.cells)) }));
    const target = locked.find((g) => g.baseSentenceId === base.sentences[1].id)!;
    target.locked = true;
    const fakeWid = w1.sentences[2].id;
    target.cells[w1.id] = [fakeWid];

    const re = await autoAlignGroups({
      baseVersion: base,
      witnesses: [w1, w2],
      rules,
      lockedGroups: locked.filter((g) => g.locked),
      onProgress: () => {}
    });
    const relocked = re.find((g) => g.baseSentenceId === base.sentences[1].id)!;
    expect(relocked.locked).toBe(true);
    expect(relocked.cells[w1.id][0]).toBe(fakeWid);
    expect(re.filter((g) => g.cells[w1.id]?.includes(fakeWid))).toHaveLength(1);
  });

  it('长文本（约 1500 句）对齐无丢句并识别全部插入段', async () => {
    const N = 750;
    let a = '';
    for (let p = 0; p < N; p += 1) a += `道可道非常道${p}，名可名非常名。玄之又玄众妙之门${p}。\n`;
    let b = a.replace(/。玄/g, '。玅');
    b = b
      .split('\n')
      .map((line, i) => (i % 50 === 10 ? `${line}\n帛书独此段有逸文${i}。` : line))
      .join('\n')
      .replace('名可名非常名3。', '');
    const base = makeVersion('b', '底', '', a.trim());
    const w = makeVersion('w', '参', '', b.trim());
    const groups = await autoAlignGroups({ baseVersion: base, witnesses: [w], rules, onProgress: () => {} });
    let used = 0;
    groups.forEach((g) => (used += (g.cells[w.id] ?? []).length));
    expect(used).toBe(w.sentences.length);
    expect(groups.filter((g) => g.baseSentenceId).length).toBe(base.sentences.length);
    expect(groups.filter((g) => !g.baseSentenceId).length).toBeGreaterThanOrEqual(10);
  });
});
