# SQL Modernization on Azure

Two static pages for planning a SQL Server estate's move to Azure. Both are
fully client-side and self-contained: prices are embedded at build time and
nothing is fetched, uploaded or stored at runtime.

| Page | URL |
|---|---|
| **Cost Estimator** | https://krishna-sunkavalli.github.io/sql-modernization-azure/cost-estimator/ |
| **Deployment Options** | https://krishna-sunkavalli.github.io/sql-modernization-azure/deployment-options/ |

The root redirects to the Cost Estimator.

---

## Cost Estimator

Compares **staying on-premises** against **one chosen Azure target**, side by
side, recalculating as you type. Enter Standard cores, Enterprise cores, a
right-sizing percentage and a region, then pick a target and a commitment term.

Every money line is annual, and the lines in each column sum to the total
beneath them, so the figure at the foot can be checked on screen.

### What it compares

| Column | Contents |
|---|---|
| Stay on-premises | Software Assurance on every core, plus hardware and facilities |
| Modernize to Azure | Software Assurance on the cores still needed for Azure Hybrid Benefit, plus Azure hosting |

Targets are **SQL Server on Azure VM**, **Azure SQL Managed Instance** (General
Purpose) and **Azure SQL Database** (provisioned or serverless). Only one is
compared at a time.

### Defaults

| Input | Default | Range |
|---|---|---|
| Right-sizing | 20% | 0–60% |
| Azure Hybrid Benefit | applied | on/off |
| Commitment term | 3-year reservation | PAYG, 1-year, 3-year |
| On-premises hardware and facilities | $37.50 per core/month ($450/year) | any |
| Share retired by migrating | 100% | 0–100% |
| Commercial discount | 0% | 0–100% |
| Largest deployment size | 16 cores | 4, 8, 16 |

The whole estate is costed both ways; there is no partial-migration control.

### Licensing

Both columns assume the SQL Server licences are **already owned**, so the
comparison is ongoing Software Assurance and infrastructure, not new licence
purchases. SA is charged at published list on both sides: on every core if you
stay on-premises, and on the cores whose rights back Azure Hybrid Benefit if you
migrate.

Azure Hybrid Benefit conversion follows the published table, encoded as a rule
set rather than written into the arithmetic:

| Target | Enterprise licence | Standard licence |
|---|---|---|
| Managed Instance General Purpose | 1 : 4 vCores | 1 : 1 vCore |
| Managed Instance Business Critical | 1 : 1 vCore | 4 : 1 vCore |
| Azure VM covering a Standard deployment | 1 : 4 vCPUs | 1 : 1 vCPU |
| Azure VM covering an Enterprise deployment | 1 : 1 vCPU | 4 : 1 vCPU |

Three further rules apply:

- **Serverless is ineligible.** Its SQL licence is included in the hourly rate.
- **A virtual machine consumes at least four core licences**, whatever its size.
- **Enterprise deployments are matched first.** Spending Enterprise licences on
  Standard workloads first would strand the Enterprise ones behind a four-to-one
  conversion.

A deployment is covered only when the entitlement stretches across the whole of
it; partial coverage never happens. Standard licences covering Enterprise
workloads is permitted at four to one but is deliberately **not** modelled,
which understates the benefit rather than overstating it.

**Windows Azure Hybrid Benefit** deducts the Windows Server uplift embedded in
the VM meter, at its unchanged pay-as-you-go value, because reservations never
discount it.

### Sizing

Right-sized demand is fitted to the **published Azure size ladder** rather than
rounded into uniform blocks, so the last deployment is sized to the remainder.

Supplying an **instance count** changes the topology from inferred to given:
each instance becomes its own deployment. This matters because both VM and
Managed Instance have a four-core floor, so many small instances cost far more
than the same cores consolidated. Eighty one-core servers need 320 vCores, not
80.

