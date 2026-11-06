import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R8：一条真实点击链路——新建小说 → 导入章节 → 文风分析 → 设定提取 → 删除并恢复章节
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/e2e-chain-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const shots = path.join(fixture, 'shots'); await fs.mkdir(shots);
  const chaptersFile = path.join(fixture, '章节.txt');
  await fs.writeFile(chaptersFile, ['第一章 起雾', '　　雾起时，港口的钟敲了三下。', '', '第二章 靠岸', '　　船靠岸了。', '', '第三章 回声', '　　回声在空巷里散开。'].join('\n'), 'utf8');
  const corpus = path.join(fixture, '语料.txt'); await fs.writeFile(corpus, ('　　长篇叙述，句子较长，描写细密。'.repeat(400)), 'utf8');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  const override = async (filePath: string) => app!.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] }); }, filePath);
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.setViewportSize({ width: 1366, height: 768 });

    // 1) 新建小说向导
    await page.getByTestId('new-book-open').click();
    await page.getByTestId('new-book-title').fill('端到端书');
    await override(parent);
    await page.getByTestId('new-book-pick').click();
    await page.getByTestId('new-book-create').click();
    await page.getByRole('dialog', { name: '新建小说' }).waitFor({ state: 'detached', timeout: 25000 });
    const names = await page.evaluate(async () => (await window.writer.listProjects()).map(item => item.name));
    console.log('projects after create:', JSON.stringify(names));
    assert.ok(names.includes('端到端书'), '新建小说没有落库：' + JSON.stringify(names));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    const shelf = page.getByRole('button', { name: '打开作品 端到端书' });
    try { await shelf.waitFor({ timeout: 20000 }); } catch (failure) {
      const dump = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 700), labels: [...document.querySelectorAll('button')].map(item => item.getAttribute('aria-label')).filter(Boolean).slice(0, 15) }));
      console.log('shelf dump:', JSON.stringify(dump));
      throw failure;
    }
    await shelf.click();
    await page.screenshot({ path: path.join(shots, '1-shelf.png') });
    const projectId = await page.evaluate(async () => (await window.writer.listProjects()).find(item => item.name === '端到端书')!.id);

    // 2) 导入章节（整本 TXT 拆章）
    await override(chaptersFile);
    await page.getByRole('button', { name: '整本 TXT 拆章…' }).click();
    await page.getByTestId('import-preview').waitFor({ timeout: 20000 });
    await page.getByTestId('import-confirm').click();
    await page.waitForFunction(async id => (await window.writer.chapters(id)).length >= 3, projectId, { timeout: 30000 });
    await page.screenshot({ path: path.join(shots, '2-chapters.png') });

    // 3) 文风分析（本地统计）
    await page.getByRole('button', { name: '文风研习室' }).click();
    await override(corpus);
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    await page.waitForFunction(async id => (await window.writer.readBook(id)).value.sources.length >= 1, projectId, { timeout: 20000 });
    await page.locator('.source-list input[type=\"checkbox\"]').first().check();
    await page.getByLabel('文风名称', { exact: true }).fill('端到端文风');
    await page.getByRole('button', { name: '分析并生成文风' }).click();
    await page.waitForFunction(async id => (await window.writer.readBook(id)).value.styles.length >= 1, projectId, { timeout: 30000 });
    await page.screenshot({ path: path.join(shots, '3-style.png') });

    // 4) 设定 → 人物卡 + 世界书
    await page.getByRole('button', { name: '角色库' }).click();
    await page.getByTestId('setting-extract-open').click();
    await page.getByTestId('setting-text').fill('角色：林夏\n别名：夏夏\n性格：嘴硬心软。\n\n地点：雾港\n正文：终年大雾的海港城。\n关键词：雾港,码头');
    await page.getByRole('button', { name: '提取候选' }).click();
    await page.getByLabel('选择 林夏').waitFor({ timeout: 15000 });
    await page.getByTestId('setting-confirm').click();
    await page.waitForFunction(async id => (await window.writer.readCharacters(id)).value.cards.length >= 1, projectId, { timeout: 20000 });
    await page.getByRole('dialog', { name: '从文字设定提取' }).getByRole('button', { name: '关闭' }).click();
    await page.getByRole('dialog', { name: '从文字设定提取' }).waitFor({ state: 'detached', timeout: 10000 });
    await page.screenshot({ path: path.join(shots, '4-characters.png') });

    // 5) 删除章节 → 回收站 → 恢复
    await page.getByRole('button', { name: '写作空间' }).click();
    await page.locator('.chapter-list button').first().click();
    await page.waitForFunction(() => { const button = document.querySelector('[data-testid=delete-chapter]') as HTMLButtonElement | null; return !!button && !button.disabled; }, undefined, { timeout: 20000 });
    await page.getByTestId('delete-chapter').click();
    await page.waitForFunction(async id => (await window.writer.trashedChapters(id)).length === 1, projectId, { timeout: 20000 });
    await page.getByRole('button', { name: '章节回收站…' }).click();
    await page.getByTestId('trash-panel').waitFor({ timeout: 10000 });
    const restore = page.locator('[data-testid^="trash-restore-"]').first();
    await restore.click();
    await page.waitForFunction(async id => (await window.writer.trashedChapters(id)).length === 0 && (await window.writer.chapters(id)).length >= 3, projectId, { timeout: 20000 });
    await page.screenshot({ path: path.join(shots, '5-restored.png') });

    const files = (await fs.readdir(shots)).sort();
    assert.equal(files.length, 5, `截图数量不符：${files.join(',')}`);
    for (const file of files) assert.ok((await fs.stat(path.join(shots, file))).size > 15000, `${file} 内容过小`);
    console.log(`E2E chain passed: 新建→导入3章→文风→设定提取→删除并恢复；截图 ${shots}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
