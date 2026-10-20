import JSZip from 'jszip';
import { parseCard, type StCard } from './st-cards';

export interface CharxAsset { type: string; name: string; path: string; ext: string }
export interface CharxResult { card: StCard; icon: Uint8Array | null; assets: CharxAsset[]; cardJson: unknown }
const EMBEDDED_PREFIXES = ['embeded://', 'embedded://', '__asset:'];
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'bmp', 'jfif']);
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
/** CHARX is a ZIP that may carry a self-extracting prefix; find the real archive start. */
export function charxZipStart(bytes: Uint8Array): number {
  for (let index = 0; index + 4 <= bytes.length; index++) {
    if (ZIP_SIGNATURE.every((value, offset) => bytes[index + offset] === value)) return index;
  }
  return -1;
}
export function isCharx(bytes: Uint8Array): boolean { return charxZipStart(bytes) >= 0; }
const normalizePath = (value: string) => value.replace(/\\/gu, '/').replace(/^\.?\//u, '').trim();
function embeddedPath(uri: unknown): string | null {
  if (typeof uri !== 'string') return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const prefix of EMBEDDED_PREFIXES) if (lower.startsWith(prefix)) return normalizePath(trimmed.slice(prefix.length));
  return null;
}
const extensionOf = (path: string) => {
  const match = /\.([a-z0-9]+)$/iu.exec(path);
  return match ? match[1].toLowerCase() : '';
};
/** Reads a CHARX bundle: `card.json` plus the icon declared in `data.assets`. Other images are
 * listed (sprite/background) but not extracted — the author decides whether to keep them. */
export async function readCharx(bytes: Uint8Array): Promise<CharxResult> {
  const start = charxZipStart(bytes);
  if (start < 0) throw new Error('不是 CHARX 压缩包（找不到 ZIP 头）');
  const zip = await JSZip.loadAsync(bytes.slice(start));
  const cardFile = zip.file(/(^|\/)card\.json$/iu)[0];
  if (!cardFile) throw new Error('CHARX 里没有 card.json');
  const text = await cardFile.async('string');
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error('CHARX 的 card.json 不是有效 JSON'); }
  const card = parseCard(json);
  const raw = json as { data?: { assets?: unknown[] } };
  const assets: CharxAsset[] = [];
  for (const item of Array.isArray(raw.data?.assets) ? raw.data!.assets! : []) {
    const asset = item as { type?: unknown; name?: unknown; uri?: unknown; ext?: unknown };
    const path = embeddedPath(asset.uri);
    if (!path) continue;
    assets.push({
      type: typeof asset.type === 'string' ? asset.type.toLowerCase() : '',
      name: typeof asset.name === 'string' ? asset.name : '',
      path,
      ext: (typeof asset.ext === 'string' && asset.ext.trim() ? asset.ext.trim().toLowerCase().replace(/^\./u, '') : extensionOf(path))
    });
  }
  const icons = assets.filter(asset => (asset.type === 'icon' || asset.type === 'user_icon') && IMAGE_EXTENSIONS.has(asset.ext));
  const chosen = icons.find(asset => asset.name.toLowerCase() === 'main') ?? icons[0] ?? null;
  let icon: Uint8Array | null = null;
  if (chosen) {
    const file = zip.file(chosen.path);
    if (file) icon = await file.async('uint8array');
  }
  return { card, icon, assets, cardJson: json };
}
