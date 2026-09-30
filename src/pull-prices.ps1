<#
  pull-prices.ps1 — builds a compact Azure price snapshot for the SQL Estate Analyzer.

  Sources everything from the public Azure Retail Prices API (prices.azure.com).
  Note: Azure SQL PaaS publishes only the BASE (Azure Hybrid Benefit) compute rate.
  The SQL Server licence component for PaaS, and SQL Server licences on Azure VM,
  are NOT exposed by this API — those are carried as editable assumptions in the app.
#>

param(
  [string]$OutFile = "$PSScriptRoot\prices.json"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$Regions = @(
  'eastus','eastus2','westus2','westus3','centralus','southcentralus',
  'northeurope','westeurope','uksouth','francecentral','germanywestcentral','swedencentral',
  'southeastasia','australiaeast','japaneast','centralindia','canadacentral','brazilsouth'
)

# VM sizes worth putting SQL Server on: Ebdsv5 (local NVMe, best $/perf for SQL),
# Edsv5 (memory-optimised), Ddsv5 (general purpose).
$VmSkus = @(
  'Standard_E2bds_v5','Standard_E4bds_v5','Standard_E8bds_v5','Standard_E16bds_v5',
  'Standard_E32bds_v5','Standard_E48bds_v5','Standard_E64bds_v5',
  'Standard_E2ds_v5','Standard_E4ds_v5','Standard_E8ds_v5','Standard_E16ds_v5',
  'Standard_E32ds_v5','Standard_E48ds_v5','Standard_E64ds_v5',
  'Standard_D2ds_v5','Standard_D4ds_v5','Standard_D8ds_v5','Standard_D16ds_v5',
  'Standard_D32ds_v5','Standard_D48ds_v5','Standard_D64ds_v5'
)

function Get-Px {
  param([string]$Filter, [int]$Max = 20000)
  $url = "https://prices.azure.com/api/retail/prices?`$filter=" + [uri]::EscapeDataString($Filter)
  $all = New-Object System.Collections.ArrayList
  $guard = 0
  while ($url -and $all.Count -lt $Max -and $guard -lt 200) {
    $guard++
    $resp = $null
    for ($attempt = 1; $attempt -le 4; $attempt++) {
      try { $resp = Invoke-RestMethod -Uri $url -TimeoutSec 90; break }
      catch {
        if ($attempt -eq 4) { throw }
        Start-Sleep -Seconds ($attempt * 3)
      }
    }
    foreach ($i in $resp.Items) { [void]$all.Add($i) }
    $url = $resp.NextPageLink
  }
  return $all
}

# Per-unit hourly rate. Azure publishes both a unit meter ("vCore") and per-size
# totals ("16 vCore"). Normalise everything back to a single vCore-hour.
function Get-UnitRate {
  param($Items)
  $rates = @()
  foreach ($i in $Items) {
    if ($i.retailPrice -le 0) { continue }
    if ($i.skuName -match '^(\d+)\s+vCore') {
      $rates += ($i.retailPrice / [double]$Matches[1])
    } elseif ($i.skuName -match '^vCore') {
      $rates += $i.retailPrice
    }
  }
  if ($rates.Count -eq 0) { return $null }
  # Median guards against odd outlier SKUs.
  $sorted = @($rates | Sort-Object)
  return [math]::Round($sorted[[int]([math]::Floor($sorted.Count / 2))], 6)
}

function Select-NonZR {
  param($Items)
  $Items | Where-Object { $_.skuName -notmatch 'Zone Redundancy' -and $_.meterName -notmatch 'Zone Redundancy' }
}

# Azure SQL PaaS tier -> retail API productName
$PaasTiers = [ordered]@{
  'mi_gp_gen5'  = 'SQL Managed Instance General Purpose - Compute Gen5'
  'mi_gp_prem'  = 'SQL Managed Instance General Purpose - Premium Series Compute'
  'mi_bc_gen5'  = 'SQL Managed Instance Business Critical - Compute Gen5'
  'mi_bc_prem'  = 'SQL Managed Instance Business Critical - Premium Series Compute'
  'db_gp_gen5'  = 'SQL Database Single/Elastic Pool General Purpose - Compute Gen5'
  'db_bc_gen5'  = 'SQL Database Single/Elastic Pool Business Critical - Compute Gen5'
  'db_hs_gen5'  = 'SQL Database SingleDB/Elastic Pool Hyperscale - Compute Gen5'
  # Serverless is billed per vCore-second on actual usage and is NOT eligible for
  # Azure Hybrid Benefit, so this rate is licence-inclusive and is deliberately
  # kept separate from the provisioned base rates above.
  'db_sl_gen5'  = 'SQL Database General Purpose - Serverless - Compute Gen5'
  'db_slhs_gen5' = 'SQL Database Hyperscale - Serverless - Compute Gen5'
}

$out = [ordered]@{
  generated = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  source    = 'Azure Retail Prices API (prices.azure.com) — list price, USD, PAYG unless noted'
  currency  = 'USD'
  regions   = [ordered]@{}
}

foreach ($region in $Regions) {
  Write-Host "`n### $region" -ForegroundColor Cyan
  $r = [ordered]@{ paas = [ordered]@{}; ri = [ordered]@{}; storage = [ordered]@{}; vm = [ordered]@{} }

  # ---- Azure SQL PaaS compute (base / AHB rate) + reservations -------------
  $sqlAll = Get-Px "armRegionName eq '$region' and (serviceName eq 'SQL Database' or serviceName eq 'SQL Managed Instance')"
  Write-Host ("  sql meters: {0}" -f $sqlAll.Count)

  foreach ($key in $PaasTiers.Keys) {
    $prod  = $PaasTiers[$key]
    $items = @(Select-NonZR ($sqlAll | Where-Object { $_.productName -eq $prod }))

    $payg = Get-UnitRate ($items | Where-Object { $_.type -eq 'Consumption' })
    if ($payg) { $r.paas[$key] = $payg }

    # Reservations are published as a per-vCore total for the whole term.
    foreach ($term in @(@{n='1y'; t='1 Year'; h=8760}, @{n='3y'; t='3 Years'; h=26280})) {
      $res = @($items | Where-Object { $_.type -eq 'Reservation' -and $_.reservationTerm -eq $term.t -and $_.retailPrice -gt 0 })
      if ($res.Count) {
        $best = ($res | Sort-Object retailPrice | Select-Object -First 1).retailPrice
        $r.ri["$key`_$($term.n)"] = [math]::Round($best / $term.h, 6)
      }
    }
  }

  # ---- Azure SQL storage ---------------------------------------------------
  $stor = [ordered]@{
    'mi_gp' = 'SQL Managed Instance General Purpose - Storage'
    'mi_bc' = 'SQL Managed Instance Business Critical - Storage'
    'db_gp' = 'SQL Database Single/Elastic Pool General Purpose - Storage'
    'db_bc' = 'SQL Database Single/Elastic Pool Business Critical - Storage'
    'db_hs' = 'SQL Database SingleDB Hyperscale - Storage'
  }
  foreach ($k in $stor.Keys) {
    $it = $sqlAll | Where-Object {
      $_.productName -eq $stor[$k] -and $_.type -eq 'Consumption' -and
      $_.unitOfMeasure -match 'GB/Month' -and $_.skuName -notmatch 'Zone Redundancy' -and $_.retailPrice -gt 0
    } | Sort-Object retailPrice | Select-Object -First 1
    if ($it) { $r.storage["${k}_per_gb_mo"] = [math]::Round($it.retailPrice, 6) }
  }

  # Point-in-time restore backup storage (LRS) — applies to all Azure SQL targets.
  $pitr = $sqlAll | Where-Object {
    $_.productName -match 'PITR Backup Storage' -and $_.type -eq 'Consumption' -and
    $_.meterName -match 'LRS' -and $_.retailPrice -gt 0
  } | Sort-Object retailPrice | Select-Object -First 1
  if ($pitr) { $r.storage['backup_lrs_per_gb_mo'] = [math]::Round($pitr.retailPrice, 6) }

  # ---- VM compute (Windows + Linux) ---------------------------------------
  $vmAll = Get-Px "armRegionName eq '$region' and serviceName eq 'Virtual Machines' and priceType eq 'Consumption' and contains(armSkuName,'ds_v5')"
  Write-Host ("  vm meters:  {0}" -f $vmAll.Count)

  foreach ($sku in $VmSkus) {
    $cand = @($vmAll | Where-Object {
      $_.armSkuName -eq $sku -and $_.retailPrice -gt 0 -and
      $_.meterName -notmatch 'Low Priority|Spot' -and $_.skuName -notmatch 'Spot|Low Priority'
    })
    if (-not $cand.Count) { continue }
    $win = $cand | Where-Object { $_.productName -match 'Windows' } | Sort-Object retailPrice | Select-Object -First 1
    $lin = $cand | Where-Object { $_.productName -notmatch 'Windows' } | Sort-Object retailPrice | Select-Object -First 1
    $e = [ordered]@{}
    if ($lin) { $e['linux']   = [math]::Round($lin.retailPrice, 5) }
    if ($win) { $e['windows'] = [math]::Round($win.retailPrice, 5) }
    if ($e.Count) { $r.vm[$sku] = $e }
  }

  # ---- Managed disk (Premium SSD v1, per disk/month) -----------------------
  $disk = Get-Px "armRegionName eq '$region' and serviceName eq 'Storage' and contains(productName,'Premium SSD Managed Disk') and priceType eq 'Consumption'"
  $dmap = [ordered]@{}
  foreach ($d in $disk) {
    # Match the disk meter itself, NOT "P30 LRS Disk Mount" (the attached-to-stopped-VM charge).
    $m = [regex]::Match($d.skuName, '^(P\d+)\s*LRS$')
    if (-not $m.Success) { continue }
    if ($d.meterName -notmatch '^P\d+\s+LRS\s+Disk$' -or $d.retailPrice -le 0) { continue }
    $p = $m.Groups[1].Value
    if (-not $dmap.Contains($p) -or $d.retailPrice -lt $dmap[$p]) { $dmap[$p] = [math]::Round($d.retailPrice, 4) }
  }
  if ($dmap.Count) { $r.storage['premium_ssd_lrs_per_disk_mo'] = $dmap }

  $out.regions[$region] = $r
  Write-Host ("  -> paas:{0} ri:{1} vm:{2}" -f $r.paas.Count, $r.ri.Count, $r.vm.Count) -ForegroundColor Green
}

$out | ConvertTo-Json -Depth 12 -Compress | Set-Content -Path $OutFile -Encoding UTF8
Write-Host "`nWrote $OutFile ($([math]::Round((Get-Item $OutFile).Length/1KB,1)) KB)" -ForegroundColor Yellow
