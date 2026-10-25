import * as fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

async function main() {
  const root = process.cwd(), version = JSON.parse(await fs.readFile('package.json', 'utf8')).version as string;
  const stage = path.resolve('.artifacts', `release-source-${version}-${Date.now()}`);
  await fs.mkdir(stage); const zip = new JSZip();
  const allowedFile = /\.(?:tsx?|mjs|css|html|json|ps1|nsh)$/u;
  async function add(relative: string, generated?: string) {
    const file = path.resolve(root, relative), output = path.resolve(stage, relative);
    if (!output.startsWith(stage + path.sep)) throw new Error('Invalid source path');
    if (generated === undefined && (await fs.lstat(file)).isSymbolicLink()) throw new Error('Source symlink rejected');
    const bytes = generated === undefined ? await fs.readFile(file) : Buffer.from(generated);
    // Credentials must never enter a source release, even in a test fixture.
    if (/\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[opsu]_[a-zA-Z0-9_]{25,})\b/u.test(bytes.toString('utf8')))
      throw new Error(`Credential-shaped value in ${relative}; publication stopped`);
    await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, bytes, { flag: 'wx' });
    zip.file(relative.split(path.sep).join('/'), bytes);
  }
  async function directory(relative: string) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source symlink rejected');
      if (entry.isDirectory()) await directory(next); else if (allowedFile.test(entry.name)) await add(next);
    }
  }
  for (const folder of ['src', 'tests', 'scripts']) await directory(folder);
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'electron.vite.config.ts', 'electron-builder.yml', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/licenses/ASTRBOT_AGPL-3.0.txt', 'docs/STORAGE_COMPATIBILITY.md', 'docs/SECOND_WINDOWS_ACCEPTANCE.md', 'docs/DOCX_FIDELITY.md']) await add(file);
  for (const file of ['docs/MATERIAL_SYNC.md', 'docs/MATERIAL_HISTORY.md', 'docs/PROJECT_RECORD_STORAGE_034.md', 'docs/REGEX_COMPATIBILITY_034.md']) await add(file);
  for (const file of ['docs/BETA2_ACCEPTANCE.md', 'docs/INSTALLER_SAFETY.md']) await add(file);
  await add('docs/RELEASE_NOTES_BETA2.md');
  for (const file of ['docs/BETA3_ACCEPTANCE.md', 'docs/RELEASE_NOTES_BETA3.md']) await add(file);
  await add('.gitignore', 'node_modules/\nout/\nrelease/\n.artifacts/\n创作资料/\n.env*\n');
  await add('README.md', `# 小说编写器 / Novel Writer\n\nWindows DOCX 小说写作工作台，支持多作品隔离、模型辅助写作、审稿和人物/世界观资料。\n\n当前测试版本：${version}。默认宋体五号、段首两个真实全角空格；正文默认 DOCX，创作资料固定保存 Markdown。\n\n安装包不包含任何作者的 NAS 地址、账号、API 密钥或小说。模型连接由使用者分别配置。\n\n## 开发\n\n需要 Node.js、pnpm。\n\n\`\`\`powershell\npnpm install --frozen-lockfile\npnpm typecheck\npnpm test\npnpm build\npnpm dist\n\`\`\`\n\n桌面回归：\`pnpm test:desktop-all\`。仅使用临时虚构数据和本机模拟模型；需要真实账号的接口不由这些测试证明可用。\n\n当前支持普通文件夹、同步目录、映射盘和挂载目录。固定资料可通过本书的传输快照，在打开及保存退出时核对；参见[固定资料同步](docs/MATERIAL_SYNC.md)。外部客户端负责文件传输，各网盘直连API尚未完成。参见 [目录兼容](docs/STORAGE_COMPATIBILITY.md)与[两机验收](docs/SECOND_WINDOWS_ACCEPTANCE.md)。\n\n外部复杂 Word 通过受限制的正文副本编辑保存；原稿保留。不能替代全部 Word 功能。酒馆数据适配不等同于完整浏览器插件运行。\n\n源码按 AGPL-3.0-only 提供；参见 LICENSE 与 THIRD_PARTY_NOTICES.md。\n`);
  const archive = stage + '.zip';
  await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), { flag: 'wx' });
  console.log(JSON.stringify({ stage, archive, files: Object.values(zip.files).filter(file => !file.dir).length }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Source preparation failed'); process.exitCode = 1; });
