import type {
  AlignGroup,
  ComparisonRules,
  Sentence,
  VersionDocument
} from '../types';
import { normalizedSimilarity } from './text';

/**
 * 多版本对齐：以底本为锚，对每个参校版本独立做序列对齐，再按底本句序合并为组。
 * 默认两级对齐——先对段（整段相似度），再在配对段内对句：
 * 这样某版多/少整段时，后续段落不会因段号错位而被误判成新增。
 * 勾选「允许跨段落配对」时退化为整文本句级 DP。
 *
 * 长文本：DP 按底本行分片让出主线程，回溯与组装配为轻量操作。
 */

export interface AlignProgress {
  phase: string;
  percent: number;
}

interface MatchOp {
  kind: 'match';
  base: Sentence;
  witness: Sentence;
  similarity: number;
}
interface BaseOnlyOp {
  kind: 'baseOnly';
  base: Sentence;
}
interface WitnessOnlyOp {
  kind: 'witnessOnly';
  witness: Sentence;
}
export type AlignOp = MatchOp | BaseOnlyOp | WitnessOnlyOp;

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    const timer = (globalThis as { setTimeout?: typeof setTimeout }).setTimeout;
    if (timer) timer(resolve, 0);
    else resolve();
  });
}

const PUNCT = /[，。！？；、,.!?;\s]/g;

function pairThreshold(bs: Sentence, ws: Sentence, rules: ComparisonRules): number {
  const minLen = Math.min(bs.text.replace(PUNCT, '').length, ws.text.replace(PUNCT, '').length);
  return minLen <= 4 ? Math.max(rules.matchThreshold, 0.6) : rules.matchThreshold;
}

interface DpTable {
  base: Sentence[];
  witness: Sentence[];
  dp: Float64Array;
  width: number;
  rules: ComparisonRules;
}

function at(table: DpTable, i: number, j: number): number {
  return table.dp[i * table.width + j];
}

/**
 * 全序列计算 DP；按底本行数分片让出主线程（只让出，不切断计算，保证全局最优对齐）。
 * 回溯在整条对角线上一次性完成，杜绝跨片误配。
 */
async function buildDp(
  base: Sentence[],
  witness: Sentence[],
  rules: ComparisonRules,
  chunkRows: number,
  onProgress?: (percent: number) => void
): Promise<DpTable> {
  const m = base.length;
  const n = witness.length;
  const GAP = 1;
  const MISMATCH = 2;
  const width = n + 1;
  const dp = new Float64Array((m + 1) * width);
  const simCache = new Float32Array(m * n).fill(-1);
  const getSim = (i: number, j: number) => {
    const key = i * n + j;
    if (simCache[key] < 0) simCache[key] = normalizedSimilarity(base[i].text, witness[j].text, rules);
    return simCache[key];
  };

  for (let j = 1; j <= n; j += 1) dp[j] = -GAP * j;

  let i = 1;
  while (i <= m) {
    const rowEnd = Math.min(m + 1, i + chunkRows);
    for (; i < rowEnd; i += 1) {
      dp[i * width] = -GAP * i;
      for (let j = 1; j <= n; j += 1) {
        const bs = base[i - 1];
        const ws = witness[j - 1];
        const sim = getSim(i - 1, j - 1);
        const sameParagraph = bs.paragraphOrder === ws.paragraphOrder || rules.crossParagraph;
        const canMatch = sameParagraph && sim >= pairThreshold(bs, ws, rules);
        const matchScore = canMatch
          ? 2 * sim + (bs.paragraphOrder === ws.paragraphOrder ? 0.05 : 0)
          : -MISMATCH;
        dp[i * width + j] = Math.max(
          dp[(i - 1) * width + j - 1] + matchScore,
          dp[(i - 1) * width + j] - GAP,
          dp[i * width + j - 1] - GAP
        );
      }
    }
    onProgress?.(Math.round(((i - 1) / m) * 100));
    await yieldToBrowser();
  }
  return { base, witness, dp, width, rules };
}

