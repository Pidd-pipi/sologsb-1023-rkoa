import type { Annotation, OrphanAnnotation, Sentence, VersionDocument } from '../types';
import { normalizedSimilarity } from './text';
import type { ComparisonRules } from '../types';

/**
 * 校记跟着原句走：句子重新切分或版本被替换后，
 * 用句间相似度把旧句上的校记迁移到新句。
 * 找不到足够相似的新句时，校记进入失主池(orphans)，由人工指认，绝不丢弃。
 */

const MIGRATE_THRESHOLD = 0.72;

interface MigrationResult {
  annotations: Record<string, Annotation>;
  orphans: OrphanAnnotation[];
  migrated: number;
  orphaned: number;
}

function annId(): string {
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 在「同一版本内容被重新切分」的场景下迁移。
 * @param oldSentences 旧切分
 * @param newSentences 新切分
 */
export function migrateAnnotationsForResegment(
  annotations: Record<string, Annotation>,
  orphans: OrphanAnnotation[],
  oldSentences: Sentence[],
  newSentences: Sentence[],
  rules: ComparisonRules,
  versionId: string
): MigrationResult {
  const oldById = new Map(oldSentences.map((s) => [s.id, s]));
  const next: Record<string, Annotation> = {};
  const nextOrphans: OrphanAnnotation[] = [...orphans];
  let migrated = 0;
  let orphaned = 0;

  for (const ann of Object.values(annotations)) {
    if (ann.versionId !== versionId || ann.sentenceId === null) {
      next[ann.id] = { ...ann };
      continue;
    }
    const oldSentence = oldById.get(ann.sentenceId);
    if (!oldSentence) {
      // 旧句已不存在（极端情况）
      nextOrphans.push(toOrphan(ann, ''));
      orphaned += 1;
      continue;
    }
    // 新切分中若存在同 id 且正文仍足够相似（切分规则未实质影响该句），直接保留
    const sameId = newSentences.find((s) => s.id === ann.sentenceId);
    if (sameId && normalizedSimilarity(oldSentence.text, sameId.text, rules) >= MIGRATE_THRESHOLD) {
      next[ann.id] = { ...ann };
      migrated += 1;
      continue;
    }
    // 贪心 + 全局不重复占用：按相似度排序的最佳新句
    const scored = newSentences
      .map((s) => ({ s, sim: normalizedSimilarity(oldSentence.text, s.text, rules) }))
      .filter((x) => x.sim >= MIGRATE_THRESHOLD)
      .sort((a, b) => b.sim - a.sim);
    const used = new Set(Object.values(next).map((x) => x.sentenceId));
    const target = scored.find((x) => !used.has(x.s.id));
    if (target) {
      next[ann.id] = { ...ann, sentenceId: target.s.id, updatedAt: new Date().toISOString() };
      migrated += 1;
    } else {
      nextOrphans.push(toOrphan(ann, oldSentence.text));
      orphaned += 1;
    }
  }
  return { annotations: next, orphans: nextOrphans, migrated, orphaned };
}

/** 整个版本文本被替换（导入新版本覆盖同槽位）时，跨版本整体迁移 */
export function migrateAnnotationsForVersionReplace(
  annotations: Record<string, Annotation>,
  orphans: OrphanAnnotation[],
  oldVersion: VersionDocument,
  newVersion: VersionDocument,
  rules: ComparisonRules
): MigrationResult {
  const other: Record<string, Annotation> = {};
  const mine: Record<string, Annotation> = {};
  for (const ann of Object.values(annotations)) {
    if (ann.versionId === oldVersion.id) mine[ann.id] = ann;
    else other[ann.id] = ann;
  }
  const result = migrateAnnotationsForResegment(
    mine,
    orphans,
    oldVersion.sentences,
    newVersion.sentences,
    rules,
    oldVersion.id
  );
  // 迁移后的归属版本改为新版本 id
  for (const ann of Object.values(result.annotations)) {
    other[ann.id] = { ...ann, versionId: newVersion.id };
  }
  const fixedOrphans = result.orphans.map((o) => ({
    ...o,
    versionId: newVersion.id,
    originalVersionId: newVersion.id
  }));
  return {
    annotations: other,
    orphans: fixedOrphans,
    migrated: result.migrated,
    orphaned: result.orphaned
  };
}

function toOrphan(ann: Annotation, originalText: string): OrphanAnnotation {
  return {
    ...ann,
    sentenceId: null,
    originalText,
    originalVersionId: ann.versionId
  };
}

export function createAnnotation(versionId: string, sentenceId: string, note: string, source: string): Annotation {
  return {
    id: annId(),
    versionId,
    sentenceId,
    note,
    source,
    updatedAt: new Date().toISOString()
  };
}
