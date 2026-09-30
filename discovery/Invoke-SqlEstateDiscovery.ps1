<#
.SYNOPSIS
    Runs SqlEstateDiscovery.sql across an entire SQL Server estate and merges the
    results into a single CSV for the SQL Estate Analyzer.

.DESCRIPTION
    Replaces the "run it once per instance in SSMS and save each grid" loop with
    one sweep. Point it at a list of instances, a Central Management Server, or
    let it find every SQL Server registered in Active Directory, and it produces:

      SqlEstateInventory-<timestamp>.csv       one row per database, all instances
      SqlEstateInventory-<timestamp>-log.csv   per-instance status and timings

    Upload the first file to the Analyzer. The second tells you which instances
    were missed and why.

    Read-only throughout. No modules required — uses System.Data.SqlClient and
    ADSI, both present in Windows PowerShell 5.1 and PowerShell 7. On PowerShell
    7 instances are queried in parallel; on 5.1 it falls back to sequential.

.PARAMETER Instance
    One or more instances, e.g. SQLPROD01, SQLPROD02\FINANCE, sql03.contoso.com,1435

.PARAMETER InputFile
    A .txt with one instance per line, or a .csv with an Instance, ServerName or
    ServerInstance column. Blank lines and lines starting with # are ignored.

.PARAMETER FromActiveDirectory
    Find every SQL Server in the domain by its MSSQLSvc service principal name.
    Needs no special rights — any authenticated domain user can read SPNs — and
    no RSAT. Disabled computer accounts are skipped.

.PARAMETER FromCentralManagementServer
    Read the registered server list out of a Central Management Server's msdb.

.PARAMETER ListOnly
    Resolve and print the target list, then stop. Always worth doing first.

.PARAMETER Credential
    SQL authentication. Omit for Windows authentication (the default).

.EXAMPLE
    .\Invoke-SqlEstateDiscovery.ps1 -FromActiveDirectory -ListOnly

.EXAMPLE
    .\Invoke-SqlEstateDiscovery.ps1 -FromActiveDirectory -ThrottleLimit 16

.EXAMPLE
    .\Invoke-SqlEstateDiscovery.ps1 -InputFile .\servers.txt -Credential (Get-Credential)

.EXAMPLE
    .\Invoke-SqlEstateDiscovery.ps1 -FromCentralManagementServer CMS01 -OutputPath .\estate.csv

.NOTES
    Companion to https://krishna-sunkavalli.github.io/sql-modernization-azure/cost-estimator/
