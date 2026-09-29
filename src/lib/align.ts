import type { AlignmentGroup, Cell, CellStatus, ComparisonRules, TextUnit, VersionDocument } from '../types';
import { similarity, uid } from './text';

export interface Progress {
  phase: string;
  percent: number;
}

interface Pair<T> {
  x: T | null;
  y: T | null;
}

/** 两个序列的 Needleman–Wunsch 对齐，gap 为留空代价 */
function needlemanWunsch<T>(a: T[], b: T[], score: (x: T, y: T) => number, gap: number): Pair<T>[] {
  const m = a.length;
  const n = b.length;
  const dp: Float64Array[] = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  for (let i = 1; i <= m; i += 1) dp[i][0] = i * gap;
  for (let j = 1; j <= n; j += 1) dp[0][j] = j * gap;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const matchScore = dp[i - 1][j - 1] + score(a[i - 1], b[j - 1]);
      const gapA = dp[i][j - 1] + gap;
      const gapB = dp[i - 1][j] + gap;
      dp[i][j] = Math.max(matchScore, gapA, gapB);
    }
  }
  const pairs: Pair<T>[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + score(a[i - 1], b[j - 1])) {
      pairs.push({ x: a[i - 1], y: b[j - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && dp[i][j] === dp[i][j - 1] + gap) {
      pairs.push({ x: null, y: b[j - 1] });
      j -= 1;
    } else {
      pairs.push({ x: a[i - 1], y: null });
      i -= 1;
    }
  }
  return pairs.reverse();
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeCell(unit: TextUnit | undefined, status: CellStatus, sim: number): Cell {
  return { unit, status, similarity: sim, manuallyAdjusted: false };
}

interface ParaBucket {
  order: number;
  text: string;
  units: TextUnit[];
}

function paragraphBuckets(doc: VersionDocument): ParaBucket[] {
  const map = new Map<number, TextUnit[]>();
  doc.units.forEach((u) => {
    const list = map.get(u.paragraphOrder) ?? [];
    list.push(u);
    map.set(u.paragraphOrder, list);
  });
  return [...map.keys()]
    .sort((a, b) => a - b)
    .map((order) => ({ order, text: map.get(order)![0].paragraphText, units: map.get(order)! }));
}

function judgeStatus(sim: number, rules: ComparisonRules): CellStatus {
  if (sim >= 0.995) return 'same';
  if (sim < rules.misalignThreshold) return 'misaligned';
  return 'changed';
}

type ParaAlign =
  | { kind: 'match'; baseOrder: number; otherOrder: number; sentPairs: Pair<TextUnit>[] }
  | { kind: 'baseOnly'; baseOrder: number; units: TextUnit[] }
  | { kind: 'otherOnly'; otherOrder: number; units: TextUnit[] };

/** 某版本在单个底本段上的事件计划 */
type SentenceEvent =
  | { type: 'added'; versionId: string; unit: TextUnit }
  | { type: 'paired'; baseId: string; versionId: string; cell: Cell };

/**
 * 多版本对齐：以底本段落为锚先做段落级 NW，再在配对段落内做句级 NW。
 * 每个参校版本独立对齐到底本，再按底本段落与句序合并为对齐组：
 * 底本每句一组；参校本多出的句子各自成为该版本独有的新增组。
 * 处理按 24 个段落一片让出主线程，长文本不卡死。
 */
export async function alignVersions(
  base: VersionDocument,
  others: VersionDocument[],
  activeVersionIds: string[],
  rules: ComparisonRules,
  onProgress?: (p: Progress) => Promise<void> | void
): Promise<AlignmentGroup[]> {
  const orderedOthers = others.filter((v) => activeVersionIds.includes(v.id) && v.id !== base.id);
  const baseParas = paragraphBuckets(base);

  const versionParaAligns: Array<{ versionId: string; paras: ParaAlign[] }> = [];
  const totalVersions = Math.max(orderedOthers.length, 1);

  for (let vi = 0; vi < orderedOthers.length; vi += 1) {
    const version = orderedOthers[vi];
    const otherParas = paragraphBuckets(version);
    const paraPairs = needlemanWunsch(baseParas, otherParas, (x, y) => similarity(x.text, y.text, rules), -0.4);

    const paras: ParaAlign[] = [];
    let chunk = 0;
    for (const pp of paraPairs) {
      if (pp.x && pp.y) {
        const sentPairs = needlemanWunsch(pp.x.units, pp.y.units, (x, y) => similarity(x.text, y.text, rules), -0.35);
        paras.push({ kind: 'match', baseOrder: pp.x.order, otherOrder: pp.y.order, sentPairs });
      } else if (pp.x) {
        paras.push({ kind: 'baseOnly', baseOrder: pp.x.order, units: pp.x.units });
      } else if (pp.y) {
        paras.push({ kind: 'otherOnly', otherOrder: pp.y.order, units: pp.y.units });
      }
      chunk += 1;
      if (chunk % 24 === 0) {
        await yieldToUi();
        await onProgress?.({
          phase: `对齐《${version.name}》（段落 ${chunk}/${paraPairs.length}）`,
          percent: Math.round(((vi + Math.min(chunk / paraPairs.length, 1)) / totalVersions) * 100)
        });
      }
    }
    versionParaAligns.push({ versionId: version.id, paras });
    await onProgress?.({ phase: `对齐《${version.name}》完成`, percent: Math.round(((vi + 1) / totalVersions) * 100) });
  }

  const groups: AlignmentGroup[] = [];
  let order = 0;
  const pushGroup = (paragraphOrder: number, cells: Record<string, Cell>): void => {
    order += 1;
    groups.push({ id: uid('grp'), order, paragraphOrder, cells, accepted: false });
  };

  const cursors = new Map<string, number>(versionParaAligns.map((va) => [va.versionId, 0]));

  baseParas.forEach((basePara) => {
    // 收集每个版本在本段上的事件计划，按版本顺序穿插
    const perVersionPlans: SentenceEvent[][] = [];
    versionParaAligns.forEach(({ versionId, paras }) => {
      let cursor = cursors.get(versionId) ?? 0;
      // 本段之前的版本独有段落先输出为新增组
      while (cursor < paras.length && paras[cursor].kind === 'otherOnly') {
        const para = paras[cursor] as Extract<ParaAlign, { kind: 'otherOnly' }>;
        para.units.forEach((unit) => pushGroup(para.otherOrder, { [versionId]: makeCell(unit, 'added', 0) }));
        cursor += 1;
      }
      const plan: SentenceEvent[] = [];
      if (cursor < paras.length) {
        const para = paras[cursor];
        if (para.kind === 'match' && para.baseOrder === basePara.order) {
          let pendingAdded: TextUnit[] = [];
          para.sentPairs.forEach((sp) => {
            if (sp.x && sp.y) {
              pendingAdded.forEach((unit) => plan.push({ type: 'added', versionId, unit }));
              pendingAdded = [];
              const sim = similarity(sp.x.text, sp.y.text, rules);
              plan.push({ type: 'paired', baseId: sp.x.id, versionId, cell: makeCell(sp.y, judgeStatus(sim, rules), sim) });
            } else if (sp.y) {
              pendingAdded.push(sp.y);
            } else if (sp.x) {
              pendingAdded.forEach((unit) => plan.push({ type: 'added', versionId, unit }));
              pendingAdded = [];
              plan.push({ type: 'paired', baseId: sp.x.id, versionId, cell: makeCell(undefined, 'removed', 0) });
            }
          });
          pendingAdded.forEach((unit) => plan.push({ type: 'added', versionId, unit }));
          cursor += 1;
        } else if (para.kind === 'baseOnly' && para.baseOrder === basePara.order) {
          para.units.forEach((unit) => plan.push({ type: 'paired', baseId: unit.id, versionId, cell: makeCell(undefined, 'removed', 0) }));
          cursor += 1;
        }
      }
      cursors.set(versionId, cursor);
      perVersionPlans.push(plan);
    });

    // 以底本句子为骨架合并各版本计划
    basePara.units.forEach((baseUnit) => {
      const cells: Record<string, Cell> = { [base.id]: makeCell(baseUnit, 'base', 1) };
      perVersionPlans.forEach((plan) => {
        const idx = plan.findIndex((e) => e.type === 'paired' && e.baseId === baseUnit.id);
        if (idx < 0) return;
        for (let k = 0; k < idx; k += 1) {
          const ev = plan[k];
          if (ev.type === 'added') pushGroup(ev.unit.paragraphOrder, { [ev.versionId]: makeCell(ev.unit, 'added', 0) });
        }
        const paired = plan[idx] as Extract<SentenceEvent, { type: 'paired' }>;
        cells[paired.versionId] = paired.cell;
        plan.splice(0, idx + 1);
      });
      pushGroup(basePara.order, cells);
    });

    // 某版本在本段末尾还剩新增（句级对齐挂在最后）
    perVersionPlans.forEach((plan) => {
      plan.forEach((ev) => {
        if (ev.type === 'added') pushGroup(ev.unit.paragraphOrder, { [ev.versionId]: makeCell(ev.unit, 'added', 0) });
      });
    });
  });

  // 底本之后各版本剩余的独有段落
  versionParaAligns.forEach(({ versionId, paras }) => {
    let cursor = cursors.get(versionId) ?? 0;
    while (cursor < paras.length) {
      const para = paras[cursor];
      if (para.kind === 'otherOnly') {
        para.units.forEach((unit) => pushGroup(para.otherOrder, { [versionId]: makeCell(unit, 'added', 0) }));
      }
      cursor += 1;
    }
    cursors.set(versionId, cursor);
  });

  return groups;
}

/** 仅依据当前规则重新判定各组的 same/changed/misaligned，不重建对齐（改规则时调用） */
export function recalculateStatuses(groups: AlignmentGroup[], baseVersionId: string, rules: ComparisonRules): AlignmentGroup[] {
  return groups.map((group) => {
    const baseCell = group.cells[baseVersionId];
    if (!baseCell || !baseCell.unit) return group;
    const cells: Record<string, Cell> = { ...group.cells };
    Object.entries(cells).forEach(([versionId, cell]) => {
      if (versionId === baseVersionId || cell.manuallyAdjusted) return;
      if (cell.status === 'added' || cell.status === 'removed') return;
      if (!cell.unit) return;
      const sim = similarity(baseCell.unit!.text, cell.unit.text, rules);
      cells[versionId] = { ...cell, status: judgeStatus(sim, rules), similarity: sim };
    });
    return { ...group, cells };
  });
}
