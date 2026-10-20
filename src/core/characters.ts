import type { CharacterCard, CharacterFields } from '../shared/contracts';

export const emptyCharacter = (): CharacterFields => ({ name: '', description: '', personality: '', scenario: '', firstMessage: '', examples: '', creatorNotes: '', systemPrompt: '', postHistoryInstructions: '', alternateGreetings: [] });

/** 仅明确启用的角色定义参与小说上下文；示例、开场白、作者说明不是正史。 */
export function characterContext(projectId: string, cards: CharacterCard[]) {
  if (cards.some(card => card.projectId !== projectId)) throw new Error('角色卡包含其他小说的数据');
  return cards.filter(card => card.enabled).map(card => ({ projectId, id: card.id, text: [
    `角色：${card.name}`, card.description && `设定：${card.description}`,
    card.personality && `性格：${card.personality}`, card.scenario && `背景：${card.scenario}`
  ].filter(Boolean).join('\n') }));
}