Managed Instance is also costed as **instance pools** where that is cheaper. A
two-vCore instance exists only inside a pool, and the pool is the billable unit,
so pooling can halve compute for an estate of small servers. Both topologies
bill the same published per-vCore rate, so the cheaper one is simply whichever
needs fewer vCores, and the model takes it. That is not always the pool: at four
cores per server the instances already sit on the ladder and pool rounding costs
more.

### Serverless

Serverless always produces a figure, but it rests on declared assumptions rather
than measurements, so it is **excluded from the lowest-cost highlight**. Without
a real database count the model assumes a capacity-equivalent layout and a 32 GB
floor, and says so on the card. On real inputs the difference can be five-fold.

Serverless is pay-as-you-go only here: no Azure Hybrid Benefit and no
reservations. Published savings-plan rates are captured as provenance but not
applied, because intermittency needs hourly eligible-usage analysis and
multiplying average active time by a savings-plan rate would hide unused
commitment.

### The softest number

`onPremPerCoreMonth` is the only input that is **not a published price**. At
$450 per core per year it is a planning figure for hardware, storage, power,
cooling, rack and facilities. It is also the largest single lever on the savings
percentage, so it is the first thing to concede if a customer challenges the
model. Software Assurance is roughly three times larger and far more defensible.

---

## Deployment Options

Once an offering fits, this page covers what you still choose inside it: three
offering tabs, each showing three comparison cards, with exact limits behind a
disclosure.

It carries **no application JavaScript**. The offering switch is a radio group
rather than scripted tabs, which already has the keyboard behaviour an ARIA
tablist has to reimplement: arrow keys move between offerings, the group is one
tab stop, and the state is real rather than mirrored into `aria-selected`.
Expanding sections are `<details>`.

Every figure was verified against Microsoft Learn before it was written.
Headline numbers sit on the card faces and per-hardware variations sit in the
disclosures, matching how the documentation is structured. Preview features and
regional restrictions are flagged next to the option they qualify.

---

## Published pricing

The snapshot covers **18 regions** and three reference VM sizes
(`Standard_E4bds_v5`, `E8`, `E16`):

- VM pay-as-you-go, 1 and 3-year reservations, 1 and 3-year compute savings plans.
- Managed Instance General Purpose pay-as-you-go, 1 and 3-year reservations, and
  the verified 1-year database savings plan. The 3-year Managed Instance
  savings-plan option is absent from this snapshot; that is not a claim the
  product can never offer it.
- SQL Database General Purpose Gen5 serverless pay-as-you-go.

SQL Database General Purpose **provisioned** reuses the Managed Instance rates.
The two bill against the same Gen5 compute meter, the published per-vCore price
matches in every captured region, the storage rate is identical in all eighteen,
and the Hybrid Benefit table lists both services on one row. The card discloses
the equivalence rather than implying a difference the data does not support.

Licence list prices, per two-core pack:

| | Purchase | Software Assurance per year |
|---|---|---|
| Standard | $3,945 | $796.08 |
| Enterprise | $15,123 | $3,052.80 |

No blanket commitment discounts are invented. Only one plan is selected per
scenario; reservations and savings plans never stack on the same usage.
Commitments assume 100% hourly utilisation, and three-year projections assume
1-year terms are repurchased at unchanged prices. Unused commitment can erase
apparent savings.

VM reservations use the exact regional Ebdsv5 Linux infrastructure term price
divided by 8,760 or 26,280 hours, plus the Windows pay-as-you-go uplift.
Managed Instance prices come from the first **Standard-series (Gen 5)** table,
first 4-vCore row, divided by four. The extractor matches **exact cell class
tokens, not sequential price order**, because headers and cells differ:

| Cell class | Rate |
|---|---|
| `webdirect-price` | PAYG included |
| `ahb-visible` | PAYG base |
| `one-year-savings` | Savings plan 1-year included |
| `ahb-one-year-savings` | Savings plan 1-year base |
| `one-year-reserved` | Reservation 1-year included |
| `three-year-reserved` | Reservation 3-year included |
| `ahb-three-year-reserved` | Reservation 3-year base |

