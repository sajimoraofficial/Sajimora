param([Parameter(Mandatory=$true)][string]$ArtifactDirectory)
$taskDirectory=(Resolve-Path -LiteralPath $ArtifactDirectory).Path
$taskExecutable=(Resolve-Path -LiteralPath 'rust/target/release/sajimora.exe').Path
$taskArtifactHashes=@{}
foreach($taskName in @('backend.json','frontend.json')){$taskArtifactHashes[$taskName]=(Get-FileHash -LiteralPath (Join-Path $taskDirectory $taskName) -Algorithm SHA256).Hash.ToLowerInvariant()}
$taskProcessInfo=[System.Diagnostics.ProcessStartInfo]::new()
$taskProcessInfo.FileName=$taskExecutable
$taskProcessInfo.UseShellExecute=$false
$taskProcessInfo.CreateNoWindow=$true
$taskProcessInfo.RedirectStandardOutput=$true
$taskProcessInfo.RedirectStandardError=$true
foreach($taskArgument in @('check-contract','--base',(Join-Path $taskDirectory 'backend.json'),'--candidate',(Join-Path $taskDirectory 'backend.json'),'--target',(Join-Path $taskDirectory 'frontend.json'),'--trusted-local')){$taskProcessInfo.ArgumentList.Add($taskArgument)}
$taskProcess=[System.Diagnostics.Process]::new()
$taskProcess.StartInfo=$taskProcessInfo
$taskTimer=[System.Diagnostics.Stopwatch]::StartNew()
$null=$taskProcess.Start()
$taskOutput=$taskProcess.StandardOutput.ReadToEndAsync()
$taskErrors=$taskProcess.StandardError.ReadToEndAsync()
[long]$taskPeak=0
while(-not $taskProcess.HasExited){$taskProcess.Refresh();$taskPeak=[Math]::Max($taskPeak,$taskProcess.PeakWorkingSet64);Start-Sleep -Milliseconds 25}
$taskProcess.WaitForExit()
$taskTimer.Stop()
$taskReport=$taskOutput.GetAwaiter().GetResult() | ConvertFrom-Json
$taskErrorText=$taskErrors.GetAwaiter().GetResult()
if($taskProcess.ExitCode -ne 0){throw "Rust check failed: $taskErrorText"}
foreach($taskName in @('backend.json','frontend.json')){if($taskArtifactHashes[$taskName] -ne (Get-FileHash -LiteralPath (Join-Path $taskDirectory $taskName) -Algorithm SHA256).Hash.ToLowerInvariant()){throw "Artifact changed during performance measurement: $taskName"}}
@{binarySha256=(Get-FileHash -LiteralPath $taskExecutable -Algorithm SHA256).Hash.ToLowerInvariant();artifactSha256=$taskArtifactHashes;elapsedMs=$taskTimer.ElapsedMilliseconds;peakWorkingSetBytes=$taskPeak;peakMeasurement='Windows process PeakWorkingSet64 sampled every 25ms';exitCode=$taskProcess.ExitCode;verdict=$taskReport.verdict;findings=$taskReport.findings.Count} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskDirectory 'performance.json')
$taskProcess.Dispose()
