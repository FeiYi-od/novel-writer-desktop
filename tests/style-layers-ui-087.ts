import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R1：文风分析任务在界面显示「分 N 层压缩 / 已完成 x/y 段」（用夹具任务，不调模型）
async function main() {
  const executable = createRequire(import.meta.url)('electron') as string;
  const fixture = await fs.mkdtemp(path.resolve('.artifacts/style-layers-ui-'));
  const parent = path.join(fixture, '书库'); await fs.mkdir(parent, { recursive: true });
  const profile = path.join(fixture, 'profile');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NOVEL_WRITER_TEST_DATA = profile; delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | null = null, page!: Page;
  try {
    app = await electron.launch({ executablePath: executable, args: [path.resolve('out/main/index.js')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });
    const projectId = await page.evaluate(async parentDir => (await window.writer.createProject(parentDir, '层数书', true)).project.id, parent);
    const taskId = crypto.randomUUID();
    const hex = (value: string) => value.repeat(64).slice(0, 64);
    const task = {
      schemaVersion: 1, id: taskId, projectId, mode: 'style-analysis', chapterPath: '文风分析/夹具全文',
      sourceHash: hex('a'), instruction: '夹具指令', connection: {
        id: crypto.randomUUID(), name: '夹具连接', model: 'fixture', baseUrl: 'https://api.example.com/v1', adapter: 'generic',
        thinking: 'disabled', timeoutSeconds: 60, contextWindow: 32000, maxOutputTokens: 1024, tokenParameter: 'max_tokens'
      },
      createdAt: new Date().toISOString(), status: 'complete', text: JSON.stringify({ rules: ['短句推进', '对白后补动作'], limitations: [] }),
      error: '', finishReason: 'stop', contextHash: hex('b'), context: '', sourceText: '全文分段：5 段，每段≤3000 字，总计 14000 字符',
      styleSource: {
        name: '夹具全文', sourceIds: [hex('a'), hex('c')], sourceHashes: { [hex('a')]: hex('a') }, sampled: false,
        sampleCharacters: 14000, totalCharacters: 14000, mode: 'full', chunks: 5, chunkCharacters: 3000, analyzed: 5,
        layers: 3, layerNotes: ['层一', '层二', '层三'],
        metrics: { characters: 14000, paragraphs: 120, meanSentenceLength: 18, meanParagraphLength: 60, dialogueRatio: 22, firstPersonPerThousand: 3 }
      }
    };
    const folder = path.join(profile, 'ai-tasks', projectId); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, taskId + '.json'), JSON.stringify(task), 'utf8');
    await page.reload();
    await page.getByRole('button', { name: '打开作品 层数书' }).click();
    await page.getByRole('button', { name: '文风研习室' }).click();
    await page.getByLabel('文风分析历史').waitFor({ timeout: 20000 });
    const info = await page.getByText(/分 3 层压缩/u).first().innerText();
    assert.match(info, /已完成 5\/5 段/u);
    await page.screenshot({ path: path.join(fixture, 'layers.png') });
    console.log(`Style layers UI passed: 任务显示「分 3 层压缩」「已完成 5/5 段」；截图 ${path.join(fixture, 'layers.png')}`);
  } finally { await app?.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
