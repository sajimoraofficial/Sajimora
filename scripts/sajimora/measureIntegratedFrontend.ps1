param(
  [string]$Repo = ($env:THINGSBOARD_REPO ?? 'thingsboard'),
  [string]$Revision = '0439df09f31b0e8101b9f0a6be556c087d86818d',
  [string]$OutputDirectory = 'rust/audit/thingsboard-pilot/integrated-2026-10-05/performance',
  [int]$Runs = 3,
  [int]$TimeoutSeconds = 120,
  [int]$PrivateMemoryLimitMiB = 2304
)
$ErrorActionPreference = 'Stop'
if ($Runs -lt 1 -or $Runs -gt 10) { throw 'Runs must be between 1 and 10.' }
$workspace = (Get-Location).Path
$output = [IO.Path]::GetFullPath((Join-Path $workspace $OutputDirectory))
if (Test-Path -LiteralPath $output) { throw 'Use a new measurement output directory.' }
$head = (& git -C $Repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $Revision) { throw 'Frozen repository revision mismatch.' }
if (& git -C $Repo status --porcelain --untracked-files=no) { throw 'Tracked repository source changes.' }
$null = New-Item -ItemType Directory -Path $output
function Get-MilestoneToolFingerprint {
  $paths = @(Get-ChildItem -LiteralPath 'packages/analysis/src/sajimora/cross-language' -File -Filter '*.ts' | Select-Object -ExpandProperty FullName)
  $paths += @('scripts/sajimora/exportFrontendContract.ts','scripts/sajimora/coldExtractionTelemetry.ts','scripts/test-runtime/run-tsx-command.cjs','scripts/test-runtime/windows-userinfo-shim.cjs','packages/analysis/src/sajimora/snapshots/GitRepository.ts')
  $entries = @($paths | Sort-Object | ForEach-Object { "$_`t$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash)" })
  $bytes = [Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
$toolFingerprint = Get-MilestoneToolFingerprint
if (-not ('MilestoneProcesses' -as [type])) { Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MilestoneProcesses {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Entry { public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string executable; }
 [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static Entry[] Read() {
  var handle=CreateToolhelp32Snapshot(2,0);
  if(handle==new IntPtr(-1)) throw new Exception("Process snapshot unavailable");
  try { var list=new List<Entry>(); var e=new Entry(); e.size=(uint)Marshal.SizeOf<Entry>(); if(Process32FirstW(handle,ref e)) do {list.Add(e);} while(Process32NextW(handle,ref e)); return list.ToArray(); }
  finally {CloseHandle(handle);}
 }
}
'@ }
$results = @()
for ($run = 1; $run -le $Runs; $run++) {
  $directory = Join-Path $output "run-$run"
  $null = New-Item -ItemType Directory -Path $directory
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = (Get-Command node).Source
  $info.WorkingDirectory = $workspace
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.Environment['SAJIMORA_COLD_TELEMETRY'] = Join-Path $directory 'stages.jsonl'
  foreach ($argument in @('--max-old-space-size=1792','scripts/test-runtime/run-tsx-command.cjs','scripts/sajimora/exportFrontendContract.ts','--repo',$Repo,'--parent',$Revision,'--candidate',$Revision,'--service-id','frontend','--api-version','v1','--target-service-id','thingsboard','--target-api-version','v1','--out',(Join-Path $directory 'frontend.json'))) { $info.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  $stdout = [IO.File]::Create((Join-Path $directory 'stdout.log'))
  $stderr = [IO.File]::Create((Join-Path $directory 'stderr.log'))
  $samples = [IO.StreamWriter]::new((Join-Path $directory 'memory.jsonl'))
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $null = $process.Start()
  $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
  $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderr)
  $known = [Collections.Generic.HashSet[int]]::new()
  $null = $known.Add($process.Id)
  [long]$peakRss = 0
  [long]$peakPrivate = 0
  $failure = $null
  Write-Output "Measuring run $run, PID $($process.Id)"
  while (-not $process.HasExited) {
    $inventory = @([MilestoneProcesses]::Read())
    do {
      $added = $false
      foreach ($item in $inventory) { if ($known.Contains([int]$item.parent) -and $known.Add([int]$item.pid)) { $added = $true } }
    } while ($added)
    [long]$rss = 0
    [long]$private = 0
    foreach ($taskId in $known) {
      $member = Get-Process -Id $taskId -ErrorAction SilentlyContinue
      if ($member) { $rss += $member.WorkingSet64; $private += $member.PrivateMemorySize64 }
    }
    $peakRss = [Math]::Max($peakRss,$rss)
    $peakPrivate = [Math]::Max($peakPrivate,$private)
    $samples.WriteLine((@{elapsedMs=$timer.ElapsedMilliseconds;treeRss=$rss;treePrivateCommit=$private} | ConvertTo-Json -Compress))
    if ($timer.Elapsed.TotalSeconds -gt $TimeoutSeconds -or $private -gt $PrivateMemoryLimitMiB * 1MB) {
      $failure = 'Process-tree timeout/private-commit admission limit exceeded'
      $process.Kill($true)
      break
    }
    Start-Sleep -Milliseconds 100
  }
  $process.WaitForExit()
  $null = $stdoutTask.GetAwaiter().GetResult()
  $null = $stderrTask.GetAwaiter().GetResult()
  $timer.Stop()
  $stdout.Dispose(); $stderr.Dispose(); $samples.Dispose()
  $results += @{run=$run;elapsedMs=$timer.ElapsedMilliseconds;exitCode=$process.ExitCode;treePeakRss=$peakRss;treePeakPrivateCommit=$peakPrivate;failure=$failure}
  Write-Output "Run $run completed in $($timer.ElapsedMilliseconds) ms; exit $($process.ExitCode)"
}
$ordered = @($results.elapsedMs | Sort-Object)
$cpu = $env:PROCESSOR_IDENTIFIER
$summary = @{revision=$Revision;toolFingerprint=$toolFingerprint;toolSourcesUnchanged=($toolFingerprint -eq (Get-MilestoneToolFingerprint));workload='Full frozen frontend export, not history-first latency';cacheState='Fresh Node processes; OS cache not cleared; local npm cache available; no semantic index';sampleIntervalMs=100;machine=@{cpu=$cpu;os=[Runtime.InteropServices.RuntimeInformation]::OSDescription};limits=@{timeoutSeconds=$TimeoutSeconds;treePrivateMiB=$PrivateMemoryLimitMiB;nodeOldSpaceMiB=1792};runs=$results;p50Ms=$ordered[[Math]::Ceiling($Runs*0.50)-1];p95Ms=$ordered[[Math]::Ceiling($Runs*0.95)-1];targetMet=(@($results | Where-Object {$_.exitCode -ne 0 -or $_.failure}).Count -eq 0 -and $ordered[-1] -le 10000)}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'summary.json')