The absent Managed Instance 1-year base cell is derived as included minus
`(included PAYG − base PAYG)`, because reservation discounts exclude SQL
software. East US per-core PAYG included/base are 0.252184/0.152218; 1-year
reservation 0.198936/0.09897; 3-year 0.168456/0.06849; savings plan
0.20174/0.12177 USD/hour. Tests pin these to detect class mix-ups.

The same trap applies when querying the retail API directly: filter by exact
key, never by position. Taking the *first* reservation row for East US returns
0.041096 instead of 0.068493.

### Sources

- [SQL Server 2022 licence list](https://www.microsoft.com/en-us/sql-server/sql-server-2022-pricing)
- [Managed Instance pricing](https://azure.microsoft.com/en-us/pricing/details/azure-sql-managed-instance/single/)
- [Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
  using `api-version=2023-01-01-preview`, exact region/product/SKU filters
- [Azure Hybrid Benefit](https://learn.microsoft.com/en-us/azure/azure-sql/azure-hybrid-benefit?view=azuresql)
- [Reservation scope](https://learn.microsoft.com/en-us/azure/azure-sql/database/reservations-discount-overview)
- [Serverless billing](https://learn.microsoft.com/en-us/azure/azure-sql/database/serverless-tier-billing?view=azuresql)
- [Managed Instance resource limits](https://learn.microsoft.com/en-us/azure/azure-sql/managed-instance/resource-limits?view=azuresql)
- [SQL Database service tiers](https://learn.microsoft.com/en-us/azure/azure-sql/database/service-tiers-sql-database-vcore?view=azuresql)

Query filters, meter IDs, rate derivations and sources are retained in
`calculator-prices.json`. Missing required pay-as-you-go rates stop the
calculation rather than producing free resources.

**Excluded:** application tier, extended security updates, migration effort,
networking, extra backup storage, disaster recovery, security services, taxes
and free allowances. These comparisons are partial cost, not full TCO.

---

## Building

| Path | Purpose |
|---|---|
| `src/calculator.js` | Cost model and DOM controller |
| `src/calculator.template.html` | Cost Estimator shell |
| `src/calculator-prices.json` | Price snapshot and provenance |
| `src/guide.partial.html` | Deployment Options content |
| `src/app.template.html` | Shared theme tokens and stylesheet, extracted by the build |
| `src/build.ps1` | Builds both pages plus a legacy redirect |
| `src/pull-calculator-prices.ps1` | Refreshes VM, MI, serverless and licence rates |
| `src/calculator.test.js` | Model and pricing regression tests |

```powershell
# optional public price refresh
pwsh .\src\pull-prices.ps1
pwsh .\src\pull-calculator-prices.ps1

node --test .\src\calculator.test.js
pwsh .\src\build.ps1
```

**Never edit the generated pages.** `cost-estimator/index.html`,
`deployment-options/index.html` and the root redirect are build output; edit
`src/` and rebuild. Both pages are light-only; there is no dark theme.

Editing `calculator-prices.json` by hand is possible but write it back with
`JSON.stringify(p, null, 2) + "\n"`, or the diff balloons to thousands of lines.

CI runs the model tests, checks the pages are self-contained and compares fresh
build output. The 65 tests cover pack rounding, discounts, the Hybrid Benefit
rules including the no-reuse and spillover cases, instance pools against single
instances, the four-core floor, plan scopes, serverless bounds and every
captured region, size, plan and benefit combination.

Legacy scanner sources and discovery scripts remain in the tree but are not
invoked and are not published.

## Disclaimer

Personal project, provided as-is under MIT. Not an official Microsoft product,
a licensing determination, a supportability certification or a binding quote.
Planning estimates only: taxes, negotiated discounts and excluded operational
costs can materially change the result. Run an
[Azure Migrate assessment](https://learn.microsoft.com/en-us/azure/migrate/migrate-services-overview)
before committing to a configuration.
