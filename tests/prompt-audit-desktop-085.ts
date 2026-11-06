import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R3：提示词库删除审计区可见（本地，不联网）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/prompt-audit-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.setViewportSize({ width: 1000, height: 720 });
    page.on('dialog', dialog => void dialog.accept());
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '审计书', true), parent);
    await page.reload();
    await page.getByRole('button', { name: '打开作品 审计书' }).click();
    await page.locator('.chapter-list button').first().click();
    await page.waitForFunction(() => { const button = document.querySelector('[data-testid=delete-chapter]') as HTMLButtonElement | null; return !!button && !button.disabled; }, undefined, { timeout: 20000 });
    await page.getByRole('button', { name: '提示词库…' }).click();
    const audit = page.getByTestId('prompt-audit');
    await audit.waitFor({ timeout: 20000 });
    await audit.locator('summary').click();
    const modal = page.getByRole('dialog', { name: '提示词库' });
    const layout = await modal.evaluate(element => ({ rect: element.getBoundingClientRect().toJSON(), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, viewportHeight: innerHeight }));
    assert.ok(layout.rect.top >= 0 && layout.rect.bottom <= layout.viewportHeight, '提示词库应位于视口内');
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, '提示词库不得横向溢出');
    await page.screenshot({ path: path.join(fixture, 'prompt-audit.png') });
    const text = await audit.innerText();
    assert.match(text, /删除记录（\d+）/u);
    assert.match(text, /追溯/u);
    await page.getByRole('dialog', { name: '提示词库' }).screenshot({ path: path.join(fixture, 'prompt-audit.png') });
    await page.getByRole('dialog', { name: '提示词库' }).getByRole('button', { name: '关闭' }).click();
    console.log(`Prompt audit desktop passed: 删除审计区可见并可关闭；截图 ${path.join(fixture, 'prompt-audit.png')}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
