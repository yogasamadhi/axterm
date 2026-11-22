!macro customInstall
  System::Call 'Kernel32::SetEnvironmentVariable(t "NODE_OPTIONS", p 0)'
  System::Call 'Kernel32::SetEnvironmentVariable(t "NODE_PATH", p 0)'
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1") i.r0'
  ${If} $0 != 0
    nsExec::ExecToLog /TIMEOUT=60000 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\axterm-restore-runtime-links.mjs"'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
    ${If} $0 == "0"
      Delete "$INSTDIR\resources\axterm-restore-runtime-links.mjs"
      Delete "$INSTDIR\resources\axterm-runtime-links.json"
      Goto axtermRuntimeReady
    ${EndIf}
  ${EndIf}
  MessageBox MB_OK|MB_ICONSTOP "Axterm runtime setup failed." /SD IDOK
  SetErrorLevel 1
  Quit
  axtermRuntimeReady:
!macroend
