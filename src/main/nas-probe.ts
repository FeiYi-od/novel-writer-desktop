import * as net from 'node:net';
import { isStorageHost } from '../core/storage-targets';

export interface NasTarget { host: string; port: number; label?: string }
export interface NasProbeResult { host: string; port: number; label?: string; ok: boolean; ms: number; reason?: string }
/** Plain TCP reachability. No credentials, no protocol handshake: enough to tell "network is not
 * there" from "the app is misconfigured". */
export function probeHost(target: NasTarget, timeoutMs = 3000): Promise<NasProbeResult> {
  const started = Date.now();
  return new Promise(resolve => {
    if (!isStorageHost(target.host) || !Number.isInteger(target.port) || target.port <= 0 || target.port > 65535) {
      resolve({ ...target, ok: false, ms: 0, reason: '地址或端口不合法' });
      return;
    }
    const socket = net.connect({ host: target.host, port: target.port });
    const finish = (result: Omit<NasProbeResult, 'host' | 'port' | 'label' | 'ms'>) => {
      socket.destroy();
      resolve({ ...target, ...result, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout' }));
    socket.once('error', error => finish({ ok: false, reason: (error as NodeJS.ErrnoException).code ?? error.message }));
  });
}
export async function probeTargets(targets: NasTarget[], timeoutMs = 3000, concurrency = 4): Promise<NasProbeResult[]> {
  const results: NasProbeResult[] = [];
  for (let index = 0; index < targets.length; index += concurrency) {
    const slice = targets.slice(index, index + concurrency);
    results.push(...await Promise.all(slice.map(target => probeHost(target, timeoutMs))));
  }
  return results;
}
