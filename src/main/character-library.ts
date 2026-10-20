import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CharacterCard } from '../shared/contracts';
import type { CharacterStore } from './characters';
import { exportCardPng, placeholderPng } from './character-export';
import { readCardJson } from '../core/png-text';
import { parseCard } from '../core/st-cards';

const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-');
/** Card operations that never lose the author's original: every change first copies the previous
 * state into 角色卡备份/, and export writes a SillyTavern-ready PNG inside the book materials. */
export class CharacterLibrary {
  constructor(private readonly store: CharacterStore) {}
  async exportPng(projectId: string, cardId: string) {
    const snapshot = await this.store.read(projectId);
    const card = snapshot.value.cards.find(item => item.id === cardId);
    if (!card) throw new Error('角色不存在于当前小说');
    const portraits = snapshot.portraits[card.portrait];
    const base = portraits ? Uint8Array.from(Buffer.from(portraits.split(',')[1] ?? '', 'base64')) : placeholderPng();
    const png = exportCardPng(card, base);
    const safeName = card.name.replace(/[\\/:*?"<>|]/gu, '_').slice(0, 40) || '角色';
    const relative = await this.store.writeMaterial(projectId, path.join('导出', '角色卡'), `${safeName}-${stamp()}.png`, Buffer.from(png));
    const parsed = parseCard(readCardJson(png));
    return { relative, bytes: png.length, specVersion: parsed.specVersion, name: parsed.data.name };
  }
  private async backup(projectId: string, snapshot: { value: { cards: CharacterCard[] } }) {
    const existing = snapshot.value.cards;
    const payload = JSON.stringify({ schemaVersion: 1, projectId, cards: existing }, null, 2);
    return this.store.writeMaterial(projectId, '角色卡备份', `人物卡-${stamp()}.json`, Buffer.from(payload, 'utf8')).catch(() => '');
  }
  async remove(projectId: string, cardId: string, expectedHash: string) {
    const snapshot = await this.store.read(projectId);
    if (snapshot.hash !== expectedHash) throw new Error('角色库已在外部更新，请重新载入后再删除');
    const card = snapshot.value.cards.find(item => item.id === cardId);
    if (!card) throw new Error('角色不存在于当前小说');
    const backup = await this.backup(projectId, snapshot);
    const next = await this.store.replaceAll(projectId, snapshot.value.cards.filter(item => item.id !== cardId), expectedHash);
    return { snapshot: next, backup, removed: card.name };
  }
  /** Keeps one card and folds the other into it: empty fields are filled, greetings are unioned. */
  async merge(projectId: string, keepId: string, dropId: string, expectedHash: string) {
    if (keepId === dropId) throw new Error('不能把角色合并到自己');
    const snapshot = await this.store.read(projectId);
    if (snapshot.hash !== expectedHash) throw new Error('角色库已在外部更新，请重新载入后再合并');
    const keep = snapshot.value.cards.find(item => item.id === keepId);
    const drop = snapshot.value.cards.find(item => item.id === dropId);
    if (!keep || !drop) throw new Error('要合并的角色不在当前小说');
    const backup = await this.backup(projectId, snapshot);
    const fill = (left: string, right: string) => left.trim() ? left : right;
    const merged: CharacterCard = {
      ...keep,
      description: fill(keep.description, drop.description), personality: fill(keep.personality, drop.personality),
      scenario: fill(keep.scenario, drop.scenario), firstMessage: fill(keep.firstMessage, drop.firstMessage),
      examples: fill(keep.examples, drop.examples), creatorNotes: fill(keep.creatorNotes, drop.creatorNotes),
      systemPrompt: fill(keep.systemPrompt, drop.systemPrompt), postHistoryInstructions: fill(keep.postHistoryInstructions, drop.postHistoryInstructions),
      alternateGreetings: [...new Set([...keep.alternateGreetings, ...drop.alternateGreetings])],
      portrait: keep.portrait || drop.portrait,
      warnings: [...new Set([...keep.warnings, ...drop.warnings])]
    };
    const next = await this.store.replaceAll(projectId, snapshot.value.cards.map(item => item.id === keepId ? merged : item).filter(item => item.id !== dropId), expectedHash);
    return { snapshot: next, backup, mergedInto: keep.name, dropped: drop.name };
  }
  async previewImport(projectId: string, bytes: Uint8Array) {
    const card = parseCard(readCardJson(bytes));
    return { fields: card.data, specVersion: card.specVersion, token: randomUUID(), projectId };
  }
}
