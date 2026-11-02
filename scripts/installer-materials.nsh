; Called by electron-builder immediately before uninstalling the previous version.
; Do not use customInstall: that hook runs after the previous install was removed.
!define NOVEL_WRITER_INSTALLER_SCRIPTS "${__FILEDIR__}"
!ifndef NOVEL_WRITER_UPGRADE_DATA
  !define NOVEL_WRITER_UPGRADE_DATA "$APPDATA\novel-writer"
!endif
!macro NovelWriterProtectInstall SOURCE
  ${If} ${SOURCE} != ""
    InitPluginsDir
    File /oname=$PLUGINSDIR\protect-upgrade-materials.ps1 "${NOVEL_WRITER_INSTALLER_SCRIPTS}\protect-upgrade-materials.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\protect-upgrade-materials.ps1" -SourceInstall "${SOURCE}" -UserData "${NOVEL_WRITER_UPGRADE_DATA}"'
    Pop $R6
    Pop $R7
    ${If} $R6 != 0
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "无法安全继续安装或卸载。请先在星序（原小说编写器）中保存并退出，再重试。若仍失败，请核对应用数据目录中保留的资料升级备份；本次未继续删除旧安装。" /SD IDOK
      ${EndIf}
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro customCheckAppRunning
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  !ifdef BUILD_UNINSTALLER
    ; New uninstallers preserve legacy materials too; never kill an authoring process.
    !insertmacro NovelWriterProtectInstall "$INSTDIR"
  !else
    ; A previous shortcut and a different-named destination may both be user
    ; content. NSIS Rename would fail ambiguously or leave the wrong target;
    ; stop before uninstalling anything and preserve both entries.
    ${If} $oldDesktopLink != $newDesktopLink
    ${AndIf} ${FileExists} "$oldDesktopLink"
    ${AndIf} ${FileExists} "$newDesktopLink"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "旧桌面快捷方式与新名称的快捷方式同时存在。请先核对并手动处理名称冲突，安装已停止，两个快捷方式与现有程序均保留。" /SD IDOK
      ${EndIf}
      SetErrorLevel 2
      Abort
    ${EndIf}
    ${If} $oldStartMenuLink != $newStartMenuLink
    ${AndIf} ${FileExists} "$oldStartMenuLink"
    ${AndIf} ${FileExists} "$newStartMenuLink"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "旧开始菜单快捷方式与新名称的快捷方式同时存在。请先核对并手动处理名称冲突，安装已停止，两个快捷方式与现有程序均保留。" /SD IDOK
      ${EndIf}
      SetErrorLevel 2
      Abort
    ${EndIf}
    ; This build is per-user. Refuse machine-wide upgrades rather than migrate only
    ; the installing user's materials and remove another user's installation.
    ReadRegStr $R8 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R8 != ""
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "检测到为所有用户安装的旧版本。本测试版只支持当前用户安装，已停止升级以保护其他用户的创作资料。请先备份并单独处理旧版。" /SD IDOK
      ${EndIf}
      SetErrorLevel 2
      Abort
    ${EndIf}
    ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    !insertmacro NovelWriterProtectInstall "$R9"
    ; /D and the directory page can select a different root, which may also hold
    ; a legacy portable/manual installation. Guard both roots before either is touched.
    ${If} $R9 != $INSTDIR
      !insertmacro NovelWriterProtectInstall "$INSTDIR"
    ${EndIf}
  !endif
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
!macroend
