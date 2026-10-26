# 酒馆正则数据兼容 / 034

当前补充（2026-10-26 / beta.5）：预览已改为可终止Worker，增加超时、取消和输入输出上限，详见[正则隔离说明](REGEX_ISOLATION.md)。下方034为历史语义对照记录，其“同步执行/无超时”限制已由042补齐；完整酒馆插件生命周期仍未实现。beta.5包含042/043，beta.4尚不包含。

043再补[单条/批量/scripts导入及原始JSON保留](REGEX_IMPORT_043.md)，不再只接受数组。未执行字段在报告中列出，完整原始JSON独立保存；下方034的字段保留边界为当时记录。[beta.5验收](BETA5_ACCEPTANCE.md)记录本版实际包验证。

更新：2026-10-22。本批仅实现作者主动导入 JSON 后的“宏与正则”预览，不运行上游插件，不改写正文、不调用模型。

## 固定来源

官方 SillyTavern，固定提交 `06bde939fb1e9c4c8d8641d810f0a916b5bce127`：

- [regex/engine.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/regex/engine.js)：`runRegexScript`、`filterString`，核对捕获替换和 trim 范围。
- [utils.js](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/utils.js)：`regexFromString`，核对导出的斜线表达式与 flags。
- [LICENSE](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/LICENSE)：GNU AGPL-3.0。实现为本项目的独立适配，源码发行沿用项目 AGPL 许可及来源说明；未执行下载的上游源码。

只读下载 SHA-256：engine.js `091bb3402a12552cf1754d6e4d2b44df38d3553aa374539896c716e78905d350`；utils.js `2a2cfe240d5a84ce2e09ba053db6c0c71473b6406173f614f3521d89f50ada61`。临时副本在 `.artifacts/regex-reference-034/`。

## 已实现与差异

| 数据行为 | 本批实现 |
| --- | --- |
| `/pattern/flags` | 使用自身 flags，支持转义斜线、多行和 dotAll。非法表达式/flags 仅跳过当前脚本。 |
| bare pattern | 不再擅自添加 `giu`，默认单次、区分大小写；有意义的模式空格保留。本项目旧 `flags` 字段继续支持（包括空字符串）。 |
| 捕获替换 | `{{match}}`、`$0`、`$1` 至多位编号、`$<name>`；缺省/不存在捕获为空，不会把偏移量或整段输入误当捕获。 |
| `trimStrings` | 仅清理模板引用的完整匹配/捕获组。未匹配原文、模板字面量保持；没有匹配时原文完全不变。 |
| 宏上下文 | 替换模板和 trim 条目支持现有宏子集；未知宏原样保留。请求开始冻结书和角色上下文，书间脚本隔离。 |
| 本地扩展 | `$&` 为本地完整匹配别名；上游当前自定义回调将它保留为字面量，这不是完全一致行为。前后缀引用及双美元符号不套用 JavaScript 原生字符串替换的特殊语义。 |
| 持久化 | 新文件 `{schemaVersion:1,scripts:[...]}`；兼容旧数组/旧 scripts 包装，拒绝未知 schemaVersion。空/非法 flags 保留，避免静默换用其他 flags。 |

范围：16 行核心矩阵，包含顺序应用、禁用/坏脚本、默认与显式 flags、捕获/命名/多位编号、局部清理及美元字符。另有存储/宏上下文/版本/双书隔离回归。沿用界面现有 20,000 字符输入上限，没有新增任意脚本长度限制。

未实现：`substituteRegex` 查找模式宏扩展、完整宏系统、placement/promptOnly/markdownOnly/depth/runOnEdit 生命周期调度、global/preset/scoped 优先级、Overlay 替换策略及完整社区插件运行。当前导入仅保留本预览支持字段，其余字段不执行；不能把“预览通过”视为卡内脚本全生态兼容。JavaScript 正则仍可能因恶意回溯阻塞，本批不声称具备隔离执行或超时终止。

## 验证记录

- 改源码前追加首轮 14 行矩阵，其中 11 行真实失败；Node 含父用例统计为 19 tests、7 pass、12 fail。日志 `.artifacts/regex-034-before.log`。
- 改 MacroStore 前追加 4 用例，4 项真实失败，原 3 项通过。日志 `.artifacts/regex-store-034-before.log`。
- 修复后加空格模式和美元捕获两行，相关核心 **28/28 通过**；`tsc --noEmit` 通过。日志 `.artifacts/regex-034-after.log`。
- `tests/macro-desktop.ts` 已纠正旧“全局去除捕获组外 trim 字符”的错误预期；新增 `tests/regex-compat-desktop.ts` 验证真实 UI 导入/预览/本地落盘及第二书空脚本。034统一构建后，两套桌面均已实际通过，结果见 `.artifacts/desktop-related-034.log`（本批11套相关桌面通过）；完整620核心通过，未运行完整上游插件。

仅用临时虚构数据，未使用真实小说、用户密钥或外部收费服务。
