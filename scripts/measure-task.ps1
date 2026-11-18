# 度量一次子 agent 运行是否出现死循环签名。
# 数据源: GET /api/agents/tasks/:task（含逐步工具轨迹）
# 用法: pwsh -File work/loop-repro/measure-task.ps1 -TaskId <uuid>
param([Parameter(Mandatory = $true)][string]$TaskId)

$prog = '(?i)Get-|Set-|Select-|Where-|ForEach|Out-|Sort-|Group-|Measure-|New-|Remove-|Copy-|Test-|Invoke-| alma |git |node|python|curl|npm|echo|\$|pwsh'
$t = Invoke-RestMethod -Uri "http://localhost:23001/api/agents/tasks/$TaskId" -TimeoutSec 30

$seq = New-Object System.Collections.Generic.List[string]
$edits = 0; $noop = 0; $bash = 0; $magic = 0; $magicList = @(); $fail = 0
foreach ($m in $t.messages) {
  if ($m.role -ne 'tool') { continue }
  $line = (("$($m.content)") -split "`n")[0]
  if ($line -notmatch '^(\S+) #(\d+)\s+([\w-]+)\s+(\{.*)$') { continue }
  $mark = $Matches[1]; $name = $Matches[3]; $argtxt = $Matches[4]
  $seq.Add($(if ($mark -eq '✅') { $name.Substring(0, 1) } else { $name.Substring(0, 1).ToLower() }))
  if ($mark -ne '✅') { $fail++ }

  if ($name -in @('Edit', 'Write')) {
    # 参数可能被截断，直接用正则取两栏原文比对，不做完整 JSON 解析
    if ($name -eq 'Edit') {
      $edits++
      $o = [regex]::Match($argtxt, '"old_string"\s*:\s*"((?:[^"\\]|\\.)*)"')
      $n = [regex]::Match($argtxt, '"new_string"\s*:\s*"((?:[^"\\]|\\.)*)"')
      if ($o.Success -and $n.Success -and $o.Groups[1].Value -ceq $n.Groups[1].Value) { $noop++ }
    }
  }
  if ($name -eq 'Bash') {
    $bash++
    $cm = [regex]::Match($argtxt, '"command"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if ($cm.Success) {
      $c = $cm.Groups[1].Value
      if ($c -match '^"[A-Za-z0-9 .\-_]+"$' -and $c -notmatch $prog) { $magic++; $magicList += $c }
    }
  }
}

$elapsed = ([datetime]$t.task.updatedAt - [datetime]$t.task.createdAt).TotalSeconds
$tools = $seq.Count
$verdict = if ($noop -ge 3 -or $magic -ge 3) { 'LOOP' } elseif ($tools -ge 25) { 'HEAVY' } elseif ($tools -ge 15) { 'LONG' } else { 'ok' }

[pscustomobject]@{
  task      = $TaskId.Substring(0, 8)
  desc      = $t.task.description
  model     = $t.task.model
  status    = $t.task.status
  secs      = [math]::Round($elapsed, 0)
  toolCalls = $tools
  edits     = $edits
  noopEdits = $noop
  bash      = $bash
  magicBash = $magic
  failures  = $fail
  verdict   = $verdict
} | Format-List
"序列: " + (-join $seq)
if ($magicList.Count) { "口令: " + ($magicList -join ' | ') }
$fin = "$($t.task.result.result)"
"末条回复($($fin.Length) 字): " + $fin.Substring(0, [Math]::Min(140, $fin.Length))
