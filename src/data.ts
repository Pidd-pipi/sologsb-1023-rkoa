import type { TextUnit, VersionDocument } from './types';
import { splitIntoUnits, uid } from './lib/text';

export const sampleTextA = `古之善為道者，微妙玄通，深不可識。夫唯不可識，故強為之容。
豫兮若冬涉川，猶兮若畏四鄰。儼兮其若客，渙兮若冰之將釋。
敦兮其若樸，曠兮其若谷，渾兮其若濁。
孰能濁以靜之徐清？孰能安以動之徐生？保此道者不欲盈。`;

export const sampleTextB = `古之善為士者，微妙玄通，深不可識。夫唯不可識，故強為之容。
與兮若冬涉川，猶兮若畏四鄰。儼兮其若客，渙兮若冰之將釋。
敦兮其若樸，曠兮其若谷，渾兮其若濁。澹兮其若海，飂兮若無止。
孰能濁以止，靜之徐清？孰能安以久，動之徐生？保此道者不欲盈，夫唯不盈，故能蔽不新成。`;

export const sampleTextC = `古代善於行道的人，精微玄妙而通達，深邃得難以認識。正因為難以認識，只能勉強形容他。
小心啊，像冬天涉水過河；警覺啊，像提防四周的鄰國。恭敬啊，像作客；渙散啊，像冰雪消融。
敦厚啊，像未經雕琢的素材；空曠啊，像山谷；渾厚啊，像濁水。
誰能使濁水安靜下來，慢慢澄清？誰能在安定中變動，慢慢生長？持守此道的人不求盈滿。`;

export const sampleTextD = `古之善為道者，微妙玄通，深不可識。夫唯不可識，故彊為之容。
豫焉若冬涉川，猶兮若畏四隣。儼兮其若容，渙兮若冰之將釋。
敦兮其若樸，曠兮其若谷，混兮其若濁。
孰能安以久動之徐生？保此道者不欲盈。`;

export function createSampleDocuments(): VersionDocument[] {
  return [
    buildDocument('王弼注本（底本）', '传世刻本', sampleTextA),
    buildDocument('帛书参校本', '出土文献整理稿', sampleTextB),
    buildDocument('河上公本', '道藏本', sampleTextD),
    buildDocument('现代语译本', '编辑部参考译文', sampleTextC)
  ];
}

export function buildDocument(name: string, source: string, text: string, id?: string): VersionDocument {
  const versionId = id ?? uid('ver');
  return {
    id: versionId,
    name,
    source,
    text,
    units: splitIntoUnits(text, versionId),
    createdAt: new Date().toISOString()
  };
}
