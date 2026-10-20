import { _electron as electron } from 'playwright';
import * as fs from 'node:fs/promises';
import path from 'node:path';

// Verifies the portable folder (created from electron-builder's win-unpacked output) really opens
// the editor window, so the zip we hand out is known to start on this machine.
async function main() {
  const portable = path.join(process.env.LOCALAPPDATA ?? '', 'NovelWriterPortable');
  const data = path.resolve('.artifacts', `portable-verify-${Date.now()}`);
  await fs.mkdir(data, { recursive: true });
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.NOVEL_WRITER_TEST_DATA = data;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.join(portable, 'NovelWriter.exe'), args: [], env });
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    page.setDefaultTimeout(15000);
    await page.getByRole('button', { name: '＋ 打开小说文件夹' }).waitFor();
    console.log(`Portable verify passed: title=${await page.title()}`);
  } finally { await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error('PORTABLE_VERIFY_FAIL', error); process.exitCode = 1; });
