import type { CharacterSnapshot, CharacterTagMappingSnapshot } from '../shared/contracts';
import type { WorldCharacterContext } from './st-cards';

/** Confirmed bindings are per card, never combined across characters or projects. */
export function worldCharacterContexts(projectId: string, cards: CharacterSnapshot, mapping?: CharacterTagMappingSnapshot): WorldCharacterContext[] {
  if (cards.value.projectId !== projectId || cards.value.cards.some(card => card.projectId !== projectId)) throw new Error('角色卡不属于当前小说');
  if (mapping && (mapping.projectId !== projectId || mapping.currentCharacterHash !== cards.hash)) throw new Error('角色卡或酒馆关联已变化，请重新核对');
  const usable = mapping && !mapping.stale ? new Map(mapping.mappings.map(item => [item.characterId, item])) : new Map();
  return cards.value.cards.filter(card => card.enabled).map(card => {
    const selected = usable.get(card.id);
    return { avatarKey: selected?.avatarKey ?? card.name, tagIds: selected?.tagIds ?? undefined };
  });
}
