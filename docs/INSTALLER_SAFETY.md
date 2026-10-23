# 安装升级与资料保护

更新：2026-10-23。此页说明保护设计和上游挂钩位置；实际安装包编译、虚构夹具测试与真实升级结果须在对应发布记录单独列出，不能仅凭本页视作验证通过。

## 为什么要改资料位置

旧版把固定 Markdown 资料保存在可执行程序旁的 `创作资料/<projectId>/`。electron-builder 26.15.3 的 NSIS 卸载器默认删除整个安装目录，`deleteAppDataOnUninstall: false` 只控制应用数据目录，不保护安装目录旁的作者文件。升级路径中的 `un.atomicRMDir` 也是移动到插件临时目录后删除，不能当作持久资料备份。

新版固定目录使用 `%APPDATA%\novel-writer\创作资料/<projectId>/`。测试环境仍使用明确隔离的临时应用数据目录。小说正文仍在作者选择的文件夹。安装程序不打包任何运行时资料、模型配置或密钥。

## 安装阶段保护

`scripts/installer-materials.nsh` 使用 `customCheckAppRunning`，在实际开始安装、卸载旧版前运行 PowerShell 保护脚本。脚本以文件参数接收路径，无内联 PowerShell 命令，也不显示控制台窗口。它检查旧应用是否仍运行；需要作者先保存退出，不强杀写作进程。

保护对象包括 HKCU 注册表的实际旧安装根以及本次选择的安装根。两者可能因 `/D` 或安装目录页不同，不能仅检查新的 `$INSTDIR`。发现 HKLM 中为所有用户安装的旧版时，本版明确停止，避免只迁移当前用户后卸载其他用户的资料。新卸载器也检查其自身安装根。

旧固定资料先备份至应用数据目录的 `material-upgrade-backups/<UUID>/`，逐文件核对完整哈希后，再按保护脚本的空目标与既有迁移凭据规则处理。备份保留，不因安装完成自动清除。未知目录状态、链接、源变化、正在运行的应用或校验失败均停止后续卸载。正常资料目录发生冲突时，不能强行合并或用空资料替代。

便携打包脚本同样不再删除既有输出目录或 ZIP：必须选新路径，源/输出/ZIP/工作目录不得危险重叠，拒绝目录链接和源包中的意外运行时目录。归档名称从 `package.json` 读取版本。已有便携版及其旁边资料始终留给作者核对。

## 上游位置与时序

以下为本机依赖 `app-builder-lib@26.15.3/templates/nsis/` 的固定版本代码位置：

- `installer.nsi:57–86`：`preInit` 早于注册表视图和多用户初始化，`customInit` 在 `.onInit` 中；两者都早于安装目录页的最后选择。
- `installSection.nsh:33–54`：`CHECK_APP_RUNNING` 在实际安装阶段运行，随后调用 `uninstallOldVersion`。
- `include/allowOnlyOneInstallerInstance.nsh:32–43`：`customCheckAppRunning` 替换默认检查逻辑；默认逻辑有强杀分支，因此本应用单独实现安全检查。
- `multiUser.nsh:25–28`、`include/installUtil.nsh:166–178`：从 `INSTALL_REGISTRY_KEY/InstallLocation` 获取实际旧安装位置，卸载器可从注册表的卸载命令回退定位。
- `uninstaller.nsh:160–187`：默认清理包含整个安装目录；`232–243` 才是 AppData 删除分支。
- `installSection.nsh:83–85`：`customInstall` 在旧版卸载和新文件写入之后，来不及保护旧资料。

上游源码：[electron-builder 的 NSIS 模板](https://github.com/electron-userland/electron-builder/tree/v26.15.3/packages/app-builder-lib/templates/nsis)。本批仅依据本机固定依赖定位，未访问用户账户或远端小说。

## 本地便携打包验证

`tests/portable-package.test.ts` 在 `.artifacts` 虚构目录验证旧输出资料保留、既有ZIP拒绝、路径重叠拒绝、意外运行时目录拒绝、Unicode新路径成功打包和目录链接拒绝。该用例不启动夹具可执行文件，也不改真实安装位置。
