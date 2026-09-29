import type { ComparisonRules, TextUnit } from '../types';

/** 常见繁简字 / 异体字对照（演示用内置表，命中则归一为同一字） */
const VARIANT_PAIRS: Array<[string, string]> = [
  ['為', '为'], ['爲', '为'], ['識', '识'], ['強', '强'], ['彊', '强'],
  ['與', '与'], ['猶', '犹'], ['鄰', '邻'], ['隣', '邻'], ['儼', '俨'],
  ['渙', '涣'], ['將', '将'], ['樸', '朴'], ['樸', '朴'], ['曠', '旷'],
  ['濁', '浊'], ['渾', '浑'], ['靜', '静'], ['動', '动'], ['玅', '妙'],
  ['古', '古'], ['善', '善'], ['道', '道'], ['微', '微'], ['妙', '妙'],
  ['玄', '玄'], ['通', '通'], ['深', '深'], ['不', '不'], ['可', '可'],
  ['夫', '夫'], ['唯', '唯'], ['故', '故'], ['之', '之'], ['容', '容'],
  ['豫', '豫'], ['兮', '兮'], ['若', '若'], ['冬', '冬'], ['涉', '涉'],
  ['川', '川'], ['畏', '畏'], ['四', '四'], ['其', '其'], ['客', '客'],
  ['冰', '冰'], ['釋', '释'], ['敦', '敦'], ['谷', '谷'], ['混', '混'],
  ['孰', '孰'], ['能', '能'], ['以', '以'], ['徐', '徐'], ['清', '清'],
  ['安', '安'], ['生', '生'], ['保', '保'], ['此', '此'], ['者', '者'],
  ['欲', '欲'], ['盈', '盈'], ['澹', '澹'], ['海', '海'], ['飂', '飂'],
  ['無', '无'], ['止', '止'], ['久', '久'], ['蔽', '蔽'], ['新', '新'],
  ['成', '成'], ['士', '士'], ['焉', '焉']
];

const variantMap: Record<string, string> = {};
VARIANT_PAIRS.forEach(([a, b]) => {
  variantMap[a] = b;
  variantMap[b] = b;
});

const PUNCTUATION = /[，。！？；：、""''「」『』（）《》〈〉…—·,\.!?;:"'()\[\]\s]/g;

/** 按比较规则归一文本：忽略标点、异体字 */
export function normalizeText(text: string, rules?: ComparisonRules): string {
  let result = text;
  if (rules?.ignorePunctuation) {
    result = result.replace(PUNCTUATION, '');
  }
  if (rules?.ignoreVariants) {
    result = [...result].map((ch) => variantMap[ch] ?? ch).join('');
  }
  return result;
}

/** FNV-1a 32 位文本哈希，用作原句内容锚 */
export function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) {
    grams.add(text.slice(i, i + 2));
  }
  if (text.length === 1) grams.add(text);
  return grams;
}

/**
 * 相似度：归一文本的二元组 Jaccard，乘以长度比折扣，避免短句误配长句。
 */
export function similarity(a: string, b: string, rules?: ComparisonRules): number {
  const na = normalizeText(a, rules);
  const nb = normalizeText(b, rules);
  if (!na.length || !nb.length) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let inter = 0;
  ga.forEach((g) => {
    if (gb.has(g)) inter += 1;
  });
  const union = ga.size + gb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  const lengthDiscount = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  return jaccard * (0.65 + 0.35 * lengthDiscount);
}

export interface DiffToken {
  text: string;
  type: 'equal' | 'insert' | 'delete';
}

/**
 * 字符级 LCS 差异，用于把改动单元逐字标红（insert 他版有、delete 底本有）。
 * 过长的句子截断，避免长文本比较卡顿。
 */
export function diffChars(base: string, other: string, rules?: ComparisonRules): DiffToken[] {
  // 按归一后逐字比较，但展示原字
  const a = [...base];
  const b = [...other];
  const CAP = 400;
  const aUsed = a.length > CAP ? a.slice(0, CAP) : a;
  const bUsed = b.length > CAP ? b.slice(0, CAP) : b;
  const an = [...normalizeText(aUsed.join(''), rules)];
  const bn = [...normalizeText(bUsed.join(''), rules)];

  const m = an.length;
  const n = bn.length;
  const lcs: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      lcs[i][j] = an[i - 1] === bn[j - 1] ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  // 回溯：other 相对 base 的增删
  const tokens: DiffToken[] = [];
  let i = m;
  let j = n;
  const rev: DiffToken[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && an[i - 1] === bn[j - 1]) {
      rev.push({ text: bUsed[j - 1], type: 'equal' });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      rev.push({ text: bUsed[j - 1], type: 'insert' });
      j -= 1;
    } else {
      rev.push({ text: aUsed[i - 1], type: 'delete' });
      i -= 1;
    }
  }
  rev.reverse();

  // 合并相邻同类型
  rev.forEach((tok) => {
    const last = tokens[tokens.length - 1];
    if (last && last.type === tok.type) last.text += tok.text;
    else tokens.push({ ...tok });
  });

  if (a.length > CAP || b.length > CAP) {
    tokens.push({ text: '…（句长已截断显示）', type: 'equal' });
  }
  return tokens;
}

let idCounter = 0;
/** 生成带前缀的唯一 id */
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * 文本切分为句单元：
 * 空行或单个换行分段（兼容不同排版）；段内按句末标点切句，无标点则整段为单句。
 */
export function splitIntoUnits(text: string, versionId: string): TextUnit[] {
  const paragraphs = text
    .split(/\n\s*\n|\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  const units: TextUnit[] = [];
  let globalOrder = 0;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphOrder = paragraphIndex + 1;
    const parts = paragraph
      .split(/(?<=[。！？!?；;])/)
      .map((item) => item.trim())
      .filter(Boolean);
    const sentences = parts.length ? parts : [paragraph];
    sentences.forEach((sentence) => {
      globalOrder += 1;
      units.push({
        id: `${versionId}-p${paragraphOrder}-s${globalOrder}`,
        versionId,
        paragraphOrder,
        sentenceOrder: units.filter((u) => u.paragraphOrder === paragraphOrder).length + 1,
        paragraphText: paragraph,
        text: sentence
      });
    });
  });
  return units;
}
