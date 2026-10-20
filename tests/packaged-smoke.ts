import { _electron as electron } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';

// Smoke check for the packaged app: it must start from release/win-unpacked with its own asar.
async function main() {
  const exe = path.join(process.env.LOCALAPPDATA ?? '', 'NovelWriterBuild', 'win-unpacked', '小说编写器.exe');
  const data = path.resolve('.artifacts', `packaged-smoke-${Date.now()}`);
  await fs.mkdir(path.join(data, 'app-data'), { recursive: true });
  // Electron derives its mode from ELECTRON_RUN_AS_NODE; a shell that exports it would turn the
  // packaged app into a plain Node process that exits with "bad option".
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.NOVEL_WRITER_TEST_DATA = path.join(data, 'app-data');
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'], env });
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    page.setDefaultTimeout(15000);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).waitFor();
    const title = await page.title();
    const version = await app.evaluate(({ app: instance }) => instance.getVersion());
    console.log(`Packaged smoke passed: title=${title} version=${version} window=${await page.locator('h1').first().innerText()}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
