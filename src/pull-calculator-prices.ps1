param([string]$Output = "$PSScriptRoot\calculator-prices.json")
$ErrorActionPreference = 'Stop'
$snapshot = Get-Content "$PSScriptRoot\prices.json" -Raw | ConvertFrom-Json
$miUrl = 'https://azure.microsoft.com/en-us/pricing/details/azure-sql-managed-instance/single/'
$dbUrl = 'https://azure.microsoft.com/en-us/pricing/details/azure-sql-database/single/'
$licenseUrl = 'https://www.microsoft.com/en-us/sql-server/sql-server-2022-pricing'
$miHtml = (Invoke-WebRequest $miUrl -TimeoutSec 60).Content
$dbHtml = (Invoke-WebRequest $dbUrl -TimeoutSec 60).Content

$rateClasses = @('webdirect-price','ahb-visible','one-year-savings','ahb-one-year-savings',
    'one-year-reserved','three-year-reserved','ahb-three-year-reserved','three-year-savings')

# The pricing pages repeat identical <h3> table captions under every service-tier
# <h2>, and some tables carry a copy-pasted aria-label that names the wrong tier.
# Anchor on the tier heading and stop at the next <h2> so a lookup can never drift
# into a neighbouring tier's table.
function Get-TierTables([string]$Html, [string]$H2, [string]$H3) {
    $found = @()
    foreach ($h in [regex]::Matches($Html, "(?is)<h2[^>]*>\s*$([regex]::Escape($H2))\s*</h2>")) {
        $after = $Html.Substring($h.Index + $h.Length)
        $next = [regex]::Match($after, '(?is)<h2[^>]*>')
        if ($next.Success) { $after = $after.Substring(0, $next.Index) }
        foreach ($m in [regex]::Matches($after, "(?is)<h3[^>]*>\s*$([regex]::Escape($H3))\s*</h3>.*?(<table.*?</table>)")) {
            $found += $m.Groups[1].Value
        }
    }
    return $found
}

# Returns the first tbody row's priced cells keyed by class token, plus the unit
# count in column one so per-vCore rates divide by the size actually published.
function Get-RowRates([string]$Table) {
    $row = [regex]::Match($Table, '(?s)<tbody>\s*(<tr>.*?</tr>)').Groups[1].Value
    if (-not $row) { throw 'Pricing table has no body row.' }
    $units = [double][regex]::Match($row, '(?s)<td[^>]*>\s*([\d.]+)\s*</td>').Groups[1].Value
    if ($units -le 0) { throw 'Could not read the vCore count from the first column.' }
    $cells = @{}
    foreach ($cell in [regex]::Matches($row, '(?s)<td[^>]*>.*?</td>')) {
        $amount = [regex]::Match($cell.Value, "data-amount='([^']+)'")
        if (-not $amount.Success) { continue }
        $classes = [regex]::Match($cell.Value, '<td class="([^"]+)"').Groups[1].Value.Split(' ')
        foreach ($name in $rateClasses) {
            if ($classes -contains $name) { $cells[$name] = $amount.Groups[1].Value | ConvertFrom-Json }
        }
    }
    return @{units = $units; cells = $cells}
}

function Get-TierRates([string]$Html, [string]$H2, [string]$H3, [string]$MustMatch, [double]$ExpectUnits) {
    $tables = @(Get-TierTables $Html $H2 $H3)
    if ($MustMatch) { $tables = @($tables | Where-Object { $_ -match $MustMatch }) }
    if ($tables.Count -ne 1) { throw "Expected exactly one '$H3' table under '$H2', found $($tables.Count)." }
    $r = Get-RowRates $tables[0]
    if ($ExpectUnits -gt 0 -and $r.units -ne $ExpectUnits) {
        throw "'$H2' / '$H3' first row is $($r.units) vCores, expected $ExpectUnits."
    }
    return $r
}

