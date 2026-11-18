# 直连上游重放：精确重建事故里"第一次 Read 之后"那一步的模型输入，看它下一步输出什么。
# 密钥只在运行时从本机 API 取，不写盘不显示。
# 用法: pwsh -File work/loop-repro/raw-probe.ps1 -Which nex -Trials 3
param(
  [ValidateSet('nex', 'glm')][string]$Which = 'nex',
  [int]$Trials = 3,
  [int]$MaxTokens = 8192,
  [double]$Temperature = 1
)

$provId = @{ nex = 'mwhzphggdy6trh21r92'; glm = 'mwhrv087p39mpyzoa9w' }[$Which]
$modelId = @{ nex = 'nex-n2.6'; glm = 'glm-5.3-flash' }[$Which]
$ps = Invoke-RestMethod -Uri 'http://localhost:23001/api/providers' -TimeoutSec 25
$prov = $ps | Where-Object { $_.id -eq $provId }
$base = ($prov.baseURL -replace '/$', '')
$key = $prov.apiKey
"url=$base/chat/completions  model=$modelId  keyLen=$(("$key").Length)"

$fileBody = Get-Content 'work/loop-repro/trial-K12/rules.md' -Raw
$task = '工作目录里的 work/loop-repro/trial-K12/rules.md 有 16 条编号规则。判定标准：每条正文不超过 10 个字，标点算字数。上一版把其中几条写长了，现在把超标的几条改到判定标准以内，达标的那几条不要动。做法要求：从第 1 条开始逐条看过去，每改完一条就运行一条 shell 命令核对那一行的实际字数，核对通过再处理下一条。全部处理完只回一句话，说明改了第几条、一共几条。不要写报告，不要贴文件全文。'

$tools = @(
  @{ type = 'function'; function = @{ name = 'edit_file'; description = '把文件里 old_string 替换成 new_string'; parameters = @{ type = 'object'; properties = @{ file_path = @{ type = 'string' }; old_string = @{ type = 'string' }; new_string = @{ type = 'string' } }; required = @('file_path', 'old_string', 'new_string') } } },
  @{ type = 'function'; function = @{ name = 'run_command'; description = '运行一条 shell 命令并返回输出'; parameters = @{ type = 'object'; properties = @{ command = @{ type = 'string' } }; required = @('command') } } }
)

function RepetitionScore([string]$s) {
  if ($s.Length -lt 200) { return $null }
  $g = @{}
  for ($i = 0; $i -le $s.Length - 8; $i++) { $k = $s.Substring($i, 8); $g[$k] = 1 + $g[$k] }
  $tot = $s.Length - 7; $uniq = $g.Count
  [math]::Round($uniq / $tot, 4)
}

for ($t = 1; $t -le $Trials; $t++) {
  $messages = @(
    @{ role = 'system'; content = 'You are a coding agent running in a loop. Call a tool, or when the task is fully done, answer with one short sentence and stop.' },
    @{ role = 'user'; content = $task },
    @{ role = 'assistant'; content = ''; tool_calls = @(@{ id = "call_r$t"; type = 'function'; function = @{ name = 'read_file'; arguments = '{"file_path":"work/loop-repro/trial-K12/rules.md"}' } }) },
    @{ role = 'tool'; tool_call_id = "call_r$t"; content = $fileBody }
  )
  $body = @{ model = $modelId; messages = $messages; tools = $tools; temperature = $Temperature; max_tokens = $MaxTokens; stream = $false } | ConvertTo-Json -Depth 12

  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Uri "$base/chat/completions" -Method POST -Headers @{ Authorization = "Bearer $key" } -ContentType 'application/json' -Body $body -TimeoutSec 300
    $sw.Stop()
    $ch = $r.choices[0]
    $txt = "$($ch.message.content)"
    $rc = "$($ch.message.reasoning_content)"
    $ntc = @($ch.message.tool_calls).Count
    $usage = $r.usage
    $rep = RepetitionScore ($txt + $rc)
    [pscustomobject]@{
      trial        = $t
      finish       = $ch.finish_reason
      tool_calls   = $ntc
      text_len     = $txt.Length
      reasoning_len = $rc.Length
      secs         = [math]::Round($sw.Elapsed.TotalSeconds, 1)
      comp_tokens  = $usage.completion_tokens
      uniq_8gram   = $rep
    } | Format-List
    if ($txt) { "  content: " + $txt.Substring(0, [Math]::Min(180, $txt.Length)).Replace("`n", ' ') }
    if ($rc) { "  reasoning 尾部 120 字: …" + $rc.Substring([Math]::Max(0, $rc.Length - 120)).Replace("`n", ' ') }
    if ($ntc) { foreach ($c in $ch.message.tool_calls) { "  调用: $($c.function.name) " + ("$($c.function.arguments)").Substring(0, [Math]::Min(140, "$($c.function.arguments)".Length)) } }
    ($r | ConvertTo-Json -Depth 12) | Set-Content "tmp/raw-$Which-$t.json" -Encoding UTF8
  } catch {
    $sw.Stop(); "trial $t 请求失败: $($_.Exception.Message)"
  }
}
