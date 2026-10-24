; Adds / removes "Open in Revqora" in the Explorer context menu of folders.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\Revqora" "" "Open in Revqora"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Revqora" "Icon" "$INSTDIR\revqora.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Revqora\command" "" '"$INSTDIR\revqora.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Revqora" "" "Open in Revqora"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Revqora" "Icon" "$INSTDIR\revqora.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Revqora\command" "" '"$INSTDIR\revqora.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Revqora"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Revqora"
!macroend