# Builds the per-vCore plan table for one service tier. Tiers that publish no
# Azure Hybrid Benefit cell (Hyperscale) simply omit the base rate.
function Build-TierPlans($Rates, [string]$Slug, $ReservedBase) {
    $c = $Rates.cells; $u = $Rates.units
    $inc0 = $c['webdirect-price'].regional.$Slug
    $bas0 = $c['ahb-visible'].regional.$Slug
    if (-not $inc0) { throw "Missing pay-as-you-go rate for $Slug." }
    $payg = @{included = $inc0 / $u}
    if ($bas0) { $payg.base = $bas0 / $u }
    $plans = [ordered]@{payg = $payg}
    foreach ($term in @(@('sp1','one-year-savings','ahb-one-year-savings'),
                        @('ri3','three-year-reserved','ahb-three-year-reserved'))) {
        $inc = $c[$term[1]].regional.$Slug
        $bas = $c[$term[2]].regional.$Slug
        if ($inc -gt 0) {
            $plan = @{included = $inc / $u}
            if ($bas -gt 0) { $plan.base = $bas / $u }
            $plans[$term[0]] = $plan
        }
    }
    $ri1 = $c['one-year-reserved'].regional.$Slug
    if ($ri1 -gt 0) {
        $plan = @{included = $ri1 / $u}
        # Reservations exclude software charges; derive the absent RI1 AHB cell
        # by subtracting the same published PAYG SQL licensing component.
        if ($bas0 -and $ri1 -gt ($inc0 - $bas0)) {
            $plan.base = ($ri1 - ($inc0 - $bas0)) / $u
            $plan.baseDerived = $true
        }
        $plans['ri1'] = $plan
    }
    # The pricing page rounds reserved rates to five decimals for display, which
    # is enough to drift a few cents a year on a large reserved estate. The
    # retail API publishes the reservation as a term total, so dividing it by the
    # term's hours recovers the exact rate. Verified against the calculator's own
    # rate feed, which carries the same unrounded value.
    if ($ReservedBase) {
        foreach ($term in @('ri1','ri3')) {
            if ($plans[$term] -and $null -ne $ReservedBase[$term]) {
                $plans[$term].base = $ReservedBase[$term]
                $plans[$term].Remove('baseDerived')
            }
        }
    }
    return $plans
}

$gen5 = 'Standard-series (Gen 5)'
$provHead = '(?is)>\s*vCORE\s*<'
$srvHead = '(?is)>\s*Minimum vCores\s*<'

$miGp = Get-TierRates $miHtml 'General purpose' $gen5 $provHead 4
$miBc = Get-TierRates $miHtml 'Business critical' $gen5 $provHead 4
$miNext = Get-TierRates $miHtml 'Next generation general purpose' $gen5 $provHead 4
$miCells = $miGp.cells
if (-not $miCells['webdirect-price'] -or -not $miCells['ahb-visible']) { throw 'MI PAYG cells missing.' }
if (-not $miBc.cells['webdirect-price'] -or -not $miBc.cells['ahb-visible']) { throw 'MI Business Critical cells missing.' }

# Next-generation General Purpose is an architecture change, not a separate billed
# tier: Microsoft states the invoice still reads "General Purpose". Assert that so
# the calculator can keep pricing it as GP rather than inventing a fourth tier.
if ($miNext.cells['webdirect-price'].regional.'us-east' -ne $miCells['webdirect-price'].regional.'us-east') {
    throw 'Next-gen General Purpose no longer matches General Purpose pricing; revisit the tier model.'
}

$hsProv = Get-TierRates $dbHtml 'Hyperscale' $gen5 $provHead 0
$hsSrv = Get-TierRates $dbHtml 'Hyperscale' $gen5 $srvHead 0
$hsStoreTables = @(Get-TierTables $dbHtml 'Hyperscale' 'Storage')
if (-not $hsStoreTables.Count) { throw 'Hyperscale storage table not found.' }
# The storage table states a flat GB/month rate: its first column is a label
# rather than a vCore count, and the priced cell carries no class token.
$hsStoreRow = [regex]::Match($hsStoreTables[0], '(?s)<tbody>\s*(<tr>.*?</tr>)').Groups[1].Value
$hsStoreAmount = [regex]::Match($hsStoreRow, "data-amount='([^']+)'")
if (-not $hsStoreAmount.Success) { throw 'Hyperscale storage rate not found.' }
$hsStoreRegional = ($hsStoreAmount.Groups[1].Value | ConvertFrom-Json).regional

