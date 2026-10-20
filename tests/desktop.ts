import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { cardPng, v2 } from './card-fixtures';
import { parseCharactersMarkdown } from '../src/main/markdown-materials';

async function main() {
  const require = createRequire(import.meta.url);
  const fixture = path.resolve('.artifacts', `desktop-${Date.now()}`);
  const bookA = path.join(fixture, '星雨学园');
  const bookB = path.join(fixture, '远海航线');
  await Promise.all([fs.mkdir(bookA, { recursive: true }), fs.mkdir(bookB, { recursive: true })]);
  const app = await electron.launch({
    executablePath: require('electron'), args: [path.resolve('out/main/index.js')],
    env: { ...process.env, NOVEL_WRITER_TEST_DATA: path.join(fixture, 'app-data') }
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const screenshot = async (name: string) => {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const png = await Promise.race([app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      return image.toPNG().toString('base64');
    }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('桌面截图超时')), 12000); })]).finally(() => clearTimeout(timer));
    assert.ok(png.length > 100, '隐藏窗口应生成有效截图');
    await fs.writeFile(path.resolve('.artifacts', name), Buffer.from(png, 'base64'));
  };
  try {
    await page.getByRole('heading', { name: '我的书架', exact: false }).waitFor();
    const openBook = async (folder: string) => {
      await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, folder);
      await page.getByRole('button', { name: '＋ 打开小说文件夹' }).click();
      await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor();
    };
    await openBook(bookA);
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节' }).click();
    // Tiptap contenteditable 并非固定带 role=textbox，使用其可访问标签定位。
    const body = page.locator('.tiptap');
    await body.waitFor();
    await body.fill('林夏走进教室。');
    await body.press('End');
    await body.press('Enter');
    await page.keyboard.insertText('窗外正在下雨。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const paragraphs = await body.locator('p').allTextContents();
    assert.deepEqual(paragraphs, ['　　林夏走进教室。', '　　窗外正在下雨。']);
    const font = await body.evaluate(element => ({ family: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize }));
    assert.match(font.family, /SimSun|宋体/);
    assert.equal(font.size, '14px'); // 10.5 pt at 96 dpi
    await app.evaluate(({ clipboard }) => {
      // 拦截测试的剪贴板写入，避免改动用户系统剪贴板。
      clipboard.writeText = async value => { (globalThis as any).__copiedText = value; };
    });
    await page.getByRole('button', { name: '复制正文', exact: true }).click();
    await page.getByText('正文已复制，包含两个全角段首空格', { exact: true }).waitFor();
    assert.equal(await app.evaluate(() => (globalThis as any).__copiedText), '　　林夏走进教室。\n\n　　窗外正在下雨。');
    await page.getByLabel('人物笔记').fill('林夏：内向，害怕海水。');
    await page.getByRole('button', { name: '保存本书资料' }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor();
    await openBook(bookB);
    assert.equal(await page.getByLabel('人物笔记').inputValue(), '');
    await page.getByLabel('人物笔记').fill('林夏：外向，是一位水手。');
    await page.getByRole('button', { name: '保存本书资料' }).click();
    await page.getByText('本书资料已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '星雨学园 独立小说空间' }).click();
    await page.getByText('已打开「星雨学园」', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('人物笔记').inputValue(), '林夏：内向，害怕海水。');
    const chapter = (await fs.readdir(bookA)).find(name => name.endsWith('.docx'))!;
    await page.getByRole('button', { name: chapter, exact: false }).click();
    await body.waitFor();
    assert.match(await body.innerText(), /林夏走进教室/);
    const actual = await mammoth.extractRawText({ path: path.join(bookA, chapter) });
    assert.match(actual.value, /\u3000\u3000林夏走进教室/);
    // 书架封面、引言、分集与章节归属。
    await page.getByRole('button', { name: '我的书架', exact: true }).click();
    await page.getByRole('button', { name: '编辑作品 星雨学园' }).click();
    await page.getByLabel('小说引言', { exact: true }).fill('一场雨，让两条平行的青春轨迹相遇。');
    const coverPath = path.join(fixture, 'cover.png');
    const coverData = await app.evaluate(({ nativeImage }) => {
      // 测试图片在独立目录中生成，不使用用户图片。
      const bitmap = Buffer.alloc(120 * 180 * 4);
      for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 112; bitmap[i + 1] = 142; bitmap[i + 2] = 72; bitmap[i + 3] = 255; }
      return nativeImage.createFromBitmap(bitmap, { width: 120, height: 180 }).toPNG().toString('base64');
    });
    await fs.writeFile(coverPath, Buffer.from(coverData, 'base64'));
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, coverPath);
    await page.getByRole('button', { name: '选择小说封面' }).click();
    await page.getByRole('img', { name: '星雨学园封面' }).waitFor();
    await page.getByRole('button', { name: '＋ 添加分集' }).click();
    await page.getByLabel('分集名称', { exact: true }).fill('第一集 · 雨的序章');
    await page.getByLabel('分集引言', { exact: true }).fill('在这里，他们第一次相遇。');
    await page.getByRole('button', { name: '选择分集封面' }).click();
    await page.getByRole('img', { name: '第一集 · 雨的序章封面' }).waitFor();
    await page.getByRole('checkbox', { name: `本集章节 ${chapter}`, exact: true }).check();
    await page.getByRole('button', { name: '保存书架资料' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await screenshot('shelf.png');
    await page.getByRole('button', { name: '打开作品 星雨学园' }).click();
    await page.getByLabel('查看分集').selectOption({ label: '第一集 · 雨的序章' });
    await page.getByText('在这里，他们第一次相遇。', { exact: true }).waitFor();
    // 独立文风页面：两组语料形成两种风格，AI 面板选择保持。
    await page.getByRole('button', { name: '文风研习室', exact: true }).click();
    const dialoguePath = path.join(fixture, '对白风格.txt'); const narrativePath = path.join(fixture, '叙述风格.txt');
    await fs.writeFile(dialoguePath, '“你终于来了！”我推开门。\n“当然，我不会错过。”她笑了。\n'.repeat(20));
    await fs.writeFile(narrativePath, '山脉沿着地平线缓缓延伸，暮色笼罩了古老的城墙，远处河流在平原之间曲折穿行，行旅者停下脚步等待最后一班渡船抵达岸边。'.repeat(20));
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [dialoguePath, narrativePath]);
    await page.getByRole('button', { name: '＋ 导入文本' }).click();
    await page.getByRole('checkbox', { name: /对白风格.txt/ }).check();
    await page.getByLabel('文风名称', { exact: true }).fill('轻快对白');
    await page.getByRole('button', { name: '分析并生成文风' }).click();
    await page.getByRole('heading', { name: '轻快对白', exact: true }).waitFor();
    await page.getByRole('checkbox', { name: /对白风格.txt/ }).uncheck();
    await page.getByRole('checkbox', { name: /叙述风格.txt/ }).check();
    await page.getByLabel('文风名称', { exact: true }).fill('沉静叙述');
    await page.getByRole('button', { name: '分析并生成文风' }).click();
    await page.getByRole('heading', { name: '沉静叙述', exact: true }).waitFor();
    await page.locator('.style-card').filter({ has: page.getByRole('heading', { name: '沉静叙述' }) }).getByRole('button', { name: '用于本书' }).click();
    await page.getByText('本书使用中', { exact: true }).waitFor();
    await screenshot('styles.png');
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    assert.equal(await page.getByLabel('辅助创作文风', { exact: true }).locator('option:checked').textContent(), '沉静叙述');
    const persisted = JSON.parse(await fs.readFile(path.join(bookA, '小说资料', 'book.json'), 'utf8'));
    assert.equal(persisted.volumes[0].chapters[0], chapter);
    assert.ok(persisted.cover && persisted.volumes[0].cover);
    assert.equal(persisted.styles.length, 2);
    await screenshot('desktop.png');
    // 图片角色卡与文字卡并存，预览确认、头像、编辑重开和跨书隔离。
    await page.getByRole('button', { name: '角色库', exact: true }).click();
    await page.getByRole('heading', { name: /角色库/ }).waitFor();
    const cardPath = path.join(fixture, '学园角色.png'); const textPath = path.join(fixture, '航海伙伴.txt');
    await fs.writeFile(cardPath, cardPng([{ key: 'chara', value: v2 }]));
    await fs.writeFile(textPath, '沉稳的航海士，珍惜同伴，擅长观察天气。');
    const choose = async (file: string) => app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
    await choose(cardPath);
    await page.getByRole('button', { name: '导入图片角色卡', exact: true }).click();
    await page.getByRole('dialog', { name: '角色卡编辑' }).waitFor();
    assert.equal(await page.getByLabel('角色名称', { exact: true }).inputValue(), '林夏');
    assert.equal(await page.getByLabel('角色描述', { exact: true }).inputValue(), '守信的图书管理员。');
    assert.equal(await page.locator('.character-card').count(), 0);
    await page.getByText(/内嵌世界书已保留/).waitFor();
    await page.getByLabel('确认用于本书', { exact: true }).check();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('img', { name: '林夏头像' }).waitFor();
    await choose(textPath);
    await page.getByRole('button', { name: '导入文字角色卡', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByLabel('确认用于本书', { exact: true }).check();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('启用角色 林夏', { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel('启用角色 航海伙伴', { exact: true }).isChecked(), true);
    await page.locator('.character-context summary').click();
    assert.match(await page.locator('.character-context pre').innerText(), /林夏[\s\S]*航海伙伴/);
    assert.doesNotMatch(await page.locator('.character-context pre').innerText(), /作者私有说明|卡片系统指令|测试世界书/);
    await page.locator('.character-card').filter({ has: page.getByRole('heading', { name: '航海伙伴', exact: true }) }).getByRole('button', { name: '查看与编辑' }).click();
    await page.getByLabel('性格与行为边界', { exact: true }).fill('不抛弃任何同伴。');
    await choose(coverPath);
    await page.getByRole('button', { name: '选择角色头像' }).click();
    await page.getByRole('img', { name: '角色卡预览' }).waitFor();
    await page.getByRole('button', { name: '保存角色卡', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('img', { name: '航海伙伴头像' }).waitFor();
    await screenshot('characters.png');
    // 取消导入不会增加角色。
    await choose(cardPath);
    await page.getByRole('button', { name: '导入图片角色卡', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.character-card').count(), 2);
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '远海航线 独立小说空间' }).click();
    await page.getByText('已打开「远海航线」', { exact: false }).waitFor();
    await page.getByRole('button', { name: '角色库', exact: true }).click();
    await page.getByRole('button', { name: '＋ 新建文字角色卡' }).click();
    await page.getByLabel('角色名称', { exact: true }).fill('林夏');
    await page.getByLabel('角色描述', { exact: true }).fill('另一部小说的同名水手。');
    await page.getByRole('button', { name: '保存角色卡', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.character-card').count(), 1);
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '星雨学园 独立小说空间' }).click();
    await page.getByText('已打开「星雨学园」', { exact: false }).waitFor();
    await page.getByRole('button', { name: '角色库', exact: true }).click();
    await page.getByRole('heading', { name: '航海伙伴', exact: true }).waitFor();
    assert.equal(await page.locator('.character-card').count(), 2);
    const projectId = JSON.parse(await fs.readFile(path.join(bookA, '小说资料', 'project.json'), 'utf8')).id;
    const materialDirectory = path.join(fixture, 'app-data', '创作资料', projectId);
    const characters = parseCharactersMarkdown(await fs.readFile(path.join(materialDirectory, '人物卡.md'), 'utf8'), projectId);
    assert.deepEqual(characters.cards[0].raw, v2);
    assert.equal(characters.cards[1].personality, '不抛弃任何同伴。');
    assert.deepEqual(await fs.readFile(path.join(materialDirectory, 'character-originals', characters.cards[0].source.original)), await fs.readFile(cardPath));
    assert.deepEqual(errors, []);
    console.log('桌面测试通过：DOCX/书架/文风，以及图片和文字角色卡导入、共同启用、头像编辑、取消、重开与跨书同名隔离。');
    console.log(`截图：${path.resolve('.artifacts/desktop.png')}`);
  } catch (error) {
    console.error('界面状态：', await page.locator('body').innerText().catch(() => '窗口不可用'));
    await page.screenshot({ path: path.resolve('.artifacts/desktop-failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
    throw error;
  } finally {
    // 测试数据独立，退出时跳过真实用户的未保存保护对话框。
    await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
