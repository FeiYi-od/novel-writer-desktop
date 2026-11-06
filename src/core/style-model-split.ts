/** Split model input losslessly, keeping CRLF and Unicode surrogate pairs intact. */
export function splitModelStyleText(text: string, chunkCharacters: number): string[] {
  const size = Math.max(1000, Math.min(20000, Math.floor(chunkCharacters)));
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + size);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end - 1);
      if (boundary >= cursor + size / 2) end = boundary + 1;
      const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
      if (text[end - 1] === '\r' && text[end] === '\n') end--;
    }
    parts.push(text.slice(cursor, end)); cursor = end;
  }
  return parts;
}
