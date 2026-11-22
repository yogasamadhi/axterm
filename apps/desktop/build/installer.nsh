!macro customOldUninstaller
  # Older Level 3 uninstallers followed dependency junctions during recursive removal.
  ${If} ${FileExists} "$installationDir\resources\app\node_modules\.axterm\*.*"
  ${AndIfNot} ${FileExists} "$installationDir\resources\axterm-junction-safe-uninstaller"
    File /oname=$PLUGINSDIR\old-uninstaller.exe "${UNINSTALLER_OUT_FILE}"
    StrCpy $uninstallerFileName "$uninstallerFileNameTemp"
  ${Else}
    !insertmacro copyFile "$uninstallerFileName" "$uninstallerFileNameTemp"
  ${EndIf}
!macroend

!macro customUnInstall
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntOp $0 $0 & 0x410
  ${If} $0 != 16
    Abort "The Axterm installation directory is not a physical directory."
  ${EndIf}
!macroend

!macro customAtomicUninstallEntry
  # Leave links in place until the atomic move of the physical files has succeeded.
  Push $0
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR$R0\$R2") i.r0'
  IntOp $0 $0 & 0x400
  ${If} $0 != 0
    Pop $0
    Goto continue
  ${EndIf}
  Pop $0
!macroend

!macro customDeleteUninstallTree
  Push "$INSTDIR"
  Call un.axtermDetachLinks
  Pop $R0
  ${If} $R0 != 0
    Abort "Axterm could not remove a runtime directory link."
  ${EndIf}
  ClearErrors
  RMDir /r "$INSTDIR"
  # During an upgrade the parent installer may hold the empty root as its working directory.
  StrCpy $1 ""
  FindFirst $0 $1 "$INSTDIR\*"
  ${DoWhile} $1 != ""
    ${If} $1 != "."
    ${AndIf} $1 != ".."
      FindClose $0
      Abort "Axterm could not remove its installation files."
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
  ClearErrors
!macroend

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    # NSIS RMDir /r follows junctions. Remove the link itself with a shallow operation.
    Function un.axtermDetachLinks
      Exch $0
      Push $1
      Push $2
      Push $3
      Push $4
      Push $5
      ClearErrors
      FindFirst $1 $2 "$0\*"
      IfErrors axtermDetachFailed
      ${DoWhile} $2 != ""
        ${If} $2 != "."
        ${AndIf} $2 != ".."
          StrCpy $3 "$0\$2"
          System::Call 'kernel32::GetFileAttributesW(w r3) i.r4'
          ${If} $4 == -1
            Goto axtermDetachFailed
          ${EndIf}
          IntOp $5 $4 & 0x400
          IntOp $4 $4 & 0x10
          ${If} $5 != 0
            ClearErrors
            ${If} $4 != 0
              RMDir "$3"
            ${Else}
              Delete "$3"
            ${EndIf}
            IfErrors axtermDetachFailed
          ${ElseIf} $4 != 0
            Push "$3"
            Call un.axtermDetachLinks
            Pop $4
            ${If} $4 != 0
              Goto axtermDetachFailed
            ${EndIf}
          ${EndIf}
        ${EndIf}
        FindNext $1 $2
      ${Loop}
      StrCpy $0 0
      Goto axtermDetachDone
      axtermDetachFailed:
        StrCpy $0 1
      axtermDetachDone:
      FindClose $1
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Exch $0
    FunctionEnd
  !endif
!macroend

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
      FileOpen $0 "$INSTDIR\resources\axterm-junction-safe-uninstaller" w
      IfErrors axtermRuntimeReady
      FileClose $0
      Goto axtermRuntimeReady
    ${EndIf}
  ${EndIf}
  MessageBox MB_OK|MB_ICONSTOP "Axterm runtime setup failed." /SD IDOK
  SetErrorLevel 1
  Quit
  axtermRuntimeReady:
!macroend
