; Tauri NSIS 自定义安装钩子（tauri.conf.json > bundle.windows.nsis.installerHooks 引入）
; 覆盖安装/卸载时，应用拉起的内置后端 node.exe 不在 Tauri 模板的关进程逻辑里，
; 文件占用会导致覆盖安装报 “Error opening file for writing”（issue #1）——安装/卸载前先清场。
!macro _as_kill_locked
  ; 关闭主程序（/T 连带结束它拉起的 node 子进程）
  nsExec::Exec 'taskkill /F /IM agentsessions.exe /T'
  ; 兜底：仅杀安装目录下的 node（应用崩溃后的孤儿后端），不误伤用户其他 node 进程
  nsExec::Exec `powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '$INSTDIR*' } | Stop-Process -Force"`
  Sleep 600
!macroend
!macro NSIS_HOOK_PREINSTALL
  !insertmacro _as_kill_locked
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _as_kill_locked
!macroend
