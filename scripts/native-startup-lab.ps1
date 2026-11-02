param([int]$RootPid, [string]$HostPath)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
@{kind='account';builtinAdministrator=$identity.User.Value.EndsWith('-500');adminGroup=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);session=(Get-Process -Id $RootPid).SessionId;os=[Environment]::OSVersion.VersionString} | ConvertTo-Json -Compress
$rows=@(Get-CimInstance Win32_Process)
$hosts=@($rows | Where-Object { $_.ParentProcessId -eq $RootPid -and $_.Name -eq 'revqora.exe' -and $_.ExecutablePath -eq $HostPath })
$owned=@($hosts);$front=@($hosts.ProcessId)
for($depth=0;$depth -lt 4 -and $front.Count;$depth++) {
  $children=@($rows | Where-Object { $front -contains $_.ParentProcessId })
  $owned+= $children;$front=@($children.ProcessId)
}
foreach($row in @($owned | Select-Object -First 32)) {
  try {
    $p=Get-Process -Id $row.ProcessId
    $threads=@($p.Threads | Select-Object -First 32 | ForEach-Object {
      try { @{id=$_.Id;state=$_.ThreadState.ToString();reason=$(if($_.ThreadState -eq 'Wait'){$_.WaitReason.ToString()}else{$null})} }catch{@{error=$_.Exception.GetType().Name}}
    })
    $command=[string]$row.CommandLine
    $kind=if($command -match '--type=([^ ]+)'){$Matches[1]}else{'main'}
    @{kind='process';pid=$p.Id;parent=$row.ParentProcessId;name=$row.Name;type=$kind;version=$p.FileVersion;session=$p.SessionId;cpu=$p.TotalProcessorTime.TotalSeconds;threads=$threads;ports=@([regex]::Matches($command,'--remote-debugging-port=(\d+)') | ForEach-Object {$_.Groups[1].Value});hasLogSwitch=$command.Contains('--log-file=');hasUserDataDir=$command.Contains('--user-data-dir=')} | ConvertTo-Json -Compress -Depth 6
  }catch{ @{kind='process-error';pid=$row.ProcessId;error=$_.Exception.GetType().Name}|ConvertTo-Json -Compress }
}
$ids=@($owned.ProcessId)
@{kind='listeners';rows=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$ids -contains $_.OwningProcess} | Select-Object OwningProcess,LocalPort)} | ConvertTo-Json -Compress -Depth 4
