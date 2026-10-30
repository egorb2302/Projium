Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
sh.CurrentDirectory = dir
sh.Run "cmd /c node --no-warnings server.mjs >> data\out.log 2>> data\err.log", 0, False
