/** 从文字设定提取候选：支持"角色：姓名 / 地点：名称"开头的块，块内用"字段：内容"。
 * 纯本地解析，不调用模型；输出候选仅供作者核对，未确认前不写入人物卡或世界书。 */
export type SettingCandidateKind = 'character' | 'world';

export interface SettingCandidate {
  id: string;
  kind: SettingCandidateKind;
  name: string;
  fields: Record<string, string>;
  source: string;
  /** 该类型下未在设定里出现的字段，界面据此标注「未提供」，不自动补成事实。 */
  missing: string[];
  /** 多块整理时同一字段出现不同值：保留全部值供作者选择，不自动裁决。 */
  conflicts?: { field: string; values: string[] }[];
}

const KNOWN_FIELDS = ['别名', '外貌', '性格', '经历', '目标', '关系', '说话方式', '类型', '正文', '关键词', '备注'];

export function extractSettingCandidates(text: string): SettingCandidate[] {
  const normalized = text.replace(/\r\n?/gu, '\n');
  const blocks = normalized.split(/\n{2,}/u).map(block => block.trim()).filter(Boolean);
  const candidates: SettingCandidate[] = [];
  let index = 0;
  for (const block of blocks) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    const head = lines[0] ?? '';
    const headMatch = /^(角色|人物|地点|势力|规则|世界|世界书)\s*[:：]\s*(.+)$/u.exec(head);
    if (!headMatch) continue;
    const label = headMatch[1]!;
    const name = headMatch[2]!.trim();
    if (!name) continue;
    const kind: SettingCandidateKind = ['角色', '人物'].includes(label) ? 'character' : 'world';
    const fields: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const match = /^([^:：]{1,12})\s*[:：]\s*(.+)$/u.exec(line);
      if (!match) continue;
      const key = match[1]!.trim();
      if (!KNOWN_FIELDS.includes(key)) continue;
      fields[key] = match[2]!.trim();
    }
    const expected = kind === 'character' ? ['别名', '外貌', '性格', '经历', '目标', '关系', '说话方式'] : ['正文', '关键词'];
    const missing = expected.filter(field => !fields[field]);
    candidates.push({ id: `candidate-${++index}`, kind, name, fields, source: block.slice(0, 400), missing });
  }
  return candidates;
}

/** 候选确认后的落库参数：映射到 CharacterFields（与酒馆卡字段一致）。 */
export function characterFieldsFrom(candidate: SettingCandidate) {
  const fields = candidate.fields;
  return {
    name: candidate.name,
    description: [fields['外貌'], fields['经历']].filter(Boolean).join('\n'),
    personality: fields['性格'] ?? '',
    scenario: '',
    firstMessage: '',
    examples: fields['说话方式'] ?? '',
    creatorNotes: [fields['别名'] ? '别名：' + fields['别名'] : '', fields['目标'] ? '目标：' + fields['目标'] : '', fields['备注'] ? '备注：' + fields['备注'] : ''].filter(Boolean).join('\n'),
    systemPrompt: '',
    postHistoryInstructions: fields['关系'] ?? '',
    alternateGreetings: [] as string[]
  };
}

export function worldEntryFrom(candidate: SettingCandidate) {
  const fields = candidate.fields;
  const keys = (fields['关键词'] ?? candidate.name).split(/[,，、\s]+/u).filter(Boolean);
  return {
    key: keys,
    keysecondary: [],
    comment: candidate.name,
    content: [fields['类型'] ? `类型：${fields['类型']}` : '', fields['正文'], fields['备注']].filter(Boolean).join('\n') || candidate.source,
    constant: false,
    selective: true,
    enabled: true,
    insertion_order: 100,
    position: 0
  };
}
