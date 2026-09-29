import { describe, it, expect, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { useCollation, __resetCollationForTests } from '../composables/useCollation';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v2';
const flush = () => new Promise((r) => setTimeout(r, 30));

describe('校记随句走与人工配对不串位（集成）', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetCollationForTests();
  });

  it('全链路：写校记 → 改规则重对齐 → 校记保留；人工挪句锁定 → 再重对齐不串位；换底本校记不丢', async () => {
    const c = useCollation();
    await c.load();
    await flush();

    const p = c.currentProject.value!;
    expect(p.versions.length).toBe(4);
    expect(p.groups.length).toBeGreaterThan(0);

    // 1) 在某个参校句上写校记
    const witnessId = p.witnessIds[0];
    const targetGroup = p.groups.find((g) => g.baseSentenceId && (g.cells[witnessId] ?? []).length === 1)!;
    const witnessSentenceId = targetGroup.cells[witnessId][0];
    const baseSentenceId = targetGroup.baseSentenceId!;
    c.saveAnnotation(witnessId, witnessSentenceId, '此为异文，据本校定', '某馆藏本');
    await nextTick();
    expect(Object.keys(p.annotations)).toHaveLength(1);

    // 2) 改规则重对齐，校记仍挂原句
    const beforeGroupCount = p.groups.length;
    await c.realign({ label: '重对齐' });
    await flush();
    const ann1 = Object.values(p.annotations)[0];
    expect(ann1.sentenceId).toBe(witnessSentenceId);
    expect(ann1.note).toBe('此为异文，据本校定');
    expect(ann1.source).toBe('某馆藏本');
    expect(p.groups.length).toBe(beforeGroupCount);

    // 3) 人工挪动该句到下一组（同版列内），两组被锁定
    const groupId = p.groups.find(
      (g) => g.baseSentenceId === baseSentenceId && (g.cells[witnessId] ?? []).includes(witnessSentenceId)
    )!.id;
    c.moveSentence(groupId, witnessId, witnessSentenceId, 1);
    await nextTick();
    const movedTo = p.groups.find((g) => (g.cells[witnessId] ?? []).includes(witnessSentenceId))!;
    expect(movedTo.locked).toBe(true);

    // 4) 再重对齐，锁定组人工配对原样保留
    await c.realign({ label: '再重对齐' });
    await flush();
    const stillMoved = p.groups.find((g) => (g.cells[witnessId] ?? []).includes(witnessSentenceId))!;
    expect(stillMoved.locked).toBe(true);
    // 校记仍随句
    expect(Object.values(p.annotations)[0].sentenceId).toBe(witnessSentenceId);

    // 5) 换底本：新底本=原参校，旧底本回到参校；各版校记全部保留
    const oldBaseId = p.baseVersionId;
    c.setBaseVersion(witnessId);
    await flush();
    await flush();
    expect(p.baseVersionId).toBe(witnessId);
    expect(p.witnessIds).toContain(oldBaseId);
    expect(Object.keys(p.annotations)).toHaveLength(1);
    expect(Object.values(p.annotations)[0].versionId).toBe(witnessId);

    // 6) 持久化：可作为旧草稿重新打开，校记仍在
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      projects: { annotations: Record<string, { note: string }> }[];
    };
    expect(Object.values(raw.projects[0].annotations)[0].note).toBe('此为异文，据本校定');
  });

  it('多草稿：新建、切换、重开互不覆盖', async () => {
    const c = useCollation();
    await c.load();
    await flush();
    const firstId = c.currentProjectId.value!;
    await c.newProject('第二稿');
    await flush();
    expect(c.currentProjectId.value).not.toBe(firstId);
    expect(c.projects.value.length).toBe(2);
    c.switchProject(firstId);
    expect(c.currentProjectId.value).toBe(firstId);
  });

  it('失主校记：删除版本后其校记进入失主池，可重新指认', async () => {
    const c = useCollation();
    await c.load();
    await flush();
    const p = c.currentProject.value!;
    const wid = p.witnessIds[0];
    const sid = p.versions.find((v) => v.id === wid)!.sentences[0].id;
    c.saveAnnotation(wid, sid, '将随版本进失主池', '来源X');
    expect(Object.keys(p.annotations)).toHaveLength(1);
    c.deleteVersion(wid);
    await flush();
    expect(p.orphans.length).toBe(1);
    expect(p.orphans[0].note).toBe('将随版本进失主池');

    // 指认到另一版的某句
    const targetWid = p.witnessIds[0];
    const targetSid = p.versions.find((v) => v.id === targetWid)!.sentences[0].id;
    c.claimOrphan(p.orphans[0].id, targetWid, targetSid);
    expect(p.orphans.length).toBe(0);
    expect(Object.values(p.annotations)[0].sentenceId).toBe(targetSid);
  });
});
