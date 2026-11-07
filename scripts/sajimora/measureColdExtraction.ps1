param([string]$OutputDirectory = 'rust/audit/cold-index-baseline-2026-10-04', [switch]$SourceCapture, [string]$SourceExecutable = 'rust/target/debug/sajimora.exe', [switch]$JavaFacts, [string]$JobsFile = '', [int]$TreeMemoryMiB = 1024, [string]$ResumeFromDirectory = '', [string]$IncrementalFromDirectory = '', [switch]$HistoricalRevision)
$ErrorActionPreference = 'Stop'
if (-not ('ColdProcessInventory' -as [type])) { Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ColdProcessInventory {
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
'@
}
$workspace = (Get-Location).Path
$output = [IO.Path]::GetFullPath((Join-Path $workspace $OutputDirectory))
if (Test-Path -LiteralPath $output) { throw 'Use a new output directory for each cold run.' }
$null = New-Item -ItemType Directory -Path $output
$node = (Get-Command node).Source
$jobs = @(
    @{name='thingsboard-java';repo=($env:THINGSBOARD_REPO ?? 'thingsboard');revision='0439df09f31b0e8101b9f0a6be556c087d86818d';entry='exportContract.ts';service='thingsboard'},
    @{name='thingsboard-typescript';repo=($env:THINGSBOARD_REPO ?? 'thingsboard');revision='0439df09f31b0e8101b9f0a6be556c087d86818d';entry='exportFrontendContract.ts';service='frontend';extra=@('--ts-root','ui-ngx/src','--target-service-id','thingsboard','--target-api-version','v1')},
    @{name='fineract-java';repo="$workspace/artifacts/production-large-repo/holdout/fineract";revision='4684c663805560d5b6948045224440441fa4485c';entry='exportContract.ts';service='holdout-api'},
    @{name='mifos-typescript';repo="$workspace/artifacts/production-large-repo/holdout/mifos-web-app";revision='3a6a2248eedae32a0be5f1ae0d11d0c4eef0cf21';entry='exportFrontendContract.ts';service='holdout-web';extra=@('--target-service-id','holdout-api','--target-api-version','v1')}
)
if ($SourceCapture) {
    $node = (Resolve-Path -LiteralPath $SourceExecutable).Path
    $jobs = @($jobs[0], $jobs[2])
}
if ($JobsFile) {
    if (-not $SourceCapture) { throw 'Custom jobs require SourceCapture.' }
    $jobs = @(Get-Content -LiteralPath $JobsFile -Raw | ConvertFrom-Json)
}
$results = @()
foreach ($job in $jobs) {
    $headBefore = (& git -C $job.repo rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "HEAD unavailable: $($job.name)" }
    $revision = (& git --no-replace-objects -C $job.repo rev-parse --verify --end-of-options "$($job.revision)^{commit}").Trim()
    if ($LASTEXITCODE -ne 0 -or (-not $HistoricalRevision -and $headBefore -ne $revision)) { throw "Frozen revision mismatch: $($job.name)" }
    $bare = ((& git -C $job.repo rev-parse --is-bare-repository).Trim() -eq 'true')
    if (-not $bare) {
        $status = & git -C $job.repo status --porcelain --untracked-files=no
        if ($LASTEXITCODE -ne 0 -or $status) { throw "Tracked source changes: $($job.name)" }
    }
    $directory = Join-Path $output $job.name
    $null = New-Item -ItemType Directory -Path $directory
    if ($ResumeFromDirectory) {
        if (-not $SourceCapture) { throw 'Resume measurements require SourceCapture.' }
        Copy-Item -LiteralPath (Join-Path (Join-Path $ResumeFromDirectory $job.name) 'source-index.sqlite') -Destination (Join-Path $directory 'source-index.sqlite')
    }
    if ($IncrementalFromDirectory) {
        if (-not $SourceCapture -or $ResumeFromDirectory) { throw 'Incremental requires SourceCapture and excludes ResumeFromDirectory.' }
        Copy-Item -LiteralPath (Join-Path (Join-Path $IncrementalFromDirectory $job.name) 'source-index.sqlite') -Destination (Join-Path $directory 'source-index.sqlite')
    }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node
    $info.WorkingDirectory = $workspace
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment['SAJIMORA_COLD_TELEMETRY'] = Join-Path $directory 'stages.jsonl'
    if ($SourceCapture) {
        foreach ($argument in @('index-source','--repo',$job.repo,'--revision',$revision,'--database',(Join-Path $directory 'source-index.sqlite'))) { $info.ArgumentList.Add($argument) }
        if ($JavaFacts) { $info.ArgumentList.Add('--parse-java') }
        $info.ArgumentList.Add('--tree-memory-mib'); $info.ArgumentList.Add([string]$TreeMemoryMiB)
        if ($ResumeFromDirectory) { $info.ArgumentList.Add('--resume') }
        if ($IncrementalFromDirectory) { $info.ArgumentList.Add('--incremental') }
    } else {
        foreach ($argument in @('scripts/test-runtime/run-tsx-command.cjs',"scripts/sajimora/$($job.entry)",'--repo',$job.repo,'--parent',$revision,'--candidate',$revision,'--service-id',$job.service,'--api-version','v1','--out',(Join-Path $directory 'artifact.json'))) { $info.ArgumentList.Add($argument) }
        foreach ($argument in $job.extra) { $info.ArgumentList.Add($argument) }
    }
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
    [long]$treePeak = 0
    [long]$privatePeak = 0
    [long]$rootPeak = 0
    $sampleCount = 0
    [long]$walPeak = 0
    [long]$databasePeak = 0
    Write-Output "Measuring $($job.name), PID $($process.Id)"
    while (-not $process.HasExited) {
        $inventory = @([ColdProcessInventory]::Read())
        do {
            $added = $false
            foreach ($item in $inventory) { if ($known.Contains([int]$item.parent) -and $known.Add([int]$item.pid)) { $added = $true } }
        } while ($added)
        [long]$rss = 0
        [long]$private = 0
        $members = @()
        foreach ($taskId in $known) {
            $member = Get-Process -Id $taskId -ErrorAction SilentlyContinue
            if ($member) {
                $rss += $member.WorkingSet64
                $private += $member.PrivateMemorySize64
                $members += @{pid=$taskId;name=$member.ProcessName;rss=$member.WorkingSet64;private=$member.PrivateMemorySize64}
                if ($taskId -eq $process.Id) { $rootPeak = [Math]::Max($rootPeak,$member.PeakWorkingSet64) }
            }
        }
        $treePeak = [Math]::Max($treePeak,$rss)
        $privatePeak = [Math]::Max($privatePeak,$private)
        if ($SourceCapture) {
            $databaseItem = Get-Item -LiteralPath (Join-Path $directory 'source-index.sqlite') -ErrorAction SilentlyContinue
            $walItem = Get-Item -LiteralPath (Join-Path $directory 'source-index.sqlite-wal') -ErrorAction SilentlyContinue
            if ($databaseItem) { $databasePeak = [Math]::Max($databasePeak,$databaseItem.Length) }
            if ($walItem) { $walPeak = [Math]::Max($walPeak,$walItem.Length) }
        }
        $samples.WriteLine((@{elapsedMs=$timer.ElapsedMilliseconds;rssBytes=$rss;privateBytes=$private;processes=$members} | ConvertTo-Json -Depth 5 -Compress))
        $sampleCount++
        Start-Sleep -Milliseconds 200
    }
    $process.WaitForExit()
    $timer.Stop()
    $null = $stdoutTask.GetAwaiter().GetResult()
    $null = $stderrTask.GetAwaiter().GetResult()
    $stdout.Dispose(); $stderr.Dispose(); $samples.Dispose()
    $result = @{name=$job.name;repository=$job.repo;revision=$revision;elapsedMs=$timer.ElapsedMilliseconds;exitCode=$process.ExitCode;sampledTreePeakRssBytes=$treePeak;sampledTreePeakPrivateBytes=$privatePeak;rootPeakWorkingSetBytes=$rootPeak;samples=$sampleCount;command=@($node)+@($info.ArgumentList);coldDefinition='Fresh exporter process; no persisted analyzer index reused. OS filesystem cache is not cleared.';memoryMethod='Windows process-tree RSS/private samples; 200ms delay plus Toolhelp sampling overhead. Short-lived children may be missed; summed RSS can double-count shared pages.'}
    if ($SourceCapture) {
        $result['sampledPeakWalBytes'] = $walPeak
        $result['sampledPeakDatabaseBytes'] = $databasePeak
        $result['finalDatabaseBytes'] = (Get-Item -LiteralPath (Join-Path $directory 'source-index.sqlite')).Length
        $result['scope'] = 'Rust immutable source capture only; Java syntax extraction and semantic resolution are pending. Build profile is recorded separately.'
        if ($JavaFacts) { $result['scope'] = 'Immutable source capture plus isolated Java structural facts. Contract/type/call resolution is pending.' }
        if ($ResumeFromDirectory) { $result['scope'] = 'Revalidation and resume of a copied sealed source/fact database. Copy time excluded; not a cold-index measurement.'; $result['coldDefinition'] = 'Fresh process, existing source/fact cache copied before timer; OS cache not cleared.' }
        if ($IncrementalFromDirectory) { $result['scope'] = 'Cross-commit incremental Java structural index using a copied persisted database. Copy time excluded; semantic results conservatively invalidated.'; $result['coldDefinition'] = 'Fresh process, prior source/fact cache copied before timer; OS cache not cleared.' }
        $result['binarySha256'] = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($process.ExitCode -eq 0) { $result['capture'] = Get-Content -LiteralPath (Join-Path $directory 'stdout.log') -Raw | ConvertFrom-Json }
    }
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $directory 'measurement.json')
    $results += $result
    ConvertTo-Json -InputObject @($results) -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'measurements.json')
    Write-Output "$($job.name): exit=$($process.ExitCode), $($timer.ElapsedMilliseconds)ms, tree RSS=$([Math]::Round($treePeak/1MB)) MiB"
    $process.Dispose()
    if ((& git -C $job.repo rev-parse HEAD).Trim() -ne $headBefore) { throw "Repository HEAD changed during run: $($job.name)" }
    if (-not $bare -and (& git -C $job.repo status --porcelain --untracked-files=no)) { throw "Repository changed during run: $($job.name)" }
}
