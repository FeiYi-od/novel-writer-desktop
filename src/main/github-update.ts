/** Read-only GitHub release checks. The repository and download destination are fixed. */
const API = 'https://api.github.com/repos/FeiYi-od/novel-writer-desktop/releases';
const RELEASES = 'https://github.com/FeiYi-od/novel-writer-desktop/releases/tag/';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_VERSION_LENGTH = 128;

export interface GitHubUpdateResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

type Version = { original: string; parts: [string, string, string]; prerelease: string[] | null };

function parseVersion(value: unknown): Version | null {
  if (typeof value !== 'string' || value.length > MAX_VERSION_LENGTH) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some(part => /^\d+$/u.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { original: value, parts: [match[1], match[2], match[3]], prerelease };
}

function numericCompare(a: string, b: string): number {
  return a.length === b.length ? (a === b ? 0 : a > b ? 1 : -1) : a.length > b.length ? 1 : -1;
}

function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const result = numericCompare(a.parts[i], b.parts[i]);
    if (result) return result;
  }
  if (!a.prerelease || !b.prerelease) return a.prerelease === b.prerelease ? 0 : a.prerelease ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i], right = b.prerelease[i];
    if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? -1 : 1;
    if (left === right) continue;
    const leftNumber = /^\d+$/u.test(left), rightNumber = /^\d+$/u.test(right);
    if (leftNumber && rightNumber) return numericCompare(left, right);
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

async function readBounded(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_PAGE_BYTES)) throw new Error('GitHub 更新信息过大，无法安全读取');
  if (!response.body) throw new Error('GitHub 更新信息为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAGE_BYTES) throw new Error('GitHub 更新信息过大，无法安全读取');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'GitHub 更新信息过大，无法安全读取') throw error;
    throw new Error('读取 GitHub 更新信息失败，请检查网络后重试');
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('GitHub 更新信息格式无效'); }
}

export async function checkGitHubUpdate(
  currentVersion: string,
  options: { token?: string; fetcher?: typeof fetch; timeoutMs?: number } = {}
): Promise<GitHubUpdateResult> {
  const current = parseVersion(currentVersion);
  if (!current) throw new Error('当前应用版本格式无效，无法检查更新');
  const token = options.token?.trim();
  if (token && (token.length > 1024 || /[\u0000-\u0020\u007f]/u.test(token))) throw new Error('GitHub 授权格式无效');
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('更新检查超时设置无效');
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('检查更新超时，请检查网络后重试')); }, timeoutMs);
  });
  const perform = async (): Promise<GitHubUpdateResult> => {
    let latest: Version | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      let response: Response;
      try {
        const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
        if (token) headers.Authorization = `Bearer ${token}`;
        response = await fetcher(`${API}?per_page=${PAGE_SIZE}&page=${page}`, { headers, redirect: 'error', signal: controller.signal });
      } catch { throw new Error('无法连接 GitHub，请检查网络或代理后重试'); }
      if (response.status === 401 || response.status === 404) throw new Error('无法访问更新仓库，请检查本机 GitHub 授权与仓库访问权限');
      if (response.status === 403 || response.status === 429) throw new Error('GitHub 拒绝访问或请求次数受限，请检查授权并稍后重试');
      if (!response.ok || response.redirected) throw new Error('GitHub 更新服务返回异常，请稍后重试');
      const data = await readBounded(response);
      if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new Error('GitHub 更新列表格式无效');
      for (const item of data) {
        if (!item || typeof item !== 'object' || typeof item.draft !== 'boolean') throw new Error('GitHub 更新列表格式无效');
        if (item.draft) continue;
        const version = parseVersion(item.tag_name);
        if (!version) throw new Error('GitHub 发布版本格式无法识别，请在浏览器查看发布页');
        if (!latest || compareVersions(version, latest) > 0) latest = version;
      }
      if (data.length < PAGE_SIZE) {
        if (!latest) throw new Error('没有找到可识别的 GitHub 发布版本');
        return { currentVersion, latestVersion: latest.original, updateAvailable: compareVersions(latest, current) > 0, releaseUrl: RELEASES + encodeURIComponent(latest.original) };
      }
    }
    throw new Error('GitHub 发布版本过多，无法完整检查；请在浏览器查看发布页');
  };
  try { return await Promise.race([perform(), timeout]); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