/** 全对角线回溯（正序输出），结果为全局最优对齐，无分片边界问题 */
function backtrack(table: DpTable): AlignOp[] {
  const { base, witness, rules } = table;
  const MISMATCH = 2;
  const GAP = 1;
  const ops: AlignOp[] = [];
  let i = base.length;
  let j = witness.length;
  while (i > 0 && j > 0) {
    const bs = base[i - 1];
    const ws = witness[j - 1];
    const sim = normalizedSimilarity(bs.text, ws.text, rules);
    const sameParagraph = bs.paragraphOrder === ws.paragraphOrder || rules.crossParagraph;
    const canMatch = sameParagraph && sim >= pairThreshold(bs, ws, rules);
    const diag = canMatch
      ? at(table, i - 1, j - 1) + 2 * sim + (bs.paragraphOrder === ws.paragraphOrder ? 0.05 : 0)
      : at(table, i - 1, j - 1) - MISMATCH;
    const cur = at(table, i, j);
    if (Math.abs(cur - diag) < 1e-6) {
      if (canMatch) {
        ops.push({ kind: 'match', base: bs, witness: ws, similarity: Number(sim.toFixed(3)) });
      } else {
        ops.push({ kind: 'baseOnly', base: bs });
        ops.push({ kind: 'witnessOnly', witness: ws });
      }
      i -= 1;
      j -= 1;
    } else if (at(table, i - 1, j) - GAP >= at(table, i, j - 1) - GAP) {
      ops.push({ kind: 'baseOnly', base: bs });
      i -= 1;
    } else {
      ops.push({ kind: 'witnessOnly', witness: ws });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ kind: 'baseOnly', base: base[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: 'witnessOnly', witness: witness[j - 1] });
    j -= 1;
  }
  ops.reverse();
  return ops;
}

let groupCounter = 0;
function newGroupId(): string {
  groupCounter += 1;
  return `grp-${Date.now().toString(36)}-${groupCounter}`;
}

export interface AutoAlignInput {
  baseVersion: VersionDocument;
  witnesses: VersionDocument[];
  rules: ComparisonRules;
  /** 已锁定组（人工调整成果），重对齐时原样嵌回 */
  lockedGroups?: AlignGroup[];
  onProgress?: (p: AlignProgress) => void;
}

// ---------------------------------------------------------------------------
// 两级对齐：先对段，再段内对句
// ---------------------------------------------------------------------------

function groupByParagraph(sentences: Sentence[]): Sentence[][] {
  const map = new Map<number, Sentence[]>();
  for (const s of sentences) {
    const list = map.get(s.paragraphOrder) ?? [];
    list.push(s);
    map.set(s.paragraphOrder, list);
  }
  return [...map.keys()].sort((a, b) => a - b).map((k) => map.get(k)!);
}

/** 段级 Needleman-Wunsch，得分用整段规范化文本相似度 */
function alignParagraphs(bParas: Sentence[][], wParas: Sentence[][], rules: ComparisonRules) {
  const m = bParas.length;
  const n = wParas.length;
  const GAP = 0.5;
  const width = n + 1;
  const dp = new Float64Array((m + 1) * width);
  const sims = new Float32Array(m * n);
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const bt = bParas[i].map((s) => s.text).join('');
      const wt = wParas[j].map((s) => s.text).join('');
      sims[i * n + j] = normalizedSimilarity(bt, wt, rules);
    }
  }
  for (let i = 1; i <= m; i += 1) dp[i * width] = dp[(i - 1) * width] - GAP;
  for (let j = 1; j <= n; j += 1) dp[j] = dp[j - 1] - GAP;
  const paraThreshold = Math.max(0.25, rules.matchThreshold - 0.15);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const sim = sims[(i - 1) * n + j - 1];
      const match = sim >= paraThreshold ? 2 * sim : -2;
      dp[i * width + j] = Math.max(
        dp[(i - 1) * width + j - 1] + match,
        dp[(i - 1) * width + j] - GAP,
        dp[i * width + j - 1] - GAP
      );
    }
  }
  // 回溯
  const pairs: { b?: number; w?: number }[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const sim = sims[(i - 1) * n + j - 1];
    const match = sim >= paraThreshold ? 2 * sim : -2;
    const cur = dp[i * width + j];
    if (Math.abs(cur - (dp[(i - 1) * width + j - 1] + match)) < 1e-6) {
      pairs.push({ b: i - 1, w: j - 1 });
      i -= 1;
      j -= 1;
    } else if (dp[(i - 1) * width + j] - GAP >= dp[i * width + j - 1] - GAP) {
      pairs.push({ b: i - 1 });
      i -= 1;
    } else {
      pairs.push({ w: j - 1 });
      j -= 1;
    }
  }
  while (i > 0) {
    pairs.push({ b: i - 1 });
    i -= 1;
  }
  while (j > 0) {
    pairs.push({ w: j - 1 });
    j -= 1;
  }
  pairs.reverse();
  return pairs;
}