#>
#Requires -Version 5.1
[CmdletBinding(DefaultParameterSetName = 'Explicit')]
param(
    [Parameter(ParameterSetName = 'Explicit', Position = 0, ValueFromPipeline)]
    [string[]]$Instance,

    [Parameter(ParameterSetName = 'File', Mandatory)]
    [string]$InputFile,

    [Parameter(ParameterSetName = 'Ad', Mandatory)]
    [switch]$FromActiveDirectory,

    [Parameter(ParameterSetName = 'Ad')]
    [string]$SearchBase,

    [Parameter(ParameterSetName = 'Cms', Mandatory)]
    [string]$FromCentralManagementServer,

    [string]$ScriptPath,
    [string]$OutputPath,
    [System.Management.Automation.PSCredential]$Credential,
    [int]$ThrottleLimit = 8,
    [int]$ConnectTimeoutSec = 8,
    [int]$QueryTimeoutSec = 900,
    [switch]$Encrypt,
    [switch]$TrustServerCertificate,
    [switch]$ListOnly
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- target list

function ConvertTo-SqlTarget {
    <# Turns an MSSQLSvc SPN suffix into a connectable instance string. #>
    param([string]$SpnSuffix)

    $hostName = $SpnSuffix
    $instName = $null
    $port     = $null

    $sep = $SpnSuffix.LastIndexOf(':')
    if ($sep -gt 0) {
        $hostName = $SpnSuffix.Substring(0, $sep)
        $suffix   = $SpnSuffix.Substring($sep + 1)
        if ($suffix -match '^\d+$') { $port = [int]$suffix } else { $instName = $suffix }
    }
    if (-not $hostName) { return $null }

    if ($instName)              { return "$hostName\$instName" }
    if ($port -and $port -ne 1433) { return "$hostName,$port" }
    return $hostName
}

function Get-TargetFromActiveDirectory {
    param([string]$SearchBase)

    Write-Host 'Searching Active Directory for MSSQLSvc service principal names...' -ForegroundColor Cyan

    $base = $SearchBase
    if (-not $base) {
        $rootDse = [ADSI]'LDAP://RootDSE'
        $base = $rootDse.defaultNamingContext
        if ($base -is [array]) { $base = $base[0] }
    }
    if (-not $base) { throw 'Could not determine the domain naming context. Is this machine domain-joined? Pass -SearchBase to target a specific OU or domain.' }

    $searcher = New-Object System.DirectoryServices.DirectorySearcher
    $searcher.SearchRoot  = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$base")
    $searcher.Filter      = '(servicePrincipalName=MSSQLSvc/*)'
    $searcher.PageSize    = 1000
    $searcher.SizeLimit   = 0
    [void]$searcher.PropertiesToLoad.AddRange(@('serviceprincipalname', 'dnshostname', 'samaccountname', 'useraccountcontrol'))

    $found = @()
    try { $results = $searcher.FindAll() }
    catch { throw "Active Directory search failed against '$base': $($_.Exception.Message)" }

    foreach ($r in $results) {
        # Skip disabled accounts (UF_ACCOUNTDISABLE = 0x2) so dead machines don't
        # pad the sweep with connection timeouts.
        $uac = $r.Properties['useraccountcontrol']
        if ($uac -and ([int]$uac[0] -band 0x2)) { continue }

        foreach ($spn in $r.Properties['serviceprincipalname']) {
            if ($spn -notlike 'MSSQLSvc/*') { continue }
            $target = ConvertTo-SqlTarget -SpnSuffix $spn.Substring(9)
            if ($target) { $found += $target }
        }
    }
    $results.Dispose()
    $searcher.Dispose()

    # An instance usually has both a short-name and an FQDN SPN. Keep the FQDN:
    # it survives DNS suffix search-order differences between subnets.
    $found |
        Group-Object { ($_ -split '[\\,]')[0].Split('.')[0] + '|' + (($_ -split '\\', 2)[1]) } -CaseSensitive:$false |
        ForEach-Object {
            ($_.Group | Sort-Object @{ e = { ($_ -split '[\\,]')[0].Contains('.') } } -Descending | Select-Object -First 1)
        } |
        Sort-Object -Unique
}

function Get-TargetFromCms {
    param([string]$CmsServer, [System.Management.Automation.PSCredential]$Credential, [int]$ConnectTimeoutSec)

    Write-Host "Reading registered servers from Central Management Server '$CmsServer'..." -ForegroundColor Cyan

    $csb = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $csb['Data Source']     = $CmsServer
    $csb['Initial Catalog'] = 'msdb'
    $csb['Connect Timeout'] = $ConnectTimeoutSec
    $csb['Application Name'] = 'SqlEstateDiscovery'
    if ($Credential) {
        $csb['User ID']  = $Credential.UserName
        $csb['Password'] = $Credential.GetNetworkCredential().Password
    } else { $csb['Integrated Security'] = $true }

    $conn = New-Object System.Data.SqlClient.SqlConnection $csb.ConnectionString
    try {
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = @'
SELECT DISTINCT s.server_name
FROM   msdb.dbo.sysmanagement_shared_registered_servers_internal AS s
WHERE  s.server_name IS NOT NULL
'@
        $reader = $cmd.ExecuteReader()
        $list = @()
        while ($reader.Read()) { $list += [string]$reader[0] }
        $reader.Close()
        $list | Sort-Object -Unique
    }
    finally { $conn.Dispose() }
}

function Get-TargetFromFile {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { throw "Input file not found: $Path" }

    if ([IO.Path]::GetExtension($Path) -match '^\.(csv|tsv)$') {
        $delim = if ([IO.Path]::GetExtension($Path) -eq '.tsv') { "`t" } else { ',' }
        $rows = Import-Csv -LiteralPath $Path -Delimiter $delim
        $col = @('Instance', 'ServerInstance', 'ServerName', 'Server', 'Name') |
               Where-Object { $rows[0].PSObject.Properties.Name -contains $_ } |
               Select-Object -First 1
        if (-not $col) { throw "No Instance/ServerInstance/ServerName column found in $Path" }
        return $rows.$col | Where-Object { $_ } | Sort-Object -Unique
    }

    Get-Content -LiteralPath $Path |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith('#') } |
        Sort-Object -Unique
}

# ---------------------------------------------------------------- per-instance
# Defined as text so the same body can run in a PowerShell 7 parallel runspace
# (which cannot accept a live ScriptBlock) and in the 5.1 sequential path.

$workerText = @'
param($Target, $Sql, $ConnectTimeoutSec, $QueryTimeoutSec, $UseEncrypt, $TrustCert, $SqlUser, $SqlPass)

$sw  = [Diagnostics.Stopwatch]::StartNew()
$out = [ordered]@{ Instance = $Target; Status = 'failed'; Databases = 0; Seconds = 0; Message = '' }
$rows = New-Object System.Collections.ArrayList

