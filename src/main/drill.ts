import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from './workspace';
import { textDocument } from './text-import';
import { encodeDocx } from './docx';
import { normalizeParagraphs } from '../core/typography';

export interface DrillStep { name: string; ok: boolean; detail: string }
export interface DrillReport { ok: boolean; steps: DrillStep[]; at: string }
const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text' as const, text }] }] });

/** 在临时目录里复现两种断网/冲突场景，确认"不丢稿、不覆盖远端"这条底线在真机上仍然成立。
 * 只用临时目录，绝不碰作者真实小说；结果直接回给界面。 */
export async function runOfflineDrill(): Promise<DrillReport> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-drill-'));
  const steps: DrillStep[] = [];
  try {
    const local = path.join(root, 'local');
    const workspace = new Workspace(local, path.join(root, 'materials'));
    await workspace.initialize();
    const book = path.join(root, '演练书'); await fs.mkdir(book);
    const project = await workspace.attach(book);
    const chapter = await workspace.createChapter(project.id, textDocument('　　演练用虚构正文。'));
    const drafts = async () => (await fs.readdir(path.join(local, 'recovery', project.id)).catch(() => [] as string[])).filter(name => /-draft\./u.test(name));

    // 场景一：外部改动 → 拒写、远端不变、草稿已落盘
    const file = path.join(project.root, chapter.path);
    // 用一份「内容不同但仍是合法 DOCX」的文件模拟同步客户端把旧版本写回来。
    await fs.writeFile(file, await encodeDocx(normalizeParagraphs(doc('　　外部程序写回的内容。'))));
    const before = await fs.readFile(file);
    let rejected = false, message = '';
    try { await workspace.saveChapter({ projectId: project.id, path: chapter.path, expectedHash: chapter.hash, content: doc('　　演练新句子。') }); }
    catch (error) { rejected = true; message = (error as Error).message; }
    const after = await fs.readFile(file);
    const draftCount = (await drafts()).length;
    steps.push({
      name: '外部改动时拒绝覆盖', ok: rejected && Buffer.compare(before, after) === 0 && draftCount >= 1,
      detail: rejected ? `${message.slice(0, 40)}；本机草稿 ${draftCount} 份` : '没有拒绝写入'
    });

    // 场景二：目录消失（映射盘掉线）→ 可读提示、草稿仍在本机
    const moved = `${book}-offline`;
    await fs.rename(book, moved);
    let offlineMessage = '', offlineRejected = false;
    try { await workspace.saveChapter({ projectId: project.id, path: chapter.path, expectedHash: chapter.hash, content: doc('　　断网期间写的字。') }); }
    catch (error) { offlineRejected = true; offlineMessage = (error as Error).message; }
    const draftsAfterOffline = (await drafts()).length;
    steps.push({
      name: '网络目录不可用时保住草稿', ok: offlineRejected && /恢复区/u.test(offlineMessage) && draftsAfterOffline > draftCount,
      detail: offlineRejected ? `${offlineMessage.slice(0, 48)}；草稿累计 ${draftsAfterOffline} 份` : '没有报错'
    });
    await fs.rename(moved, book);

    // 场景三：恢复后可以继续写作——被外部改动过的章节仍受保护，新章节保存正常。
    let guarded = '', recovered = false, recoveryDetail = '';
    try { await workspace.saveChapter({ projectId: project.id, path: chapter.path, expectedHash: chapter.hash, content: doc('　　重连后直接覆盖。') }); }
    catch (error) { guarded = (error as Error).message; }
    try {
      const fresh = await workspace.createChapter(project.id, textDocument('　　重连后的新章节。'));
      await workspace.saveChapter({ projectId: project.id, path: fresh.path, expectedHash: fresh.hash, content: doc('　　重连后写的新句子。') });
      recovered = true;
    } catch (error) { recoveryDetail = (error as Error).message.slice(0, 60); }
    steps.push({
      name: '恢复后继续写作', ok: recovered && /已被其他程序修改|另存副本|无法写入|网络/u.test(guarded),
      detail: recovered ? `新章节保存成功；被外部改动的章节仍拒绝直接覆盖（${guarded.slice(0, 26)}）` : recoveryDetail
    });
    return { ok: steps.every(step => step.ok), steps, at: new Date().toISOString() };
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
