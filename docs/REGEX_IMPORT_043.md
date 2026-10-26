# 社区正则JSON导入与原件保留

更新：2026-10-26 / beta.5包含043单条/批量/scripts导入、原始JSON保留及兼容报告，以及042隔离预览。beta.4及更早版本不包含；本版实际ASAR的单条导入和Worker行为也已验证，见[beta.5验收](BETA5_ACCEPTANCE.md)。下方043验证保留为开发阶段记录。

## 参考格式

核对官方SillyTavern固定提交 `06bde939fb1e9c4c8d8641d810f0a916b5bce127`：单条导出把一个脚本对象写成JSON，批量导出把选中脚本组成的数组写成JSON。对应实际下载源码的[单条导出](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/regex/index.js#L700-L704)和[批量导出](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/regex/index.js#L1900-L1909)。网页正文提取器可能移除空行，行号应以固定源码文件为准。

本批兼容三种输入：

| 形状 | 内容 |
| --- | --- |
| 单条对象 | 对象本身包含 `findRegex` 或兼容的 `find_regex` |
| 批量数组 | 按数组顺序排列的脚本对象 |
| `scripts`包装 | 本应用既有格式及兼容包装；存在版本或小说归属字段时必须通过检查 |

脚本的 `id` 是脚本标识，`scriptName` 是描述元数据，不能拿来替代小说的 `projectId`。只有预设引用、缺少查找表达式或未知版本的对象，不能悄悄当作空脚本导入。

## 导入与手工预览

1. 在本书打开“宏与正则…”，选择“导入正则脚本…”，使用临时虚构数据先核对格式。JSON最多1MiB；只读取授权选择的普通文件，拒绝链接、无效UTF-8和超限输入。
2. 导入成功时查看识别形状、条数、原件路径及SHA-256。格式化空白、UTF-8 BOM和未知字段都随选中文件的原始字节保存，活动脚本只采用当前实现支持的字段。
3. 查看未用于执行的字段报告。字段名显示有数量和长度上限，报告总数与显示样本分开；原始JSON中的完整字段和值保留在原件中，界面不把它们作为HTML或JavaScript运行。
4. 填写角色名和测试文本，点击“预览”。当前手工预览支持查找、替换、禁用、flags及捕获内容的trim；既有别名和替换语义见[034兼容说明](REGEX_COMPATIBILITY_034.md)。仍采用[042隔离执行](REGEX_ISOLATION.md)的超时、取消、输入输出预算和迟到结果保护。

预览仅返回本书、本次请求的纯文本对照，不改写正文、人物卡、世界观或故事正史，也不调用模型。输入中引用的未知宏仍保持可见。

## 原始JSON副本和清单

原始JSON单独保存在本书：

`小说资料/正则导入原件/<UUID>/原始正则.json`

同目录的 `manifest.json` 使用 `schemaVersion:1`、`kind:regex-import-source`，记录小说归属、原文件大小、SHA-256、识别形状、脚本数量及字段报告。原件目录是新建的独立副本，不以覆盖其他原件的方式保存。

该清单证明的是**原始JSON副本的内容和来源归属**。它不代表随后活动脚本已经替换成功，也不代表这些脚本在完整酒馆中已经通过运行验收。导入后应结合界面的结果与当前脚本预览确认；只有原件清单存在时，不能推断导入成功。

替换既有活动脚本时，继续先在 `小说资料/正则脚本历史/` 保留原文件原字节，再检查当前版本和暂存。错书、未知目标版本、链接或保存期间外变应明确停止；原件、历史及失败暂存按保护规则保留，不通过清空资料来消除提示。

## 兼容边界

`placement`、`markdownOnly`、`promptOnly`、`runOnEdit`、深度范围、查找模式宏替换及global/preset/scoped优先级属于上游执行条件或生命周期能力。当前手工预览不调度这些条件；相关数据与扩展字段保留在导入原件，并在报告中说明未用于执行。其含义可在固定提交的[上游引擎](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/regex/engine.js)复核。

保留一份社区原始JSON，不会自动把它注册为完整插件、给它模型或文件操作权限，也不会把其中的设定或草稿确认成故事事实。完整酒馆插件生命周期和端到端兼容仍待完成。

## 固定来源、许可与验证状态

本次只读参考为上述固定提交的 `index.js` 和 [LICENSE](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/LICENSE)。LICENSE为GNU Affero General Public License Version 3；许可范围以固定文件原文为准。本项目做数据格式适配，未执行下载的上游JavaScript。

| 只读文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `index.js` | 85,485 | `7a43b7d6e40a1b6f38a8a7c53a4d552e1aa56c4a13e893224fddf79b663ecb7f` |
| `LICENSE` | 34,523 | `8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef` |

本机只读副本与下载记录位于 `.artifacts/regex-reference-043/`，不随安装包发布。未运行上游插件代码。

043验证：52项相关核心（新增20格式/11原件保存及原有21 Store/安全回归）、完整863核心均通过，0失败/跳过；类型检查和构建通过。6套不同桌面通过：新社区导入、旧宏、正则兼容、隔离预览、保存退出和固定同步。只用虚构小说，核对BOM/CRLF/扩展字段及清单SHA、原raw历史、未执行HTML字段的纯文本、三形状预览、错书响应、同名双书、取消及保存重开，原稿和canonical原字节保持。

新原件/清单在最终活动版本复核期间外变的两个确定性回归先失败，补充副本与活动文件的相互复核后通过，失败证据保留。这是发布前检查与备份保护，不是跨文件原子事务承诺；原件副本清单不能单独证明活动脚本替换成功。不测试真实账号、真实小说或收费服务。
