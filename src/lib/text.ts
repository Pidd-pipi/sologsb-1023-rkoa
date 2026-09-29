import type { ComparisonRules, Sentence, VersionDocument } from '../types';

/** 常见繁简/异体字归一表（仅用于比较，不改原文） */
export const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国',
  謂: '谓',
  萬: '万',
  無: '无',
  於: '于',
  後: '后',
  爭: '争',
  棄: '弃',
  聖: '圣',
  智: '智',
  義: '义',
  禮: '礼',
  屬: '属',
  幾: '几',
  處: '处',
  渟: '停',
  兮: '兮'
};

/**
 * 按空行或单换行分段（兼容空行分段与逐行分段两种底本格式），
 * 再按句末标点切句。保留原文，只记录切分结果。
 */
export function segmentText(text: string, versionId: string): Sentence[] {
  const rawParagraphs = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // 连续非空行各自成段（样例按行分段；空行分段也天然成立）
  const paragraphs = rawParagraphs;

  const sentences: Sentence[] = [];
  let globalOrder = 0;

  paragraphs.forEach((paragraph, pIndex) => {
    const paragraphOrder = pIndex + 1;
    const paragraphId = `${versionId}-p-${paragraphOrder}`;
    const pieces = paragraph
      .split(/(?<=[。！？!?；;])/)
      .map((item) => item.trim())
      .filter(Boolean);
    const list = pieces.length ? pieces : [paragraph];
    list.forEach((piece, sIndex) => {
      globalOrder += 1;
      sentences.push({
        id: `${versionId}-p${paragraphOrder}-s${sIndex + 1}-g${globalOrder}`,
        paragraphId,
        paragraphOrder,
        sentenceInParagraph: sIndex + 1,
        globalOrder,
        text: piece
      });
    });
  });
  return sentences;
}

export function makeVersion(
  id: string,
  name: string,
  source: string,
  text: string,
  createdAt = new Date().toISOString()
): VersionDocument {
  return { id, name, source, createdAt, text, sentences: segmentText(text, id) };
}

/** 比较用规范化：小写、可选异体字归一、可选去标点空白 */
export function normalize(value: string, rules: ComparisonRules): string {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (ch) => variantMap[ch] ?? ch).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(
      /[\s，。！？；：、“”‘’「」『』（）()【】《》〈〉·,.!?;:'"[\]{}<>—\-…﹑﹒﹔﹖﹗]/g,
      ''
    );
  }
  return result;
}

function chars(value: string): string[] {
  return Array.from(value);
}

/** 最长公共子序列长度（字符级） */
export function lcsLength(a: string, b: string): number {
  const ca = chars(a);
  const cb = chars(b);
  if (!ca.length || !cb.length) return 0;
  const prev = new Array<number>(cb.length + 1).fill(0);
  for (let i = 1; i <= ca.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= cb.length; j += 1) {
      const old = prev[j];
      prev[j] = ca[i - 1] === cb[j - 1] ? diagonal + 1 : Math.max(prev[j], prev[j - 1]);
      diagonal = old;
    }
  }
  return prev[cb.length];
}

/** 相似度 = 2·LCS / (|a|+|b|)，对一长一短更公允 */
export function similarity(a: string, b: string): number {
  const ca = chars(a);
  const cb = chars(b);
  if (!ca.length && !cb.length) return 1;
  if (!ca.length || !cb.length) return 0;
  const common = lcsLength(a, b);
  return (2 * common) / (ca.length + cb.length);
}

export function normalizedSimilarity(a: string, b: string, rules: ComparisonRules): number {
  return similarity(normalize(a, rules), normalize(b, rules));
}

export type DiffOp = 'equal' | 'insert' | 'delete';
export interface DiffToken {
  op: DiffOp;
  text: string;
}

/** 字符级 LCS diff：a 为底本字符串，b 为参校字符串；标点/异体可按规则视为相同 */
export function charDiff(a: string, b: string, rules: ComparisonRules): DiffToken[] {
  const ca = chars(a);
  const cb = chars(b);
  const m = ca.length;
  const n = cb.length;
  const punct = /[\s，。！？；：、“”‘’「」『』（）()【】《》〈〉·,.!?;:'"[\]{}<>—\-…]/;
  const normChar = (ch: string) => (rules.ignoreVariants ? variantMap[ch] ?? ch : ch);
  const equalChar = (x: string, y: string) => {
    if (x === y) return true;
    if (rules.ignorePunctuation && punct.test(x) && punct.test(y)) return true;
    return rules.ignoreVariants && normChar(x) === normChar(y);
  };
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = equalChar(ca[i - 1], cb[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const raw: DiffToken[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (equalChar(ca[i - 1], cb[j - 1])) {
      raw.push({ op: 'equal', text: ca[i - 1] });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      raw.push({ op: 'delete', text: ca[i - 1] });
      i -= 1;
    } else {
      raw.push({ op: 'insert', text: cb[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    raw.push({ op: 'delete', text: ca[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    raw.push({ op: 'insert', text: cb[j - 1] });
    j -= 1;
  }
  raw.reverse();
  const merged: DiffToken[] = [];
  for (const token of raw) {
    const last = merged[merged.length - 1];
    if (last && last.op === token.op) last.text += token.text;
    else merged.push({ ...token });
  }
  return merged;
}

/** 简易稳定哈希（djb2），用于校记/裁定签名 */
export function hashText(value: string): string {
  let hash = 5381;
  const str = normalize(value, {
    ignorePunctuation: true,
    ignoreVariants: true,
    matchThreshold: 0,
    crossParagraph: false,
    chunkSize: 0
  });
  for (const ch of chars(str)) {
    hash = ((hash << 5) + hash + ch.codePointAt(0)!) >>> 0;
  }
  return hash.toString(36);
}
