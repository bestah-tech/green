' =====================================================================
' TRADEMARK search.vbs - IE auto search (DRAFT / v1)
' ---------------------------------------------------------------------
' What it does:
'   1. Finds the already-open "smart search" IE window ( /ts/ or Kipo.ts ).
'   2. Reads TmQueries.txt (exported from TRADEMARK side panel) in the
'      same folder as this script. Line format: label<TAB>TmName<TAB>ClassCd
'   3. For each query: loads the similar-name search URL into the
'      content_iframe, waits, extracts the result text.
'   4. Appends everything to TmResults.txt (UTF-8) in the same folder.
'      -> Paste that file's content into the TRADEMARK side panel
'         ("paste collect") to register candidates.
'
' How to run:
'   - Open the search system in IE first (login via checklist as usual).
'   - Put this file and TmQueries.txt in the same folder (e.g. Desktop).
'   - Set APPL_NO below (application number, digits only, no hyphen).
'   - Double-click search.vbs.
'
' NOTE: This is a DRAFT. The wait time and iframe name may need
'       adjustment after the first on-site test. Keep comments ASCII -
'       WSH does not read UTF-8 vbs files correctly.
' =====================================================================
Option Explicit

' ------------------ settings (edit before run) -----------------------
Dim APPL_NO: APPL_NO = ""            ' e.g. "4020250012345" (no hyphen). "" = omit
Dim SEARCH_PATH                       ' similar-name search (SimLevel=1)
SEARCH_PATH = "/ts/search/fgreSrch/mainSimilarSrch.do?f_name=Y905&BtNo=4&SimLevel=1&ClassDv=0&BisEmYn=1&ClSmYn=0"
Dim LOAD_WAIT_MS: LOAD_WAIT_MS = 2500 ' extra wait after page ready (ms)
Dim MAX_WAIT_S: MAX_WAIT_S = 60       ' max wait per search (seconds)
' ---------------------------------------------------------------------

Dim fso: Set fso = CreateObject("Scripting.FileSystemObject")
Dim here: here = fso.GetParentFolderName(WScript.ScriptFullName)
Dim inFile: inFile = here & "\TmQueries.txt"
Dim outFile: outFile = here & "\TmResults.txt"

If Not fso.FileExists(inFile) Then
  MsgBox "TmQueries.txt not found in: " & here, vbExclamation, "TRADEMARK"
  WScript.Quit
End If

' ---- find the smart-search IE window --------------------------------
Dim shellApp: Set shellApp = CreateObject("Shell.Application")
Dim ie: Set ie = Nothing
Dim w
For Each w In shellApp.Windows
  On Error Resume Next
  Dim loc: loc = ""
  loc = w.LocationURL
  If InStr(loc, "/ts/") > 0 Or InStr(loc, "Kipo.ts") > 0 Then
    Set ie = w
  End If
  On Error GoTo 0
Next
If ie Is Nothing Then
  MsgBox "Search-system IE window not found." & vbCrLf & _
         "Open the search system in IE first (via the checklist), then run again.", _
         vbExclamation, "TRADEMARK"
  WScript.Quit
End If

' base = protocol + host(:port) of the found window
Dim base: base = ie.LocationURL
Dim p: p = InStr(base, "://")
p = InStr(p + 3, base, "/")
If p > 0 Then base = Left(base, p - 1)

' ---- helpers --------------------------------------------------------
Dim htmlDoc: Set htmlDoc = CreateObject("htmlfile")
htmlDoc.parentWindow.execScript "function __enc(s){return encodeURIComponent(s);}", "javascript"
Function UrlEnc(s)
  UrlEnc = htmlDoc.parentWindow.__enc(s)
End Function

Function ReadUtf8(path)
  Dim st: Set st = CreateObject("ADODB.Stream")
  st.Type = 2: st.Charset = "utf-8": st.Open: st.LoadFromFile path
  ReadUtf8 = st.ReadText: st.Close
End Function

Sub AppendUtf8(path, text)
  Dim old: old = ""
  If fso.FileExists(path) Then old = ReadUtf8(path)
  Dim st: Set st = CreateObject("ADODB.Stream")
  st.Type = 2: st.Charset = "utf-8": st.Open
  st.WriteText old & text
  st.SaveToFile path, 2 ' overwrite
  st.Close
End Sub

Function GetContentDoc()
  ' returns the result document: content_iframe if present, else top doc
  On Error Resume Next
  Set GetContentDoc = Nothing
  Dim fr: Set fr = ie.document.getElementById("content_iframe")
  If Not fr Is Nothing Then
    Set GetContentDoc = ie.document.frames("content_iframe").document
  End If
  If GetContentDoc Is Nothing Then Set GetContentDoc = ie.document
  On Error GoTo 0
End Function

Sub WaitReady()
  Dim t: t = 0
  Do
    WScript.Sleep 500
    t = t + 500
    Dim ready: ready = False
    On Error Resume Next
    If ie.Busy = False Then
      Dim d: Set d = GetContentDoc()
      If Not d Is Nothing Then
        If d.readyState = "complete" Then ready = True
      End If
    End If
    On Error GoTo 0
    If ready Then Exit Do
  Loop While t < MAX_WAIT_S * 1000
  WScript.Sleep LOAD_WAIT_MS
End Sub

' ---- run queries ----------------------------------------------------
Dim content: content = ReadUtf8(inFile)
content = Replace(content, Chr(65279), "") ' strip BOM
Dim lines: lines = Split(content, vbLf)
Dim done: done = 0
Dim header: header = "===== TRADEMARK auto search " & Now & " ====="
AppendUtf8 outFile, header & vbCrLf

Dim i
For i = 0 To UBound(lines)
  Dim line: line = Replace(Trim(lines(i)), vbCr, "")
  If Len(line) > 0 And Left(line, 1) <> "#" Then
    Dim parts: parts = Split(line, vbTab)
    Dim label: label = parts(0)
    Dim tm: tm = "": If UBound(parts) >= 1 Then tm = parts(1)
    Dim cc: cc = "": If UBound(parts) >= 2 Then cc = parts(2)
    If Len(tm) > 0 Then
      Dim url
      url = base & SEARCH_PATH & "&ApplNo=" & APPL_NO & _
            "&TmName=" & UrlEnc(tm) & "&ClassCd=" & UrlEnc(cc)

      Dim navigated: navigated = False
      On Error Resume Next
      Dim fr2: Set fr2 = ie.document.getElementById("content_iframe")
      If Not fr2 Is Nothing Then
        fr2.src = url
        navigated = True
      End If
      On Error GoTo 0
      If Not navigated Then ie.Navigate url

      WaitReady

      Dim bodyText: bodyText = "(no result text)"
      On Error Resume Next
      Dim d2: Set d2 = GetContentDoc()
      If Not d2 Is Nothing Then bodyText = d2.body.innerText
      On Error GoTo 0

      AppendUtf8 outFile, vbCrLf & "----- [" & label & "] TmName=" & tm & _
        " ClassCd=" & cc & " -----" & vbCrLf & bodyText & vbCrLf
      done = done + 1
    End If
  End If
Next

MsgBox "Done. " & done & " searches saved to:" & vbCrLf & outFile & vbCrLf & vbCrLf & _
       "Open the file, copy all (Ctrl+A, Ctrl+C)," & vbCrLf & _
       "then paste into TRADEMARK side panel (paste collect).", vbInformation, "TRADEMARK"
