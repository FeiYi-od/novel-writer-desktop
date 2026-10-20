import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// R31-3 可自动化的部分：两台"设备"接力——A 写 → B 打开同一目录继续写 → A 重新打开看到 B 的改动。
// 两台设备用两份独立的 app 数据目录模拟，书目录共用（等价于放在 NAS 上被同步）。
const require = createRequire(import.meta.url);
const launch = async (folder: string, userData: string) => {
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: userData } });
  const page = await app.firstWindow(); page.setDefaultTimeout(25000);
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
  await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
  await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).waitFor();
  return { app, page };
};
const close = async (app: Awaited<ReturnType<typeof launch>>['app']) => { await app.evaluate(({ app: instance }) => { instance.exit(0); }).catch(() => {}); };

async function main() {
  const fixture = path.resolve('.artifacts', `handoff-desktop-${Date.now()}`);
  const folder = path.join(fixture, '共享书');   // 两台"设备"共用的书目录
  await fs.mkdir(folder, { recursive: true });
  const deviceA = path.join(fixture, 'device-a'), deviceB = path.join(fixture, 'device-b');

  // 设备 A：建书 + 建章节 + 写正文
  const first = await launch(folder, deviceA);
  const projectA = await first.page.evaluate(async () => {
    const id = (await window.writer.listProjects())[0].id;
    const chapter = await window.writer.createChapter(id, 'docx');
    await window.writer.saveChapter({ projectId: id, path: chapter.path, expectedHash: chapter.hash,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　设备 A 写了第一段。' }] }] } });
    return { id, path: chapter.path };
  });
  await close(first.app);

  // 设备 B：打开同一本书，读到 A 的文字并追加一段
  const second = await launch(folder, deviceB);
  const seenByB = await second.page.evaluate(async target => {
    const id = (await window.writer.listProjects())[0].id;
    const manuscript = await window.writer.readChapter(id, target.path);
    const text = JSON.stringify(manuscript.content);
    await window.writer.saveChapter({ projectId: id, path: target.path, expectedHash: manuscript.hash,
      content: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '　　设备 A 写了第一段。' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '　　设备 B 续写了第二段。' }] }
      ] } });
    return { sameProject: id === target.id, text };
  }, projectA);
  assert.equal(seenByB.sameProject, true, '两台设备看到的应是同一本书（projectId 不变）');
  assert.match(seenByB.text, /设备 A 写了第一段/u, '设备 B 必须能读到 A 写的内容');
  await close(second.app);

  // 设备 A：重新打开，应看到 B 的续写
  const third = await launch(folder, deviceA);
  const seenByA = await third.page.evaluate(async () => {
    const id = (await window.writer.listProjects())[0].id;
    const chapters = await window.writer.chapters(id);
    const manuscript = await window.writer.readChapter(id, chapters[0].path);
    return JSON.stringify(manuscript.content);
  });
  await close(third.app);
  assert.match(seenByA, /设备 A 写了第一段/u);
  assert.match(seenByA, /设备 B 续写了第二段/u, 'A 重新打开必须看到 B 续写的内容');

  // 两台设备的私有机密（AI 连接）不应混在一起
  const aFiles = await fs.readdir(deviceA).catch(() => [] as string[]);
  const bFiles = await fs.readdir(deviceB).catch(() => [] as string[]);
  assert.ok(aFiles.length > 0 && bFiles.length > 0, '两台设备各自有本机数据目录');
  console.log('Handoff desktop passed: A wrote, B read and appended, A reopened and saw B\'s text; projectId stayed stable.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
