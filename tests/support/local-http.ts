import type { Server } from 'node:http';
import { once } from 'node:events';

// Windows can allocate 6000 for listen(0); fetch rejects it before issuing HTTP.
// Keep the real fetch checks, and allocate another port instead of masking errors.
const restricted = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
export async function listenLocalHttp(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    if (port >= 1024 && !restricted.has(port)) return port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error('无法分配可用于 fetch 的本机测试端口');
}