$csb = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
$csb['Data Source']      = $Target
$csb['Initial Catalog']  = 'master'
$csb['Connect Timeout']  = $ConnectTimeoutSec
$csb['Application Name'] = 'SqlEstateDiscovery'
if ($SqlUser) { $csb['User ID'] = $SqlUser; $csb['Password'] = $SqlPass }
else          { $csb['Integrated Security'] = $true }
if ($UseEncrypt) { $csb['Encrypt'] = $true }
if ($TrustCert)  { $csb['TrustServerCertificate'] = $true }

$conn = New-Object System.Data.SqlClient.SqlConnection $csb.ConnectionString
try {
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText    = $Sql
    $cmd.CommandTimeout = $QueryTimeoutSec

    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $ds = New-Object System.Data.DataSet
    [void]$adapter.Fill($ds)

    $table = $null
    foreach ($t in $ds.Tables) { if ($t.Columns.Contains('DatabaseName')) { $table = $t; break } }
    if (-not $table) {
        throw 'The script returned no result set with a DatabaseName column. Check that @Format is GRID.'
    }

    $cols = @($table.Columns | ForEach-Object { $_.ColumnName })
    foreach ($r in $table.Rows) {
        $o = [ordered]@{}
        foreach ($c in $cols) { $v = $r[$c]; $o[$c] = if ($v -is [DBNull]) { '' } else { $v } }
        [void]$rows.Add([pscustomobject]$o)
    }

    $out.Status    = 'ok'
    $out.Databases = $rows.Count
}
catch {
    # Unwrap PowerShell's "Exception calling Open with 0 argument(s)" wrapper so
    # the log holds the actual SQL Server message.
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    $out.Message = ($ex.Message -replace '\s+', ' ').Trim()
    if ($out.Message.Length -gt 300) { $out.Message = $out.Message.Substring(0, 297) + '...' }
}
finally {
    if ($conn) { $conn.Dispose() }
    $sw.Stop()
    $out.Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
}

if ($out.Status -eq 'ok') {
    Write-Host ("  [ ok ] {0,-45} {1,4} db  {2,6}s" -f $Target, $out.Databases, $out.Seconds) -ForegroundColor Green
} else {
    Write-Host ("  [fail] {0,-45} {1}" -f $Target, $out.Message) -ForegroundColor Yellow
}

[pscustomobject]@{ Log = [pscustomobject]$out; Rows = $rows.ToArray() }
'@

# ---------------------------------------------------------------------- set-up

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'SqlEstateDiscovery.sql' }
if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "Discovery script not found at '$ScriptPath'. Pass -ScriptPath to point at SqlEstateDiscovery.sql."
}

$sql = Get-Content -LiteralPath $ScriptPath -Raw
# The script ships set to GRID, which is what we need for a native result set.
# If someone has switched it to CSV for sqlcmd, put it back just for this run.
$sql = [regex]::Replace($sql, "(?i)(DECLARE\s+@Format\s+sysname\s*=\s*)'CSV'", "`$1'GRID'")

$targets = switch ($PSCmdlet.ParameterSetName) {
    'Ad'       { Get-TargetFromActiveDirectory -SearchBase $SearchBase }
    'Cms'      { Get-TargetFromCms -CmsServer $FromCentralManagementServer -Credential $Credential -ConnectTimeoutSec $ConnectTimeoutSec }
    'File'     { Get-TargetFromFile -Path $InputFile }
    'Explicit' { $Instance }
}
$targets = @($targets | Where-Object { $_ } | Sort-Object -Unique)

if (-not $targets.Count) {
    throw 'No target instances resolved. Pass -Instance, -InputFile, -FromActiveDirectory or -FromCentralManagementServer.'
}

Write-Host ''
Write-Host "$($targets.Count) instance$(if ($targets.Count -ne 1) { 's' }) to query:" -ForegroundColor Cyan
$targets | ForEach-Object { Write-Host "  $_" }
Write-Host ''

if ($ListOnly) {
    Write-Host 'Listing only — nothing was queried. Re-run without -ListOnly to collect.' -ForegroundColor Cyan
    return
}

