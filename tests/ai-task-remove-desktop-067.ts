import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R3：删除已结束的 AI 任务记录（夹具 JSON，不调用模型）
const connectionId = crypto.randomUUID();
const taskOf = (id: string, projectId: string) => ({
  schemaVersion: 1, id, projectId, mode: 'write', chapterPath: '第一章.docx', sourceHash: 'a'.repeat(64),
  instruction: '夹具任务', connection: {
    id: connectionId, name: '夹具连接', model: 'm', baseUrl: 'https://api.example.com/v1', adapter: 'generic',
    thinking: 'default', timeoutSeconds: 300, contextWindow: 8192, maxOutputTokens: 1024, tokenParameter: 'max_tokens'
  },
  createdAt: new Date().toISOString(), status: 'complete', text: '夹具输出', error: '', finishReason: 'stop',
  contextHash: 'b'.repeat(64), context: '', sourceText: '正文'
});

async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/ai-task-remove-desktop-'));
  const profile = path.join(fixture, 'profile');
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = profile; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(25000);
    page.on('dialog', dialog => void dialog.accept());
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '任务删除书', true)).project.id, parent);
    const taskId = crypto.randomUUID();
    const folder = path.join(profile, 'ai-tasks', projectId);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, `${taskId}.json`), JSON.stringify(taskOf(taskId, projectId)), 'utf8');
    await page.reload();
    await page.getByRole('button', { name: '打开作品 任务删除书' }).click();
    await page.getByRole('button', { name: '写作空间' }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 写作与审稿' }).click();
    await page.getByTestId('ai-task-remove').first().waitFor({ timeout: 20000 });
    await page.getByTestId('ai-task-remove').first().click();
    await page.getByText('任务记录已删除').waitFor({ timeout: 15000 });
    await page.waitForFunction(async id => (await window.writer.aiTasks(id)).length === 0, projectId, { timeout: 15000 });
    assert.equal(await fs.stat(path.join(folder, `${taskId}.json`)).then(() => true).catch(() => false), false, '记录文件应被删除');
    console.log('AI task remove desktop passed: 已结束任务可从历史删除，文件同步消失，未调用模型。');
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