# Azure Hybrid Benefit does not apply to new Hyperscale databases. The published
# tables prove it structurally by carrying no ahb-* cells at all; if that ever
# changes the calculator's ineligibility rule needs revisiting.
foreach ($t in @($hsProv, $hsSrv)) {
    foreach ($k in $t.cells.Keys) { if ($k -like 'ahb-*') { throw 'Hyperscale now publishes an AHB rate; revisit AHB eligibility.' } }
}

function Get-RetailItems([string]$Filter) {
    $url = 'https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=' + [uri]::EscapeDataString($Filter)
    do {
        $response = Invoke-RestMethod $url -TimeoutSec 90
        $response.Items
        $url = $response.NextPageLink
    } while ($url)
}
# Reserved rates are published as a term total rather than an hourly rate, so
# dividing by the term's hours recovers the exact per-vCore figure without the
# rounding the pricing page applies for display.
$RESERVATION_HOURS = @{ri1 = 8760; ri3 = 26280}
function Get-ReservedBase([string]$ProductName, [string]$Region) {
    $filter = "serviceName eq 'SQL Managed Instance' and armRegionName eq '$Region' and productName eq '$ProductName' and skuName eq 'vCore' and type eq 'Reservation'"
    $items = @(Get-RetailItems $filter | Where-Object { $_.meterName -eq 'vCore' -and $_.unitOfMeasure -eq '1 Hour' })
    $out = @{}
    foreach ($pair in @(@('ri1','1 Year'), @('ri3','3 Years'))) {
        $match = @($items | Where-Object { $_.reservationTerm -eq $pair[1] })
        if ($match.Count -eq 1 -and $match[0].retailPrice -gt 0) {
            $out[$pair[0]] = $match[0].retailPrice / $RESERVATION_HOURS[$pair[0]]
        }
    }
    return $out
}