if (-not $OutputPath) {
    $OutputPath = Join-Path (Get-Location) ("SqlEstateInventory-{0:yyyyMMdd-HHmm}.csv" -f (Get-Date))
}
$logPath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath))) `
                     ([IO.Path]::GetFileNameWithoutExtension($OutputPath) + '-log.csv')

$sqlUser = $null; $sqlPass = $null
if ($Credential) {
    $sqlUser = $Credential.UserName
    $sqlPass = $Credential.GetNetworkCredential().Password
}

# --------------------------------------------------------------------- collect

$started = Get-Date
Write-Host "Collecting from $($targets.Count) instance$(if ($targets.Count -ne 1) { 's' })..." -ForegroundColor Cyan

$argSet = @($sql, $ConnectTimeoutSec, $QueryTimeoutSec, [bool]$Encrypt, [bool]$TrustServerCertificate, $sqlUser, $sqlPass)

$total = $targets.Count

$stream = if ($PSVersionTable.PSVersion.Major -ge 7 -and $targets.Count -gt 1) {
    $targets | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {
        $worker = [scriptblock]::Create($using:workerText)
        # Copy to a local first: @(...) would pass the array as one argument
        # rather than splatting it across the worker's parameters.
        $a = $using:argSet
        & $worker $_ @a
    }
} else {
    if ($PSVersionTable.PSVersion.Major -lt 7 -and $targets.Count -gt 1) {
        Write-Host '  (Windows PowerShell 5.1 — querying sequentially. Run under PowerShell 7 for a parallel sweep.)' -ForegroundColor DarkGray
    }
    $worker = [scriptblock]::Create($workerText)
    $targets | ForEach-Object { & $worker $_ @argSet }
}

# Results are written as they arrive rather than buffered to the end, so an
# interrupted sweep of a large estate still leaves usable output on disk.
# This loop drains the stream on one thread, so a plain counter is safe.
$log       = New-Object System.Collections.Generic.List[object]
$rowCount  = 0
$done      = 0
$wroteRows = $false
$wroteLog  = $false

foreach ($r in $stream) {
    $log.Add($r.Log)
    $done++

    if ($r.Rows -and $r.Rows.Count) {
        if ($wroteRows) { $r.Rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8 -Append }
        else            { $r.Rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8; $wroteRows = $true }
        $rowCount += $r.Rows.Count
    }

    if ($wroteLog) { $r.Log | Export-Csv -LiteralPath $logPath -NoTypeInformation -Encoding UTF8 -Append }
    else           { $r.Log | Export-Csv -LiteralPath $logPath -NoTypeInformation -Encoding UTF8; $wroteLog = $true }

    if ($total -gt 1) {
        Write-Progress -Activity 'SQL estate discovery' -Status "$done of $total instances · $rowCount databases" `
                       -PercentComplete (100 * $done / $total)
    }
}
if ($total -gt 1) { Write-Progress -Activity 'SQL estate discovery' -Completed }

# ---------------------------------------------------------------------- output

$ok      = @($log | Where-Object Status -eq 'ok')
$failed  = @($log | Where-Object Status -ne 'ok')
$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)

Write-Host ''
Write-Host ('-' * 64)
Write-Host ("Instances succeeded : {0} of {1}" -f $ok.Count, $targets.Count)
Write-Host ("Databases collected : {0}" -f $rowCount)
Write-Host ("Elapsed             : {0}s" -f $elapsed)

if ($ok.Count) {
    $slowest = $ok | Sort-Object Seconds -Descending | Select-Object -First 1
    Write-Host ("Slowest instance    : {0} ({1}s, {2} databases)" -f $slowest.Instance, $slowest.Seconds, $slowest.Databases)
}

if ($rowCount) {
    Write-Host ''
    Write-Host "Inventory : $OutputPath" -ForegroundColor Green
    Write-Host "Run log   : $logPath"
    Write-Host ''
    Write-Host 'Total the Standard and Enterprise cores from this file, then enter them at' -ForegroundColor Cyan
    Write-Host 'https://krishna-sunkavalli.github.io/sql-modernization-azure/cost-estimator/' -ForegroundColor Cyan
} else {
    Write-Host ''
    Write-Warning "No rows collected. See $logPath for the per-instance reason."
}

if ($failed.Count) {
    Write-Host ''
    Write-Warning "$($failed.Count) instance$(if ($failed.Count -ne 1) { 's' }) could not be queried:"
    $failed | ForEach-Object { Write-Host ("  {0,-45} {1}" -f $_.Instance, $_.Message) -ForegroundColor DarkYellow }

    $retryPath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath))) `
                           ([IO.Path]::GetFileNameWithoutExtension($OutputPath) + '-retry.txt')
    $failed.Instance | Set-Content -LiteralPath $retryPath -Encoding UTF8

    Write-Host ''
    Write-Host 'Common causes: the host is decommissioned but its SPN remains, the SQL' -ForegroundColor DarkGray
    Write-Host 'Browser service is stopped on a named instance, a firewall blocks 1433,' -ForegroundColor DarkGray
    Write-Host 'or your account lacks VIEW SERVER STATE. A timeout usually means a very' -ForegroundColor DarkGray
    Write-Host 'large instance — raise -QueryTimeoutSec. Retry just the failures with:' -ForegroundColor DarkGray
    Write-Host "  .\$([IO.Path]::GetFileName($PSCommandPath)) -InputFile `"$retryPath`"" -ForegroundColor DarkGray
}
