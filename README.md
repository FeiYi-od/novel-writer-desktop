# 星序 / starwriting

Windows DOCX 小说写作工作台，支持多作品隔离、模型辅助写作、审稿和人物/世界观资料。

[下载安装包](https://github.com/FeiYi-od/novel-writer-desktop/releases) · [本版变化](docs/RELEASE_NOTES_BETA18.md) · [验收与升级](docs/BETA18_ACCEPTANCE.md)

普通使用下载同版 starwriting Windows x64 安装包，无需安装开发环境。源码 ZIP 用于开发；同页 SHA256SUMS.txt 提供完整性校验。

当前测试版本：0.1.1-beta.18。默认宋体五号、段首两个真实全角空格；正文默认 DOCX，创作资料固定保存 Markdown。

安装包不包含任何作者的 NAS 地址、账号、API 密钥或小说。模型连接由使用者分别配置。

## 开发

需要 Node.js、pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm dist
```

桌面回归：`pnpm test:desktop-all`。仅使用临时虚构数据和本机模拟模型；需要真实账号的接口不由这些测试证明可用。

当前支持普通文件夹、同步目录、映射盘和挂载目录。固定资料可通过本书的传输快照，在打开及保存退出时核对；参见[固定资料同步](docs/MATERIAL_SYNC.md)。外部客户端负责文件传输，各网盘直连API尚未完成。参见 [目录兼容](docs/STORAGE_COMPATIBILITY.md)与[两机验收](docs/SECOND_WINDOWS_ACCEPTANCE.md)。

外部复杂 Word 通过受限制的正文副本编辑保存；原稿保留。不能替代全部 Word 功能。酒馆数据适配不等同于完整浏览器插件运行。

源码按 AGPL-3.0-only 提供；参见 LICENSE 与 THIRD_PARTY_NOTICES.md。
