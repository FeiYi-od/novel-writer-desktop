import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

async function main() {
  const fixture = path.resolve('.artifacts', `knowledge-desktop-${Date.now()}`);
  const bookA = path.join(fixture, '检索学园甲'), bookB = path.join(fixture, '检索航线乙');
  const data = path.join(fixture, 'app-data');
  await Promise.all([fs.mkdir(bookA, { recursive: true }), fs.mkdir(bookB, { recursive: true })]);
  const txtName = '同名正文.txt', candidateName = '未确认候选.docx', reference = path.join(fixture, '虚构参考作品.txt');
  await fs.writeFile(path.join(bookA, txtName), '银叶列车沿溪谷行进。\n独有旧版石灯。', 'utf8');
  await fs.writeFile(path.join(bookB, txtName), '银叶航线停靠乙书的港口。异书黑鲸只在乙书出现。', 'utf8');
  const candidateBytes = await encodeDocx(textDocument('银叶候选尚未确认。草稿石鸥不能因为另存文件就成为正史。'));
  await fs.writeFile(path.join(bookA, candidateName), candidateBytes);
  await fs.writeFile(reference, '参考月舟来自另一部虚构作品。\n“看，银叶岛的钟响了。”参考角色说。', 'utf8');
  const require = createRequire(import.meta.url);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.resolve('out/main/index.js')], env: { ...process.env, NOVEL_WRITER_TEST_DATA: data } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const choose = (file: string) => app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
  const openBook = async (folder: string) => { await choose(folder); await page.getByRole('button', { name: '＋ 打开小说文件夹', exact: true }).click(); await page.getByText(`已打开「${path.basename(folder)}」`, { exact: false }).waitFor(); };
  const enterSearch = async () => { await page.getByRole('button', { name: '知识检索', exact: true }).click(); await page.getByLabel('关键词', { exact: true }).waitFor(); };
  const search = async (query: string, corpus: 'discussion' | 'canon' | 'style-reference' = 'discussion') => {
    await page.getByLabel('检索范围', { exact: true }).selectOption(corpus);
    await page.getByLabel('关键词', { exact: true }).fill(query);
    const expected = (await counts()).searches + 1;
    try { await page.getByRole('button', { name: '检索本书', exact: true }).click(); }
    catch (cause) { throw new Error(`检索按钮未就绪 (${corpus}/${query}): ${(await page.getByRole('alert').allTextContents()).join(' | ')} ${(await page.getByRole('status').allTextContents()).join(' | ')}`, { cause }); }
    await settleReply(expected);
    await page.getByRole('status').filter({ hasText: '检索完成' }).waitFor();
    return page.locator('.knowledge-hit').allTextContents();
  };
  const waitForHeld = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await app.evaluate(() => (globalThis as any).__knowledgeHeld.length > 0)) return;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Synthetic delayed search did not complete its backend phase');
  };
  const release = () => app.evaluate(() => { (globalThis as any).__knowledgeHold = false; for (const resolve of (globalThis as any).__knowledgeHeld.splice(0)) resolve(); });
  const counts = () => app.evaluate(() => ({ searches: (globalThis as any).__knowledgeSearchCalls, replies: (globalThis as any).__knowledgeReplies, network: (globalThis as any).__knowledgeNetworkCalls }));
  const settleReply = async (expected: number) => {
    const deadline = Date.now() + 5000;
    while ((await counts()).replies < expected && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal((await counts()).replies, expected);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  try {
    // The real local provider runs first. Only its completed IPC reply is held,
    // simulating a late delivery without changing production service behavior.
    // This checks renderer cancellation/isolation, not the main-process lock.
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as any; state.__knowledgeHold = false; state.__knowledgeHeld = []; state.__knowledgeSearchCalls = 0; state.__knowledgeReplies = 0; state.__knowledgeNetworkCalls = 0;
      const original = (ipcMain as any)._invokeHandlers.get('knowledge:search');
      if (!original) throw new Error('knowledge:search is not registered in the built application');
      ipcMain.removeHandler('knowledge:search');
      ipcMain.handle('knowledge:search', async (event, ...args) => {
        state.__knowledgeSearchCalls++;
        const result = await original(event, ...args);
        if (state.__knowledgeHold) await new Promise<void>(resolve => state.__knowledgeHeld.push(resolve));
        state.__knowledgeReplies++; return result;
      });
      // Any accidental model HTTP fetch makes this isolated test fail.
      globalThis.fetch = (async () => { state.__knowledgeNetworkCalls++; throw new Error('Knowledge desktop fixtures cannot use a network model'); }) as typeof fetch;
    });

    await openBook(bookA);
    const projectA = (await page.evaluate(() => window.writer.listProjects())).find(p => p.root === bookA)!;
    await page.getByRole('button', { name: '＋ 新建 DOCX 章节', exact: true }).click();
    await page.locator('.tiptap').fill('银叶雨馆位于山谷。');
    await page.locator('.tiptap').press('End'); await page.locator('.tiptap').press('Enter');
    await page.keyboard.insertText('林夏在白色廊桥等待。');
    await page.getByRole('button', { name: '保存 DOCX', exact: true }).click();
    await page.getByText('DOCX 已保存到所选文件夹', { exact: true }).waitFor();
    const docxName = (await fs.readdir(bookA)).find(n => n.endsWith('.docx') && n !== candidateName)!;
    const originalDocx = await fs.readFile(path.join(bookA, docxName));
    await page.evaluate(async id => {
      const notes = await window.writer.readNotes(id);
      await window.writer.saveNotes(id, { ...notes.value, characters: '银叶见习人物林夏遵守约定。', world: '银叶世界的规则：钟响前不能离开雨馆。', preset: '预设黑礁是表达要求，不能当成故事事实。', style: '文风白鹭只是一条表达规则。' }, notes.hash);
      let cards = await window.writer.readCharacters(id);
      const fields = { name: '银叶信使', description: '银叶信使守护山谷邮局。', personality: '守信且谨慎。', scenario: '居住在学园。', firstMessage: '非事实赤鹭开场白。', examples: '示例黄鹭对白。', creatorNotes: '私注红桐不可当成正史。', systemPrompt: '', postHistoryInstructions: '', alternateGreetings: [] };
      cards = await window.writer.saveCharacter(id, { fields, enabled: true }, cards.hash);
      await window.writer.saveCharacter(id, { fields: { ...fields, name: '未启用砂鲸', description: '未启用砂鲸是未确认设想。' }, enabled: false }, cards.hash);
      let planning = await window.writer.readPlanning(id);
      const outline = ['故事定位', '主线与冲突', '人物成长', '情节阶段', '结局方向', '待确认事项'].map((title, i) => `## ${title}\n${i === 0 ? '银叶青塔引导本书主线。' : '本字段为虚构测试内容。'}`).join('\n\n');
      planning = await window.writer.savePlanning(id, { ...planning.value, drafts: { ...planning.value.drafts, outline } }, planning.hash);
      await window.writer.acceptPlanning(id, 'outline', planning.hash, '');
      planning = await window.writer.readPlanning(id);
      await window.writer.savePlanning(id, { ...planning.value, drafts: { ...planning.value.drafts, outline: '草稿铜鸥尚未确认。' }, briefs: { ...planning.value.briefs, outline: '构想金鹭尚未确认。' } }, planning.hash);
    }, projectA.id);
    await page.getByRole('button', { name: '文风研习室', exact: true }).click();
    await choose(reference); await page.getByRole('button', { name: '＋ 导入文本', exact: true }).click();
    await page.getByRole('checkbox', { name: /虚构参考作品.txt/ }).waitFor();
    const book = await page.evaluate(id => window.writer.readBook(id), projectA.id);
    const source = book.value.sources[0];
    const referencePath = path.join(bookA, '小说资料', 'style-sources', `${source.id}.${source.format ?? 'txt'}`);
    const originalReference = await fs.readFile(referencePath);
    const materials = ['创作笔记.md', '人物卡.md', '创作筹备.md', '文风档案.md'];
    const materialBytes = await Promise.all(materials.map(name => fs.readFile(path.join(data, '创作资料', projectA.id, name)).catch(e => { if (e.code === 'ENOENT') return null; throw e; })));

    await enterSearch(); assert.equal((await counts()).searches, 0);
    assert.equal(await page.getByLabel('检索范围', { exact: true }).inputValue(), 'discussion', 'Saved manuscripts/candidates are the default draft corpus, not confirmed canon');
    await page.getByLabel('关键词', { exact: true }).fill('银叶');
    await page.getByLabel('检索范围', { exact: true }).selectOption('style-reference');
    assert.equal((await counts()).searches, 0, 'Changing query/scope must not start a search');
    const manuscripts = (await search('银叶')).join('\n');
    assert.match(manuscripts, /银叶雨馆/); assert.match(manuscripts, /银叶列车/); assert.match(manuscripts, /银叶候选/);
    assert.doesNotMatch(manuscripts, /银叶世界的规则|银叶信使|银叶青塔|银叶岛|参考月舟|银叶航线/);
    assert.match(manuscripts, /同名正文\.txt/); assert.match(manuscripts, new RegExp(docxName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const hit of await page.locator('.knowledge-hit').allTextContents()) assert.match(hit, /源文本段落 \d+(?:–\d+)? · 版本 [a-f0-9]{12}/, 'Every displayed match must retain its source paragraph range and version');
    const canon = (await search('银叶', 'canon')).join('\n');
    assert.match(canon, /银叶世界的规则/); assert.match(canon, /银叶信使/); assert.match(canon, /银叶青塔/); assert.match(canon, /银叶见习人物/);
    assert.doesNotMatch(canon, /银叶雨馆|银叶列车|银叶候选|银叶岛|参考月舟|银叶航线/);
    assert.deepEqual(await search('参考月舟'), []);
    for (const excluded of ['未启用砂鲸', '草稿铜鸥', '草稿石鸥', '构想金鹭', '预设黑礁', '文风白鹭', '私注红桐', '非事实赤鹭', '示例黄鹭', '异书黑鲸']) assert.deepEqual(await search(excluded, 'canon'), [], `${excluded} must not enter saved canon`);
    assert.match((await search('草稿石鸥')).join('\n'), /草稿石鸥/, 'A saved candidate remains searchable only in the manuscript corpus');
    const style = (await search('参考月舟', 'style-reference')).join('\n');
    assert.match(style, /参考月舟/); assert.match(style, /虚构参考作品.txt/); assert.doesNotMatch(style, /银叶雨馆|银叶世界/);
    assert.deepEqual(await search('银叶雨馆', 'style-reference'), []);
    const anyTerm = (await search('银叶 不存在藻石')).join('\n'); assert.match(anyTerm, /银叶雨馆/, 'Whitespace-separated literal terms use any-term matching');

    // 语义模式在未配置嵌入/索引时必须明确降级为关键词，并且索引面板如实说明不可用。
    await page.getByLabel('检索方式', { exact: true }).selectOption('semantic');
    await search('银叶');
    assert.match(await page.getByRole('status').filter({ hasText: '检索完成' }).first().innerText(), /（关键词）/);
    await page.locator('.knowledge-index summary').click();
    await page.getByRole('button', { name: '读取索引状态', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /尚未选择嵌入连接|尚未建立索引/ }).waitFor();
    await page.getByLabel('检索方式', { exact: true }).selectOption('keyword');

    // Every search uses a fresh source version; no persisted index may return old text.
    assert.match((await search('旧版石灯')).join('\n'), /旧版石灯/);
    await fs.writeFile(path.join(bookA, txtName), '银叶列车沿溪谷行进。\n独有新版冰灯。', 'utf8');
    assert.deepEqual(await search('旧版石灯'), []); assert.match((await search('新版冰灯')).join('\n'), /新版冰灯/);
    assert.deepEqual(await fs.readFile(path.join(bookA, docxName)), originalDocx);
    assert.deepEqual(await fs.readFile(path.join(bookA, candidateName)), candidateBytes);
    assert.deepEqual(await fs.readFile(referencePath), originalReference);
    for (let i = 0; i < materials.length; i++) if (materialBytes[i]) assert.deepEqual(await fs.readFile(path.join(data, '创作资料', projectA.id, materials[i])), materialBytes[i], `Searching must not rewrite ${materials[i]}`);

    // A dirty editor remains a draft and never becomes a retrieval source.
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.locator('.tiptap').fill('未保存紫贝草稿不能出现在知识检索。');
    await enterSearch(); assert.deepEqual(await search('未保存紫贝'), []);
    assert.match((await search('银叶雨馆')).join('\n'), /银叶雨馆/);
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    assert.match(await page.locator('.tiptap').textContent() ?? '', /未保存紫贝/);
    assert.deepEqual(await fs.readFile(path.join(bookA, docxName)), originalDocx);
    page.once('dialog', dialog => dialog.accept()); await openBook(bookB);
    const projectB = (await page.evaluate(() => window.writer.listProjects())).find(p => p.root === bookB)!;
    await enterSearch(); assert.equal(await page.locator('.knowledge-hit').count(), 0);
    const other = (await search('银叶')).join('\n'); assert.match(other, /银叶航线/); assert.doesNotMatch(other, /银叶雨馆|银叶世界|银叶信使/);
    assert.match(await page.locator('.project-heading').textContent() ?? '', /检索航线乙/);
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '检索学园甲 独立小说空间' }).click();
    await enterSearch(); assert.equal(await page.locator('.knowledge-hit').count(), 0);

    // A response delayed after backend completion cannot attach after an explicit stop.
    await app.evaluate(() => { (globalThis as any).__knowledgeHold = true; });
    await page.getByLabel('关键词', { exact: true }).fill('林夏');
    await page.getByRole('button', { name: '检索本书', exact: true }).click();
    await page.getByRole('button', { name: '停止检索', exact: true }).waitFor(); await waitForHeld();
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '正在处理' }).first().waitFor(); assert.equal(app.process().exitCode, null);
    await page.getByRole('button', { name: '停止检索', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '本次结果已丢弃' }).waitFor();
    const stopReply = (await counts()).searches; await release(); await settleReply(stopReply);
    assert.equal(await page.locator('.knowledge-hit').count(), 0);
    assert.match(await page.getByRole('status').filter({ hasText: '本次结果已丢弃' }).textContent() ?? '', /已停止/);

    // Switching books destroys the old result session even when its completed
    // backend reply arrives after the new book has mounted.
    await app.evaluate(() => { (globalThis as any).__knowledgeHold = true; });
    await page.getByLabel('关键词', { exact: true }).fill('林夏');
    await page.getByRole('button', { name: '检索本书', exact: true }).click(); await waitForHeld();
    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '检索航线乙 独立小说空间' }).click();
    const switchReply = (await counts()).searches; await release(); await settleReply(switchReply);
    await enterSearch(); assert.equal(await page.locator('.knowledge-hit').count(), 0);
    assert.equal((await page.evaluate(() => window.writer.listProjects())).find(p => p.id === projectB.id)?.name, '检索航线乙');
    const isolated = (await search('银叶')).join('\n'); assert.match(isolated, /银叶航线/); assert.doesNotMatch(isolated, /林夏|银叶雨馆/);

    await page.getByRole('button', { name: '写作空间', exact: true }).click();
    await page.getByRole('button', { name: '检索学园甲 独立小说空间' }).click();
    // DOCX external changes also replace the retrievable version without a UI reload.
    await fs.writeFile(path.join(bookA, docxName), await encodeDocx(textDocument('银叶雨馆已改为新位置。外部雪灯是当前版本。')));
    await enterSearch(); assert.deepEqual(await search('白色廊桥'), []);
    assert.match((await search('外部雪灯')).join('\n'), /外部雪灯/);
    await search('银叶');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.resolve('.artifacts/knowledge-search.png'), Buffer.from(png, 'base64'));
    assert.equal((await counts()).network, 0); assert.deepEqual(errors, []);
    console.log('Knowledge desktop passed: explicit local DOCX/TXT manuscript search, separate confirmed-material and reference corpora, saved candidates never treated as canon, literal any-term matching, excluded drafts/private text, fresh external versions, no source writes/network, two-book and delayed-stop/switch isolation, and renderer save/exit busy guard.');
  } finally { await release().catch(() => {}); await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
