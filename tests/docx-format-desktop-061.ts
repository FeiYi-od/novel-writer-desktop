import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/docx-format-desktop-061-'));
  const book = path.join(fixture, '虚构书'); await fs.mkdir(book, { recursive: true });
  const bytes = new Uint8Array(await encodeDocx(textDocument('　　第一段正文\n　　第二段正文')));
  const name = '排版原稿.docx';
  await fs.writeFile(path.join(book, name), bytes);
  const originalHash = sha(bytes);
  const userData = path.join(fixture, 'profile');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = userData; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, book);
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByText(`已打开「${path.basename(book)}」`, { exact: false }).first().waitFor();
    await page.locator('.chapter-list button').filter({ hasText: name }).click();
    await page.getByTestId('fidelity-open').click();
    const modal = page.getByRole('dialog', { name: 'Word 保真副本编辑', exact: true });
    await modal.waitFor();
    await modal.getByTestId('docx-format-open').click();
    const panel = page.getByRole('dialog', { name: '段落排版', exact: true });
    await panel.waitFor();
    await panel.getByRole('button', { name: '选择第 1 段', exact: true }).click();
    await panel.getByTestId('format-align').selectOption('center');
    await panel.getByTestId('format-indent').fill('0');
    await panel.getByTestId('format-spacing').fill('1.5');
    await panel.getByTestId('format-save').click();
    // 保存成功后父级会切换到新副本，面板可能被卸载；以磁盘结果为准，不依赖面板文案。
    let copy: string | undefined;
    for (let attempt = 0; attempt < 100 && !copy; attempt++) {
      copy = (await fs.readdir(book)).find(item => item.includes('-排版副本-'));
      if (!copy) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(copy, '应生成排版副本');
    assert.equal(sha(await fs.readFile(path.join(book, name))), originalHash, '原稿必须逐字节不变');
    const xml = await (await JSZip.loadAsync(await fs.readFile(path.join(book, copy)))).file('word/document.xml')!.async('string');
    assert.match(xml, /<w:jc w:val="center"\/>/u);
    // 文档自带的 spacing 属性会被保留（合并进同一元素），这里只断言本次设置的行距生效。
    assert.match(xml, /<w:spacing\b[^>]*w:line="360"[^>]*\/>/u);
    assert.match(xml, /第一段正文/u); assert.match(xml, /第二段正文/u);
    console.log('Docx format desktop passed: 段落排版面板生成排版副本，原稿字节不变，对齐/行距写入新副本。');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
