export interface StyleVariant { styleId: string; styleName: string; text: string }
export interface StyleMetrics { chars: number; sentences: number; paragraphs: number; averageSentence: number; dialogueRatio: number }
export interface StyleComparisonRow extends StyleMetrics { styleId: string; styleName: string; overlapWithOthers: number }
export interface StyleComparison { rows: StyleComparisonRow[]; mostDistinct: string | null; mostSimilar: [string, string] | null }
const sentenceSplit = /[。！？!?…]+/u;
const dialoguePattern = /[“"「][^”"」]*[”"」]/gu;
/** Plain, deterministic measurements — no model call, so the numbers cannot be "hallucinated". */
export function measureStyle(text: string): StyleMetrics {
  const chars = [...text.replace(/\s/gu, '')].length;
  const paragraphs = text.split(/\n+/u).map(line => line.trim()).filter(Boolean).length;
  const sentences = text.split(sentenceSplit).map(part => part.trim()).filter(Boolean);
  const dialogue = [...text.matchAll(dialoguePattern)].reduce((sum, match) => sum + [...match[0]].length, 0);
  return {
    chars, sentences: sentences.length, paragraphs,
    averageSentence: sentences.length ? Math.round((chars / sentences.length) * 10) / 10 : 0,
    dialogueRatio: chars ? Math.round((dialogue / chars) * 1000) / 1000 : 0
  };
}
function shingles(text: string): Set<string> {
  const clean = text.replace(/\s/gu, '');
  const grams = new Set<string>();
  for (let index = 0; index + 1 < clean.length; index++) grams.add(clean.slice(index, index + 2));
  return grams;
}
/** Jaccard similarity of character bigrams: 0 = nothing in common, 1 = identical wording. */
export function textOverlap(left: string, right: string): number {
  const a = shingles(left), b = shingles(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return Math.round((shared / (a.size + b.size - shared)) * 1000) / 1000;
}
/** Compares same-brief drafts written in different styles. Reports the most distinct draft and the
 * closest pair so an author can see whether the styles actually differ. */
export function compareStyleVariants(variants: StyleVariant[]): StyleComparison {
  const rows: StyleComparisonRow[] = variants.map(variant => {
    const others = variants.filter(other => other.styleId !== variant.styleId);
    const average = others.length ? others.reduce((sum, other) => sum + textOverlap(variant.text, other.text), 0) / others.length : 0;
    return { styleId: variant.styleId, styleName: variant.styleName, ...measureStyle(variant.text), overlapWithOthers: Math.round(average * 1000) / 1000 };
  });
  const mostDistinct = rows.length > 1 ? [...rows].sort((left, right) => left.overlapWithOthers - right.overlapWithOthers || left.styleId.localeCompare(right.styleId))[0].styleId : null;
  let mostSimilar: [string, string] | null = null;
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const overlap = textOverlap(variants[i].text, variants[j].text);
      if (!mostSimilar || overlap > textOverlap(variants.find(item => item.styleId === mostSimilar![0])!.text, variants.find(item => item.styleId === mostSimilar![1])!.text)) {
        mostSimilar = [variants[i].styleId, variants[j].styleId];
      }
    }
  }
  return { rows, mostDistinct, mostSimilar };
}
