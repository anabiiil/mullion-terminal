; Adds "Open in Mullion Terminal" to Explorer's right-click menu: for any
; file, for a folder itself, and for a folder's empty background (so both
; right-clicking a folder and right-clicking inside one offer it). Keys are
; written under HKCU\Software\Classes so no elevation is required and each
; user's own choice is independent of other accounts on the machine.
;
; electron-builder inserts this file into the generated installer/uninstaller
; scripts (see the "nsis.include" setting in package.json) and calls the
; customInstall / customUnInstall macros below at the appropriate points.
; $appExe (= "$INSTDIR\${APP_EXECUTABLE_FILENAME}") is already set by the
; time customInstall runs. %1 expands to the clicked file's path; %V expands
; to the folder being opened (its own path for "Directory", the folder shown
; for "Directory\Background"). The app itself only ever treats that argument
; as a path to open a tab in or at — see electron/open-paths.cjs.

; Each location gets two verbs: "Open in Mullion Terminal (new tab)" adds
; tabs to the most recently used window, "Open in new Mullion Terminal window"
; passes --open-mode=window so the target opens in a window of its own.
!macro MullionOpenWithKeys root command
  WriteRegStr HKCU "Software\Classes\${root}\shell\MullionTerminal" "" "Open in Mullion Terminal (new tab)"
  WriteRegStr HKCU "Software\Classes\${root}\shell\MullionTerminal" "Icon" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\${root}\shell\MullionTerminal\command" "" '"$appExe" --open-mode=tab "${command}"'
  WriteRegStr HKCU "Software\Classes\${root}\shell\MullionTerminalWindow" "" "Open in new Mullion Terminal window"
  WriteRegStr HKCU "Software\Classes\${root}\shell\MullionTerminalWindow" "Icon" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\${root}\shell\MullionTerminalWindow\command" "" '"$appExe" --open-mode=window "${command}"'
!macroend

!macro MullionRemoveOpenWithKeys root
  DeleteRegKey HKCU "Software\Classes\${root}\shell\MullionTerminal"
  DeleteRegKey HKCU "Software\Classes\${root}\shell\MullionTerminalWindow"
!macroend

!macro customInstall
  !insertmacro MullionOpenWithKeys "*" "%1"
  !insertmacro MullionOpenWithKeys "Directory" "%V"
  !insertmacro MullionOpenWithKeys "Directory\Background" "%V"
!macroend

; The app registers its mullion-terminal:// link scheme for the current user
; at runtime (app.setAsDefaultProtocolClient); the uninstaller removes it.
!macro customUnInstall
  !insertmacro MullionRemoveOpenWithKeys "*"
  !insertmacro MullionRemoveOpenWithKeys "Directory"
  !insertmacro MullionRemoveOpenWithKeys "Directory\Background"
  DeleteRegKey HKCU "Software\Classes\mullion-terminal"
!macroend
