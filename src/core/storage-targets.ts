/** Shared, browser-safe validation for manually entered TCP reachability targets. */
export interface StorageTarget { host: string; port: number; label: string }
export const MAX_STORAGE_TARGETS = 8;

export function isStorageHost(host: string): boolean {
  if (!host || host.length > 253 || /[\s/@?#\\%\[\]]/u.test(host)) return false;
  if (host.includes(':')) {
    try {
      const url = new URL(`http://[${host}]/`);
      return url.hostname.startsWith('[') && url.hostname.endsWith(']');
    } catch { return false; }
  }
  if (/^[\d.]+$/u.test(host)) {
    const parts = host.split('.');
    return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255);
  }
  return host.split('.').every(label => label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(label));
}

/** A bare IPv6 address always uses the default port. Custom ports require [IPv6]:port. */
export function parseStorageTargets(input: string): StorageTarget[] {
  if (input.length > 4000) throw new Error('目标内容过长，最多 4000 个字符');
  const result: StorageTarget[] = [];
  for (const [index, raw] of input.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const fail = (message: string): never => { throw new Error(`第 ${index + 1} 行：${message}`); };
    if (result.length >= MAX_STORAGE_TARGETS) fail(`一次最多检查 ${MAX_STORAGE_TARGETS} 个目标`);
    let host = line; let port = 443;
    if (line.startsWith('[')) {
      const match = /^\[([^\]]+)\](?::(\d+))?$/u.exec(line);
      if (!match || !match[1]!.includes(':')) throw new Error(`第 ${index + 1} 行：IPv6 格式应为 [IPv6]:端口`);
      host = match[1]!;
      if (match[2] !== undefined) port = Number(match[2]);
    } else if ((line.match(/:/gu) ?? []).length === 1) {
      const match = /^([^:]+):(\d+)$/u.exec(line);
      if (!match) throw new Error(`第 ${index + 1} 行：端口须为 1–65535 的整数`);
      host = match[1]!; port = Number(match[2]);
    }
    if (!isStorageHost(host)) fail('请输入域名、IPv4 或 IPv6；不要填写网址、路径或账号');
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('端口须为 1–65535 的整数');
    result.push({ host, port, label: line });
  }
  return result;
}

/** These are folder workflows, not login/API adapters. Never store user addresses here. */
export const STORAGE_PROVIDERS = [
  { id: 'generic', name: '通用 NAS / 已挂载文件夹', guide: '先在 Windows 中连接可读写共享文件夹或映射盘，再从书架打开其中的小说文件夹。远程连接由设备官方客户端或你已配置的网络连接提供。' },
  { id: 'fnos', name: '飞牛 NAS', guide: '先用飞牛官方同步客户端准备本机同步文件夹，或在 Windows 中连接共享目录，再从书架打开小说。公网域名、IPv6 或 FN Connect 的连接由你在官方工具中配置。' },
  { id: 'synology', name: '群晖 Synology', guide: '在 Synology Drive Client 中配置双向同步，完成后从书架打开本机同步文件夹；也可使用已连接的 Windows 共享目录。' },
  { id: 'qnap', name: '威联通 QNAP', guide: '在 Qsync Client 中配置本机文件夹配对，完成同步后从书架打开该目录；也可使用已连接的 Windows 共享目录。' },
  { id: 'baidu', name: '百度网盘', guide: '若你的客户端与账户支持同步空间，先配置双向同步并把小说下载到本机，再打开对应文件夹。普通上传或自动备份不等于双向同步；未配置同步时可上传整书 ZIP 备份。' },
  { id: 'xunlei', name: '迅雷云盘', guide: '若官方工具或你已配置的挂载工具提供可读写的 Windows 文件夹，可从书架打开；仅有下载或单向上传时，请用整书 ZIP 备份手动转移。当前没有内置迅雷云盘登录与直传。' },
  { id: 'onedrive', name: 'OneDrive', guide: '在 OneDrive 客户端中配置同步，把小说文件夹设为“始终保留在此设备上”，再从书架打开；另一台电脑接力前先确认客户端同步完成。' },
  { id: 'other', name: '其他网盘 / 挂载工具', guide: '提供普通可读写 Windows 文件夹的同步客户端或挂载工具可走同一目录流程。先用虚构小说检查保存与同步；只支持网页上传的网盘可用于存放导出的整书 ZIP。' },
] as const;