function Get-UniqueRate($Items, [string]$Label) {
    $values = @($Items | ForEach-Object { $_.retailPrice } | Sort-Object -Unique)
    if ($values.Count -ne 1 -or $values[0] -le 0) { throw "Missing or ambiguous price: $Label." }
    return [double]$values[0]
}
$licenseHtml = (Invoke-WebRequest $licenseUrl -TimeoutSec 60).Content
if ($licenseHtml -notmatch '\$15,123' -or $licenseHtml -notmatch '\$3,945') {
    throw 'Published SQL Server 2022 list prices changed; review license pack assumptions.'
}
$vmLicense = @{}
foreach ($edition in @('Standard','Enterprise')) {
    $filter = "serviceName eq 'Virtual Machines Licenses' and productName eq 'SQL Server $edition' and skuName eq '64 vCPU VM' and priceType eq 'Consumption'"
    $url = 'https://prices.azure.com/api/retail/prices?$filter=' + [uri]::EscapeDataString($filter)
    $items = (Invoke-RestMethod $url -TimeoutSec 60).Items
    $values = @($items | Where-Object { $_.unitOfMeasure -eq '1 Hour' -and $_.retailPrice -gt 0 } |
        ForEach-Object { $_.retailPrice / 64 } | Sort-Object -Unique)
    if ($values.Count -ne 1) { throw "Ambiguous or missing $edition SQL VM license meter." }
    $vmLicense[$edition.ToLowerInvariant()] = $values[0]
}
$regionMap = [ordered]@{
    eastus='us-east'; eastus2='us-east-2'; westus2='us-west-2'; westus3='us-west-3'
    centralus='us-central'; southcentralus='us-south-central'; northeurope='europe-north'
    westeurope='europe-west'; uksouth='united-kingdom-south'; francecentral='france-central'
    germanywestcentral='germany-west-central'; swedencentral='sweden-central'
    southeastasia='asia-pacific-southeast'; australiaeast='australia-east'
    japaneast='japan-east'; centralindia='central-india'; canadacentral='canada-central'; brazilsouth='brazil-south'
}
$regions = [ordered]@{}
foreach ($key in $regionMap.Keys) {
    $name = $regionMap[$key]
    $i = $miCells['webdirect-price'].regional.$name
    $b = $miCells['ahb-visible'].regional.$name
    $r = $snapshot.regions.$key
    if (-not $i -or -not $b -or -not $r) { throw "Missing price for $key ($name)." }
    $vmFilter = "serviceName eq 'Virtual Machines' and armRegionName eq '$key' and (productName eq 'Virtual Machines Ebdsv5 Series' or productName eq 'Virtual Machines Ebdsv5 Series Windows')"
    $vmItems = @(Get-RetailItems $vmFilter)
    $vmPlans = [ordered]@{}
    foreach ($size in @(4,8,16)) {
        $sku = "Standard_E${size}bds_v5"
        $linux = @($vmItems | Where-Object { $_.armSkuName -eq $sku -and $_.skuName -eq $sku -and $_.productName -eq 'Virtual Machines Ebdsv5 Series' -and $_.type -eq 'Consumption' -and $_.unitOfMeasure -eq '1 Hour' })
        $windows = @($vmItems | Where-Object { $_.armSkuName -eq $sku -and $_.skuName -eq $sku -and $_.productName -eq 'Virtual Machines Ebdsv5 Series Windows' -and $_.type -eq 'Consumption' -and $_.unitOfMeasure -eq '1 Hour' })
        $l = Get-UniqueRate $linux "$key $sku Linux"
        $w = Get-UniqueRate $windows "$key $sku Windows"
        if ($w -lt $l) { throw 'Windows license uplift is negative.' }
        $plans = [ordered]@{payg=$w}
        foreach ($term in @(@('1 Year','ri1',8760), @('3 Years','ri3',26280))) {
            $ri = @($vmItems | Where-Object { $_.armSkuName -eq $sku -and $_.skuName -eq $sku -and $_.productName -eq 'Virtual Machines Ebdsv5 Series' -and $_.type -eq 'Reservation' -and $_.reservationTerm -eq $term[0] -and $_.unitOfMeasure -eq '1 Hour' })
            if ($ri.Count) { $plans[$term[1]] = (Get-UniqueRate $ri "$key $sku $($term[0])") / $term[2] + ($w - $l) }
        }
        foreach ($term in @(@('1 Year','sp1'), @('3 Years','sp3'))) {
            $sp = @($linux | ForEach-Object { $_.savingsPlan } | Where-Object { $_.term -eq $term[0] })
            if ($sp.Count) { $plans[$term[1]] = (Get-UniqueRate $sp "$key $sku savings $($term[0])") + ($w - $l) }
        }
        $vmPlans[$sku] = @{
            rates=$plans; windowsLicensePerHour=($w-$l)
            meterIds=@(@($linux.meterId) + @($windows.meterId) | Sort-Object -Unique)
            filter=$vmFilter; reservationHours=@{ri1=8760;ri3=26280}
        }
        $r.vm.$sku.windows = $w
        $r.vm.$sku.linux = $l
    }
    $miPlans = Build-TierPlans $miGp $name (Get-ReservedBase 'SQL Managed Instance General Purpose - Compute Gen5' $key)
    $miBcPlans = Build-TierPlans $miBc $name (Get-ReservedBase 'SQL Managed Instance Business Critical - Compute Gen5' $key)
    $hsPlans = Build-TierPlans $hsProv $name
    $hsServerlessPerSecond = $hsSrv.cells['webdirect-price'].regional.$name
    if (-not $hsServerlessPerSecond) { throw "Missing Hyperscale serverless rate for $key." }
    $hsStoragePerGbMonth = $hsStoreRegional.$name
    if (-not $hsStoragePerGbMonth) { throw "Missing Hyperscale storage rate for $key." }
    $serverlessFilter = "serviceName eq 'SQL Database' and armRegionName eq '$key' and productName eq 'SQL Database General Purpose - Serverless - Compute Gen5' and skuName eq '1 vCore' and meterName eq 'vCore' and priceType eq 'Consumption'"
    $serverless = @(Get-RetailItems $serverlessFilter | Where-Object { $_.unitOfMeasure -eq '1 Hour' })
    $serverlessRate = Get-UniqueRate $serverless "$key serverless Gen5"
    if (-not $r.storage.mi_gp_per_gb_mo -or -not $r.storage.db_gp_per_gb_mo -or -not $r.storage.premium_ssd_lrs_per_disk_mo.P10) {
        throw "Missing storage prices for $key."
    }
    # The infrastructure snapshot carried a Hyperscale backup meter under the data
    # storage key. Hyperscale bills allocated data storage at its own published
    # rate, so overwrite it from the pricing page rather than trusting the snapshot.
    $r.storage.db_hs_per_gb_mo = $hsStoragePerGbMonth
    $regions[$key] = @{
        miBasePerCoreHour = $b / 4
        miIncludedPerCoreHour = $i / 4
        miPlans = $miPlans
        miBcPlans = $miBcPlans
        hyperscalePlans = $hsPlans
        hyperscaleServerlessPerCoreHour = [math]::Round($hsServerlessPerSecond * 3600, 8)
        vmPlans = $vmPlans
        serverless = @{
            paygPerCoreHour=$serverlessRate
            meterIds=@($serverless.meterId | Sort-Object -Unique)
            filter=$serverlessFilter
            savingsPlanRates=@($serverless[0].savingsPlan)
            commitmentNote='Published savings-plan rates captured for reference, not modeled: hourly eligible usage/commitment sharing must be established separately.'
        }
        vm = $r.vm
        storage = $r.storage
    }
    Write-Output "Captured $key PAYG, reservations and available savings plans."
}
$result = [ordered]@{
    captured = (Get-Date).ToUniversalTime().ToString('o')
    infrastructureSnapshot = $snapshot.generated
    currency = 'USD'
    sql2022Pack = @{standard=3945; enterprise=15123}
    # Software Assurance list for a two-core pack, priced annually alongside the
    # licence itself. Held with the licence pack so both move together when the
    # published SQL Server price list changes.
    sqlSaPack = @{standard=796.08; enterprise=3052.8}
    vmLicensePerCoreHour = $vmLicense
    sources = @{
        mi=$miUrl; db=$dbUrl; onPremLicense=$licenseUrl; infrastructure='https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview'
        miTable='Standard-series (Gen 5) table anchored on its service-tier <h2>, first 4-vCore row; per-core rates divided by 4. Cells selected by exact class token, not position, because the pages repeat table captions across tiers and some aria-labels name the wrong tier.'
        miRI1Base='Derived included RI1 minus (included PAYG - AHB PAYG); reservations do not discount SQL software.'
        nextGen='Next-generation General Purpose is an architecture change, not a separate billed tier: Microsoft states the invoice still reads General Purpose. The pull asserts its published rates equal General Purpose and the calculator prices it as GP.'
        hyperscale='Azure SQL Database Hyperscale, Standard-series (Gen 5). Provisioned and serverless tables are told apart by their first column header (vCORE against Minimum vCores), never by order.'
        hyperscaleAhb='Azure Hybrid Benefit is not available for new Hyperscale databases. The published Hyperscale tables carry no ahb-* cells at all; the pull fails if one ever appears.'
        hyperscaleStorage='Hyperscale bills allocated data storage at its own published rate, captured from the Hyperscale Storage table.'
        elasticPool='Azure lists single databases and elastic pools on one meter (Single/Elastic Pool ... Compute Gen5) at the same vCore price, so pools reuse the single-database rate and drop the per-database charge.'
        reservations='https://learn.microsoft.com/en-us/azure/azure-sql/database/reservations-discount-overview'
        vmCommitments='Linux base reservation total / term hours or Linux savingsPlan hourly rate + unchanged Windows PAYG uplift; SQL licensing and storage separate.'
        serverless='https://learn.microsoft.com/en-us/azure/azure-sql/database/serverless-tier-billing'
        serverlessLimits='https://learn.microsoft.com/en-us/azure/azure-sql/database/resource-limits-vcore-single-databases'
    }
    regions = $regions
}
$result | ConvertTo-Json -Depth 12 | Set-Content $Output -Encoding UTF8
Write-Output "Built calculator prices for $($regions.Count) regions."
