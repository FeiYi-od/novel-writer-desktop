/** Compute the same simple surface statistics without materializing every sentence or quote. */
export function measureStyleText(text: string) {
  const compact = text.replace(/\s/g, '');
  if (!compact.length) return null;
  let paragraphs = 0;
  for (const line of text.matchAll(/[^\n]+/gu)) if (line[0].trim()) paragraphs++;
  let sentences = 0, inSentence = false, firstPerson = 0;
  for (let index = 0; index < compact.length; index++) {
    const code = compact.charCodeAt(index);
    const boundary = code === 0x3002 || code === 0xff01 || code === 0xff1f || code === 0x21 || code === 0x3f;
    if (boundary) inSentence = false;
    else if (!inSentence) { sentences++; inSentence = true; }
    if (code === 0x6211) firstPerson++;
  }
  // Once a closing mark cannot be found, later openings of that type cannot match either.
  // This avoids quadratic backtracking on very long texts with unmatched opening marks.
  const pairs: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"' };
  const unavailable = new Set<string>();
  let quoteCharacters = 0;
  for (let index = 0; index < compact.length; index++) {
    const open = compact[index]!; const close = pairs[open];
    if (!close || unavailable.has(open)) continue;
    const end = compact.indexOf(close, index + 1);
    if (end < 0) { unavailable.add(open); continue; }
    quoteCharacters += end - index + 1; index = end;
  }
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    characters: compact.length, paragraphs,
    meanSentenceLength: round(compact.length / Math.max(sentences, 1)),
    meanParagraphLength: round(compact.length / Math.max(paragraphs, 1)),
    dialogueRatio: round(quoteCharacters / compact.length * 100),
    firstPersonPerThousand: round(firstPerson / compact.length * 1000)
  };
}