/** 段内句级对齐（同步小 DP，单段句子数少）；不允许跨段 */
function alignWithinParagraph(base: Sentence[], witness: Sentence[], rules: ComparisonRules): AlignOp[] {
  const m = base.length;
  const n = witness.length;
  const GAP = 1;
  const MISMATCH = 2;
  const width = n + 1;
  const dp = new Float64Array((m + 1) * width);
  const sims = new Float32Array(m * n).fill(-1);
  const sim = (a: number, b: number) => {
    const key = a * n + b;
    if (sims[key] < 0) sims[key] = normalizedSimilarity(base[a].text, witness[b].text, rules);
    return sims[key];
  };
  for (let i = 1; i <= m; i += 1) dp[i * width] = -GAP * i;
  for (let j = 1; j <= n; j += 1) dp[j] = -GAP * j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const s = sim(i - 1, j - 1);
      const can = s >= pairThreshold(base[i - 1], witness[j - 1], rules);
      const match = can ? 2 * s : -MISMATCH;
      dp[i * width + j] = Math.max(
        dp[(i - 1) * width + j - 1] + match,
        dp[(i - 1) * width + j] - GAP,
        dp[i * width + j - 1] - GAP
      );
    }
  }
  const ops: AlignOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const s = sim(i - 1, j - 1);
    const can = s >= pairThreshold(base[i - 1], witness[j - 1], rules);
    const match = can ? 2 * s : -MISMATCH;
    if (Math.abs(dp[i * width + j] - (dp[(i - 1) * width + j - 1] + match)) < 1e-6) {
      if (can) ops.push({ kind: 'match', base: base[i - 1], witness: witness[j - 1], similarity: Number(s.toFixed(3)) });
      else {
        ops.push({ kind: 'baseOnly', base: base[i - 1] });
        ops.push({ kind: 'witnessOnly', witness: witness[j - 1] });
      }
      i -= 1;
      j -= 1;
    } else if (dp[(i - 1) * width + j] - GAP >= dp[i * width + j - 1] - GAP) {
      ops.push({ kind: 'baseOnly', base: base[i - 1] });
      i -= 1;
    } else {
      ops.push({ kind: 'witnessOnly', witness: witness[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ kind: 'baseOnly', base: base[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: 'witnessOnly', witness: witness[j - 1] });
    j -= 1;
  }
  ops.reverse();
  return ops;
}

/** 两级对齐主入口（同步即可：段级 DP 极小，段内 DP 也小），逐段对之间让出主线程 */
async function twoLevelAlign(base: Sentence[], witness: Sentence[], rules: ComparisonRules): Promise<AlignOp[]> {
  const bParas = groupByParagraph(base);
  const wParas = groupByParagraph(witness);
  const pairs = alignParagraphs(bParas, wParas, rules);
  const ops: AlignOp[] = [];
  let count = 0;
  for (const pair of pairs) {
    if (pair.b !== undefined && pair.w !== undefined) {
      ops.push(...alignWithinParagraph(bParas[pair.b], wParas[pair.w], rules));
    } else if (pair.b !== undefined) {
      bParas[pair.b].forEach((s) => ops.push({ kind: 'baseOnly', base: s }));
    } else if (pair.w !== undefined) {
      wParas[pair.w].forEach((s) => ops.push({ kind: 'witnessOnly', witness: s }));
    }
    count += 1;
    if (count % 8 === 0) await yieldToBrowser();
  }
  return ops;
}

export async function autoAlignGroups(input: AutoAlignInput): Promise<AlignGroup[]> {
  const { baseVersion, witnesses, rules } = input;
  const locked = input.lockedGroups ?? [];
  const baseAll = baseVersion.sentences;

  // 1. 摘除锁定组占用的句子
  const lockedBaseIds = new Set<string>();
  const lockedWitnessIds = new Map<string, Set<string>>();
  for (const g of locked) {
    if (g.baseSentenceId) lockedBaseIds.add(g.baseSentenceId);
    for (const [vid, ids] of Object.entries(g.cells)) {
      const set = lockedWitnessIds.get(vid) ?? new Set<string>();
      ids.forEach((id) => set.add(id));
      lockedWitnessIds.set(vid, set);
    }
  }
  const freeBase = baseAll.filter((s) => !lockedBaseIds.has(s.id));

  const perWitnessOps = new Map<string, AlignOp[]>();
  const chunkRows = Math.max(10, rules.chunkSize || 60);

  for (let wi = 0; wi < witnesses.length; wi += 1) {
    const witness = witnesses[wi];
    const busy = lockedWitnessIds.get(witness.id);
    const freeWitness = witness.sentences.filter((s) => !busy?.has(s.id));
    let ops: AlignOp[];
    if (rules.crossParagraph) {
      const table = await buildDp(freeBase, freeWitness, rules, chunkRows, (inner) => {
        const baseP = wi / witnesses.length;
        const span = 1 / witnesses.length;
        input.onProgress?.({
          phase: `正在对齐《${witness.name}》（${inner}%）`,
          percent: Math.round((baseP + span * (inner / 100)) * 100)
        });
      });
      ops = backtrack(table);
    } else {
      input.onProgress?.({
        phase: `正在两级对齐《${witness.name}》（先对段，再段内对句）`,
        percent: Math.round(((wi + 0.5) / witnesses.length) * 100)
      });
      ops = await twoLevelAlign(freeBase, freeWitness, rules);
    }
    await yieldToBrowser();
    perWitnessOps.set(witness.id, ops);
  }

  // 3. 直接消费有序操作流，计算每个参校「配对/插入」相对底本的插入槽位 slot。
  // slot 表示「插在第 slot 个底本句之前」：0=文首，freeBase.length=文末；
  // 同一槽内 tie 越大越靠后。这样跨版插入组定位天然正确，不再依赖回找。
  interface Placed {
    witnessIds: string[];
    baseId?: string;
    slot: number;
    tie: number;
  }
  const baseIndexById = new Map(baseAll.map((s, idx) => [s.id, idx]));
  const freeBaseIndex = new Map(freeBase.map((s, idx) => [s.id, idx]));
  const matchGroups = new Map<string, AlignGroup>();
  for (const s of freeBase) {
    matchGroups.set(s.id, {
      id: newGroupId(),
      baseSentenceId: s.id,
      cells: {},
      locked: false,
      manual: false
    });
  }
  const insertPlaced: Placed[] = [];

  for (const w of witnesses) {
    const ops = perWitnessOps.get(w.id) ?? [];
    let lastMatchedBaseIndex = -1;
    let tie = 0;
    // 连续 witnessOnly 聚成一撮，挂到同一槽
    let pending: string[] = [];
    let pendingTie = 0;
    const flush = (slot: number) => {
      if (!pending.length) return;
      insertPlaced.push({ witnessIds: [], slot, tie: pendingTie, [`w:${w.id}`]: pending } as Placed);
      pending = [];
    };
    for (const op of ops) {
      if (op.kind === 'match') {
        flush(lastMatchedBaseIndex + 1);
        const g = matchGroups.get(op.base.id);
        if (g) {
          const list = g.cells[w.id] ?? [];
          list.push(op.witness.id);
          g.cells[w.id] = list;
        }
        lastMatchedBaseIndex = freeBaseIndex.get(op.base.id) ?? lastMatchedBaseIndex;
        tie += 1;
      } else if (op.kind === 'witnessOnly') {
        if (!pending.length) pendingTie = ++tie;
        pending.push(op.witness.id);
      } else {
        // baseOnly：底本独有句，其前的插入句落在该句之前
        flush((freeBaseIndex.get(op.base.id) ?? lastMatchedBaseIndex + 1));
        tie += 1;
      }
    }
    flush(lastMatchedBaseIndex + 1 < 0 ? 0 : lastMatchedBaseIndex + 1);
  }

  // 4. 跨参校聚类同一槽（及相邻槽）的插入句，合成插入组
  const groups: AlignGroup[] = [...matchGroups.values()];
  // 简单稳妥：每个 insertPlaced 先各自成插入组，再把「同槽且高相似、不同版」的合并
  const made: { group: AlignGroup; slot: number; tie: number; reps: { vid: string; sid: string }[] }[] = [];
  for (const p of insertPlaced) {
    const g: AlignGroup = { id: newGroupId(), baseSentenceId: null, cells: {}, locked: false, manual: false };
    const reps: { vid: string; sid: string }[] = [];
    for (const key of Object.keys(p).filter((k) => k.startsWith('w:'))) {
      const vid = key.slice(2);
      const ids = (p as unknown as Record<string, string[]>)[key];
      g.cells[vid] = ids;
      ids.forEach((sid) => reps.push({ vid, sid }));
    }
    made.push({ group: g, slot: p.slot, tie: p.tie, reps });
  }

  // 合并：同槽、不同版、代表句高相似
  const mergedInto = new Array(made.length).fill(-1);
  const findRepSentence = (vid: string, sid: string) =>
    witnesses.find((x) => x.id === vid)?.sentences.find((s) => s.id === sid);
  for (let a = 0; a < made.length; a += 1) {
    if (mergedInto[a] >= 0) continue;
    for (let b = a + 1; b < made.length; b += 1) {
      if (mergedInto[b] >= 0) continue;
      if (made[a].slot !== made[b].slot) continue;
      let hit = false;
      for (const ra of made[a].reps) {
        const sa = findRepSentence(ra.vid, ra.sid);
        if (!sa) continue;
        for (const rb of made[b].reps) {
          if (rb.vid === ra.vid) continue;
          const sb = findRepSentence(rb.vid, rb.sid);
          if (!sb) continue;
          if (normalizedSimilarity(sa.text, sb.text, rules) >= rules.matchThreshold) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) {
        for (const [vid, ids] of Object.entries(made[b].group.cells)) {
          made[a].group.cells[vid] = [...(made[a].group.cells[vid] ?? []), ...ids];
        }
        made[a].reps.push(...made[b].reps);
        mergedInto[b] = a;
      }
    }
  }
  const insertGroupsFinal = made.filter((_, idx) => mergedInto[idx] < 0).map((m) => ({ ...m }));

  // 5. 按 (slot, tie) 把插入组插进底本组序列
  const finalGroups: AlignGroup[] = [];
  const bySlot = new Map<number, typeof insertGroupsFinal>();
  for (const ig of insertGroupsFinal) {
    const list = bySlot.get(ig.slot) ?? [];
    list.push(ig);
    bySlot.set(ig.slot, list);
  }
  freeBase.forEach((s, idx) => {
    const before = bySlot.get(idx);
    if (before) {
      before.sort((a, b) => a.tie - b.tie);
      before.forEach((x) => finalGroups.push(x.group));
    }
    finalGroups.push(matchGroups.get(s.id)!);
  });
  const tail = bySlot.get(freeBase.length);
  if (tail) {
    tail.sort((a, b) => a.tie - b.tie);
    tail.forEach((x) => finalGroups.push(x.group));
  }

  // 6. 嵌回锁定组：锁定底本组按底本全局位置插回；锁定插入组置于末尾
  for (const lg of locked) {
    if (lg.baseSentenceId) {
      const globalIdx = baseIndexById.get(lg.baseSentenceId);
      let insertAt = finalGroups.length;
      if (globalIdx !== undefined) {
        const idx = finalGroups.findIndex((g) => {
          const gi = g.baseSentenceId ? baseIndexById.get(g.baseSentenceId) : undefined;
          return gi !== undefined && gi > globalIdx;
        });
        if (idx >= 0) insertAt = idx;
      }
      finalGroups.splice(insertAt, 0, lg);
    } else {
      finalGroups.push(lg);
    }
  }

  input.onProgress?.({ phase: '对齐完成', percent: 100 });
  return finalGroups;
}
