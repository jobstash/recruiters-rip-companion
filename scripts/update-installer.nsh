; Never let electron-builder's default CHECK_APP_RUNNING kill a live Companion,
; including an unrelated installation. The updater drains its own work and exits
; before starting NSIS; any remaining instance must be closed by its user.
!macro customCheckAppRunning
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    IfSilent companion_running_quit
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close Recruiters.rip Companion before installing this update. Your saved work has not been changed."
    companion_running_quit:
    SetErrorLevel 2
    Quit
  ${endif}
!macroend
