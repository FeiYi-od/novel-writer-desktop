import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 人物关系弹窗：两列表单、字段不重叠、底栏固定
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/relations-ui-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = path.join(fixture, 'profile'); delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    await page.evaluate(async parentDir => window.writer.createProject(parentDir, '关系书', true), parent);
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, path.join(parent, '关系书'));
    await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click();
    await page.getByRole('button', { name: '人物关系…' }).click();
    const modal = page.getByRole('dialog', { name: '人物关系' });
    await modal.waitFor({ timeout: 20000 });
    const metrics = await modal.evaluate(element => {
      const modal = element as HTMLElement;
      const form = modal.querySelector('.relations-form') as HTMLElement;
      const labels = [...form.querySelectorAll(':scope > label')].map(label => {
        const rect = label.getBoundingClientRect();
        return { text: (label.textContent ?? '').trim().slice(0, 12), left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
      });
      const note = form.querySelector('textarea') as HTMLElement;
      const button = form.querySelector(':scope > button') as HTMLElement;
      return {
        width: Math.round(modal.getBoundingClientRect().width), height: Math.round(modal.getBoundingClientRect().height),
        display: getComputedStyle(form).display, columns: getComputedStyle(form).gridTemplateColumns,
        labels, noteWidth: Math.round(note.getBoundingClientRect().width), formWidth: Math.round(form.getBoundingClientRect().width),
        buttonRight: Math.round(button.getBoundingClientRect().right), formRight: Math.round(form.getBoundingClientRect().right),
        overflow: form.scrollWidth - form.clientWidth
      };
    });
    assert.equal(metrics.display, 'grid');
    assert.ok(metrics.width <= 800 && metrics.width >= 640, '弹窗宽度应克制：' + metrics.width);
    assert.ok(metrics.labels.every(item => item.width > 200), '每个字段应有可用宽度：' + JSON.stringify(metrics.labels));
    assert.ok(metrics.noteWidth > metrics.formWidth - 60, '备注应占满整行');
    assert.ok(metrics.buttonRight <= metrics.formRight + 1, '添加按钮不应越出表单');
    assert.equal(metrics.overflow, 0);
    const overlap = metrics.labels.some((a, i) => metrics.labels.some((b, j) => i < j && a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height));
    assert.equal(overlap, false, '字段不应互相重叠：' + JSON.stringify(metrics.labels));
    await page.screenshot({ path: path.join(fixture, 'relations.png') });
    console.log(`Relations modal UI passed: ${JSON.stringify(metrics)} 截图 ${path.join(fixture, 'relations.png')}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
