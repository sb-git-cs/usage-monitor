Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("Wscript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
exe = root & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  WScript.Quit 1
End If
sh.CurrentDirectory = root
sh.Run """" & exe & """ """ & root & """", 0, False
