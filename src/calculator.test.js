const test = require("node:test");
const assert = require("node:assert/strict");
const {calculateCoreOptions} = require("./calculator.js");
const livePrices = require("./calculator-prices.json");

const fixture = {
  sql2022Pack: {standard:3945, enterprise:15123},
  sqlSaPack: {standard:796.08, enterprise:3052.80},
  vmLicensePerCoreHour: {standard: 0.1, enterprise: 0.375},
  regions: {test: {
    miPlans: {payg: {base: 0.15, included: 0.25}, ri1: {base: 0.12, included: 0.22},
      ri3: {base: 0.08, included: 0.18}, sp1: {base: 0.12, included: 0.2}},
    miBcPlans: {payg: {base: 0.30, included: 0.675}, ri1: {base: 0.24, included: 0.56},
      ri3: {base: 0.16, included: 0.50}, sp1: {base: 0.24, included: 0.54}},
    hyperscalePlans: {payg: {included: 0.18}, ri1: {included: 0.12},
      ri3: {included: 0.08}, sp1: {included: 0.14}},
    hyperscaleServerlessPerCoreHour: 0.378,
    vmPlans: Object.fromEntries([4,8,16].map(n => [`Standard_E${n}bds_v5`, {
      rates: {payg: n / 10, ri1: n * 0.08, ri3: n * 0.06, sp1: n * 0.09, sp3: n * 0.07},
      windowsLicensePerHour: n * 0.046,
    }])),
    serverless: {paygPerCoreHour: 0.5},
    storage: {mi_gp_per_gb_mo: 0.1, mi_bc_per_gb_mo: 0.25, db_gp_per_gb_mo: 0.12,
      db_hs_per_gb_mo: 0.25, premium_ssd_lrs_per_disk_mo: {
      P4: 3, P6: 5, P10: 10, P15: 20, P20: 40, P30: 80,
      P40: 160, P50: 320, P60: 640, P70: 1280, P80: 2560,
    }},
  }},
};
// Existing cases pin the pre-default baseline explicitly so they keep asserting
// unbenefited pay-as-you-go behaviour; the shipped defaults are covered separately.
const defaults = {standard: 16, enterprise: 0, migrationPct: 100, rightSizePct: 0,
  region: "test", unitCores: 16, licenseBasis: "existing", onPremPerCoreMonth: 0,
  ahb: false, vmPlan: "payg", miPlan: "payg"};
const serverless = {serverlessEnabled: true, databaseCount: 2, storageGB: 100,
  serverlessMin: 1, serverlessMax: 8, serverlessBillable: 2, activePct: 25};
const run = changes => calculateCoreOptions({...defaults, ...changes}, fixture);
const near = (a,b) => assert.ok(Math.abs(a-b) < 0.000001, `${a} != ${b}`);

test("four alternatives: PAYG VM/MI includes SQL/storage; unconfigured serverless is not zero", () => {
  const r = run();
  const [vm,mi,s] = r.scenarios;
  assert.equal(r.scenarios.length, 3);
  near(vm.monthly, 16 * 0.1 * 730 + 16 * 0.1 * 730 + 10);
  // A 16-vCore instance with unspecified storage sits at the 32 GB floor, which
  // Managed Instance includes at no charge, so compute is the whole bill.
  near(mi.monthly, 16 * 0.25 * 730);
  // Serverless is directional rather than blank when its inputs are unset.
  assert.equal(s.status, "ready");
  assert.ok(s.monthly > 0);
  assert.ok(s.assumed.length > 0);
});
test("the shipped default owns its licenses and pays only Software Assurance", () => {
  const r = calculateCoreOptions({standard: 100, enterprise: 40, migrationPct: 50, region: "test"}, fixture);
  assert.equal(r.input.licenseBasis,"existing");
  // Scoped to the 70 migrating cores, not the 140-core footprint.
  near(r.baseline.infrastructure, 70 * 37.5);
  // Licenses are already paid for, so no column carries a purchase.
  near(r.baseline.upfront,0);
  for (const s of r.scenarios) near(s.upfront,0);
  // SA is the recurring licensing cost on the in-scope cores if they stay put.
  near(r.baseline.sa, 50*796.08/24 + 20*3052.80/24);
  near(r.baseline.threeYear,36*(70*37.5+r.baseline.sa));
  assert.equal(r.input.rightSizePct,20);
  // Hardware and facilities for the migrated cores retire with the servers, so
  // the default is that all of it goes.
  assert.equal(r.input.avoidablePct,100);
  assert.equal(r.input.discountPct,0);
  // The remainder is reported as context, never inside the comparison, and it
  // carries no purchase either.
  assert.equal(r.retainedContext.cores,70);
  near(r.retainedContext.infrastructure,70*37.5);
  near(r.retainedContext.upfront,0);
  assert.equal(r.baseline.onPrem,undefined);
});
test("opting into a refresh adds the published two-core packs on the staying column only", () => {
  const r = calculateCoreOptions({standard: 100, enterprise: 40, migrationPct: 50,
    region: "test", licenseBasis: "refresh"}, fixture);
  near(r.baseline.upfront,25*3945+10*15123);
  for (const s of r.scenarios) near(s.upfront,0);
  near(r.retainedContext.upfront,25*3945+10*15123);
});
test("the retained remainder is contextual and cannot move the comparison", () => {
  // Same 30 migrating cores reached from two very different footprints.
  const small = run({standard:60, enterprise:0, migrationPct:50, licenseBasis:"refresh", onPremPerCoreMonth:50});
  const large = run({standard:300, enterprise:0, migrationPct:10, licenseBasis:"refresh", onPremPerCoreMonth:50});
  assert.equal(small.moved.standard, 30);
  assert.equal(large.moved.standard, 30);
  near(small.baseline.threeYear, large.baseline.threeYear);
  for (let i = 0; i < small.scenarios.length; i++) {
    if (small.scenarios[i].status !== "ready") continue;
    near(small.scenarios[i].threeYear, large.scenarios[i].threeYear);
    near(small.scenarios[i].deltaPct, large.scenarios[i].deltaPct);
  }
  // Only the out-of-scope context differs.
  assert.equal(small.retainedContext.cores, 30);
  assert.equal(large.retainedContext.cores, 270);
  near(small.retainedContext.infrastructure, 30*50);
  near(large.retainedContext.infrastructure, 270*50);
});
test("a migration that rounds down to zero cores is rejected, not silently priced at zero", () => {
  assert.throws(() => run({standard:1, enterprise:1, migrationPct:25}), /rounds down to zero cores/);
  assert.throws(() => run({standard:50, enterprise:0, migrationPct:0}), /Move at least some cores/);
  // One core is enough to compare.
  const ok = run({standard:4, enterprise:0, migrationPct:25});
  assert.equal(ok.moved.standard, 1);
  assert.equal(ok.retainedContext.cores, 3);
});
test("every column prices the same in-scope cores; the remainder sits outside", () => {
  const r=run({...serverless,standard:100,enterprise:40,migrationPct:25,
    onPremPerCoreMonth:10,licenseBasis:"refresh",avoidablePct:50});
  assert.deepEqual(r.moved,{standard:25,enterprise:10});
  assert.deepEqual(r.retained,{standard:75,enterprise:30});
  assert.equal(r.baseline.scopedCores,35);
  near(r.baseline.infrastructure,35*10);
  for(const s of r.scenarios) {
    assert.equal(s.scopedCores,35);
    // Azure keeps only the share of in-scope hardware that is not retired.
    near(s.infrastructure,35*10*0.5);
    near(s.upfront,0);
  }
  assert.equal(r.retainedContext.cores,105);
  near(r.retainedContext.infrastructure,105*10);
  near(r.retainedContext.upfront,Math.ceil(75/2)*3945+15*15123);
});
test("hardware retired by migrating defaults to all of it, and the dial still works", () => {
  // The per-core rate is hardware and facilities for the migrated cores, so the
  // servers retire with the migration and nothing is carried into Azure. The
  // dial exists for dual-run periods and fixed facility costs that cannot shrink.
  const d = run({...serverless, onPremPerCoreMonth: 37.5});
  assert.equal(d.input.avoidablePct, 100);
  for (const s of d.scenarios) near(s.infrastructure, 0);
  // The on-premises column always carries the whole of it, whatever the dial says.
  near(d.baseline.infrastructure, 16 * 37.5);
  const half = run({...serverless, onPremPerCoreMonth: 37.5, avoidablePct: 50});
  near(half.baseline.infrastructure, 16 * 37.5);
  for (const s of half.scenarios) near(s.infrastructure, 16 * 37.5 * 0.5);
});

test("the retired share sweeps correctly across its whole range", () => {
  for(const avoidablePct of [0,50,100]) {
    const r=run({...serverless,avoidablePct,onPremPerCoreMonth:37.5});
    for(const s of r.scenarios) near(s.infrastructure,16*37.5*(1-avoidablePct/100));
  }
});
test("existing-license mode excludes sunk purchases; AHB assumes existing eligible rights", () => {
  const r=run({...serverless,ahb:true});
  for(const s of [r.baseline,...r.scenarios]) near(s.upfront,0);
  assert.equal(r.scenarios[0].sqlLicense,0);
  assert.equal(r.scenarios[1].sqlLicense,0);
});
test("refresh buys only for in-scope cores that stay; moving them avoids the purchase", () => {
  for(const migrationPct of [25,50,100]) for(const ahb of [false,true]) {
    const r=run({...serverless,standard:33,enterprise:17,migrationPct,ahb,licenseBasis:"refresh"});
    // The baseline buys packs for the migrated slice only.
    near(r.baseline.upfront,Math.ceil(r.moved.standard/2)*3945+Math.ceil(r.moved.enterprise/2)*15123);
    // The retained remainder's purchase sits in context, outside the comparison.
    near(r.retainedContext.upfront,Math.ceil(r.retained.standard/2)*3945+Math.ceil(r.retained.enterprise/2)*15123);
    for(const s of r.scenarios) {
      near(s.upfront,0);
      near(s.threeYear,s.monthly*36);
      near(s.deltaThreeYear,s.threeYear-r.baseline.threeYear);
      if (r.baseline.threeYear > 0) near(s.deltaPct,s.deltaThreeYear/r.baseline.threeYear*100);
    }
  }
});
test("single additional discount applies to purchases and selected Azure charges, never operations", () => {
  for(const licenseBasis of ["refresh","existing"]) for(const vmPlan of ["payg","ri1","sp3"]) for(const miPlan of ["payg","ri3","sp1"]) {
    const input={...serverless,standard:100,enterprise:40,onPremPerCoreMonth:37.5,licenseBasis,vmPlan,miPlan};
    const undiscounted=run(input);
    for(const discountPct of [0,10,100]) {
      const r=run({...input,discountPct});
      for(const [index,s] of [r.baseline,...r.scenarios].entries()) {
        const original=[undiscounted.baseline,...undiscounted.scenarios][index], factor=1-discountPct/100;
        near(s.infrastructure,original.infrastructure);
        for(const component of ["upfront","compute","sqlLicense","storage"]) near(s[component],original[component]*factor);
        near(s.threeYear,s.upfront+36*s.monthly);
      }
    }
  }
});
test("missing published license prices fail refresh but do not recharge existing licenses", () => {
  const broken=structuredClone(fixture); delete broken.sql2022Pack.standard;
  assert.throws(()=>calculateCoreOptions({...defaults,licenseBasis:"refresh"},broken),/two-core pack/);
  assert.equal(calculateCoreOptions(defaults,broken).baseline.upfront,0);
});
test("AHB never reuses retained rights or partially covers a deployment", () => {
  // Entitlement exactly matches the fitted deployment, so it is fully covered.
  const exact=run({standard:16,migrationPct:50,ahb:true});
  assert.deepEqual(exact.scenarios[0].sizes,[8]);
  for(const s of exact.scenarios.slice(0,2)) assert.equal(s.coveredCores,8);
  // Retained rights are never pooled: 8 of 16 cores move, so only 8 are eligible
  // even though the footprint holds 16.
  near(exact.scenarios[0].sa, 8*796.08/24);
  // 10 source cores fit as 8 + 4 = 12 vCores. On VM the 1:1 entitlement covers
  // the 8, but the leftover 2 cannot part-cover the 4, so it pays the meter.
  const partial=run({standard:0,enterprise:10,ahb:true});
  assert.deepEqual(partial.scenarios[0].sizes,[8,4]);
  assert.equal(partial.scenarios[0].coveredCores,8);
  assert.ok(partial.scenarios[0].sqlLicense>0);
  // MI stretches Enterprise 4:1, so 10 source cores entitle 40 vCores and both
  // deployments are covered outright.
  assert.equal(partial.scenarios[1].coveredCores,12);
  near(partial.scenarios[1].sqlLicense,0);
});
test("right-sizing is not an entitlement ratio and serverless is sized independently", () => {
  const r=run({...serverless,standard:0,enterprise:20,rightSizePct:20,ahb:true});
  assert.equal(r.required.enterprise,16);
  for(const s of r.scenarios.slice(0,2)) assert.equal(s.azureCores,16);
  const without=run({...serverless,standard:0,enterprise:20,rightSizePct:0});
  near(r.scenarios[2].monthly,without.scenarios[2].monthly);
});
test("AHB charges SA on the backing cores, stays net cheaper, and never applies to serverless", () => {
  const without=run(serverless), withAHB=run({...serverless,ahb:true});
  for(let i=0;i<2;i++) {
    assert.equal(withAHB.scenarios[i].coveredCores,16);
    assert.equal(withAHB.scenarios[i].onPrem,undefined);
    assert.equal(withAHB.scenarios[i].sqlLicense,0);
    // The benefit is not free: SA is charged on the 16 source cores backing it.
    near(withAHB.scenarios[i].sa,16*796.08/24);
    near(without.scenarios[i].sa,0);
    // It still has to beat paying the Azure SQL licence meter outright.
    assert.ok(withAHB.scenarios[i].monthly<without.scenarios[i].monthly);
  }
  near(withAHB.baseline.threeYear,without.baseline.threeYear);
  near(withAHB.scenarios[2].threeYear,without.scenarios[2].threeYear);
  near(withAHB.scenarios[2].sa,0);
});
test("a single core still produces a valid minimum deployment", () => {
  const r=run({standard:1,enterprise:1});
  assert.deepEqual(r.moved,{standard:1,enterprise:1});
  assert.deepEqual(r.retained,{standard:0,enterprise:0});
  // Each edition is sized separately, so each gets the smallest valid size.
  for(const s of r.scenarios.slice(0,2)) {
    assert.deepEqual(s.sizes,[4,4]);
    assert.equal(s.azureCores,8);
  }
});
test("invalid core, migration, discount, purchase basis, scope and plan inputs fail explicitly", () => {
  for(const bad of [{standard:0,enterprise:0},{standard:-1},{standard:1.5},{migrationPct:101},
    {migrationPct:-1},{migrationPct:NaN},{rightSizePct:61},
    {region:"missing"},{unitCores:6},{ahb:"yes"},{vmPlan:"ri1+sp1"},{storageGB:NaN},
    {avoidablePct:-1},{discountPct:NaN},{discountPct:-1},{discountPct:101},{licenseBasis:"annual"}]) assert.throws(()=>run(bad));
});
test("missing PAYG and storage rates fail rather than creating free resources", () => {
  for(const mutate of [
    p=>delete p.regions.test.vmPlans.Standard_E16bds_v5,
    p=>delete p.regions.test.miPlans.payg,
    p=>delete p.regions.test.serverless.paygPerCoreHour,
    p=>delete p.regions.test.storage.db_gp_per_gb_mo,
  ]) {
    const broken=structuredClone(fixture); mutate(broken);
    assert.throws(()=>calculateCoreOptions({...defaults,...serverless},broken),/Missing or invalid published rate/);
  }
});
test("unsupported commitments are unavailable, not a PAYG or zero fallback", () => {
  const r=run({miPlan:"sp3"});
  assert.equal(r.scenarios[1].status,"unavailable");
  assert.match(r.scenarios[1].reason,/no verified/);
  assert.equal(r.scenarios[1].monthly,null);
  assert.equal(r.scenarios[0].status,"ready");
});
test("reservations and savings plans discount VM infrastructure only; SQL/storage unchanged", () => {
  const payg=run({storageGB:1000});
  for(const plan of ["ri1","ri3","sp1","sp3"]) {
    const s=run({storageGB:1000,vmPlan:plan}).scenarios[0];
    assert.ok(s.compute<payg.scenarios[0].compute);
    near(s.sqlLicense,payg.scenarios[0].sqlLicense);
    near(s.storage,payg.scenarios[0].storage);
    near(s.threeYear,s.monthly*36);
  }
});
test("MI uses correct plan-specific included/base rates with independent AHB", () => {
  for(const [miPlan, rates] of Object.entries(fixture.regions.test.miPlans)) {
    for(const ahb of [false,true]) {
      const s=run({miPlan,ahb}).scenarios[1];
      near(s.compute,16*730*rates.base);
      near(s.sqlLicense,ahb?0:16*730*(rates.included-rates.base));
    }
  }
});
test("oversized MI storage only blocks MI; data storage costs are separate", () => {
  const low=run(), high=run({storageGB:1000});
  for(let i=0;i<2;i++) assert.ok(high.scenarios[i].storage>low.scenarios[i].storage);
  const huge=run({standard:4,unitCores:4,storageGB:3000});
  assert.equal(huge.scenarios[1].status,"unavailable");
  assert.match(huge.scenarios[1].reason,/MI GP Gen5 storage needs/);
  // The remedy has to be the one that actually works: storage is divided across
  // instances, so more instances lowers the per-instance figure.
  assert.match(huge.scenarios[1].reason,/more instances/);
});
test("serverless gives directional guidance when count and storage are unset, and labels it", () => {
  // No database count: a capacity-equivalent count is assumed from right-sized
  // demand divided by the chosen maximum, and declared on the result.
  const bare = run({standard: 40, enterprise: 0, migrationPct: 100, rightSizePct: 0,
    serverlessMax: 8, onPremPerCoreMonth: 0});
  const s = bare.scenarios[2];
  assert.equal(s.status, "ready");
  assert.equal(s.deployments, 5);
  assert.ok(s.monthly > 0);
  assert.equal(s.assumed.length, 2);
  assert.match(s.assumed[0], /5 database\(s\) assumed/);
  assert.match(s.assumed[1], /32 GB per database assumed/);
  // Storage is never dropped just because it was not entered.
  near(s.storage, 5 * 32 * 1.3 * 0.12);   // +30% log allowance
  // Supplying the real figures removes the assumptions entirely.
  const exact = run({standard: 40, enterprise: 0, migrationPct: 100, rightSizePct: 0,
    databaseCount: 5, storageGB: 160, onPremPerCoreMonth: 0});
  assert.equal(exact.scenarios[2].assumed.length, 0);
  near(exact.scenarios[2].storage, 5 * 32 * 1.3 * 0.12);   // +30% log allowance
  // An explicitly entered count is never overridden by the assumption.
  const explicit = run({...serverless, databaseCount: 7});
  assert.equal(explicit.scenarios[2].deployments, 7);
  assert.equal(explicit.scenarios[2].assumed.length, 0);
  assert.throws(()=>run({...serverless,databaseCount:0}),/database count/);
  assert.throws(()=>run({...serverless,databaseCount:1.5}),/database count/);
});
test("the assumed database count scales with the maximum vCores per database", () => {
  for (const [max, expected] of [[2, 20], [4, 10], [8, 5]]) {
    const r = run({standard: 40, enterprise: 0, migrationPct: 100, rightSizePct: 0,
      serverlessMax: max, serverlessMin: max === 8 ? 1 : 0.5, serverlessBillable: 1, onPremPerCoreMonth: 0});
    assert.equal(r.scenarios[2].deployments, expected, `max ${max}`);
    // Total configured ceiling always covers the right-sized demand.
    assert.ok(r.scenarios[2].azureCores >= 40);
  }
});
test("serverless 0/25/100 online percent bills online compute and all-month storage", () => {
  for(const activePct of [0,25,100]) {
    const s=run({...serverless,activePct,onPremPerCoreMonth:10,avoidablePct:50}).scenarios[2];
    near(s.compute,2*2*730*activePct/100*0.5);
    near(s.storage,100*1.3*0.12);   // +30% log allowance
    near(s.infrastructure,80);
    near(s.monthly,s.compute+s.storage+80);
  }
});
test("serverless configured ranges and memory-normalized billing floor validated", () => {
  for(const changes of [{serverlessMax:6},{serverlessMin:0.5},{serverlessMin:9},{serverlessBillable:0.9},
    {serverlessBillable:9},{serverlessMin:1.25},{activePct:101},{activePct:NaN}]) assert.throws(()=>run({...serverless,...changes}));
  assert.throws(()=>run({...serverless,serverlessMax:4,serverlessMin:0.5,serverlessBillable:0.5}),/memory-normalized/);
  assert.equal(run({...serverless,serverlessMax:4,serverlessMin:0.5,serverlessBillable:0.7}).scenarios[2].status,"ready");
  assert.throws(()=>run({...serverless,serverlessMax:2,serverlessMin:0.5,serverlessBillable:0.68}),/memory-normalized/);
  assert.equal(run({...serverless,serverlessMax:2,serverlessMin:0.5,serverlessBillable:0.69}).scenarios[2].status,"ready");
});
test("serverless storage enforces conservative 1–1024 GB per DB and rounds up", () => {
  const s=run({...serverless,storageGB:1}).scenarios[2];
  near(s.storage,2*1.3*0.12);   // +30% log allowance
  assert.equal(run({...serverless,storageGB:2048}).scenarios[2].status,"ready");
  const invalid=run({...serverless,storageGB:2049}).scenarios[2];
  assert.equal(invalid.status,"unavailable");
  assert.equal(invalid.monthly,null);
});
test("monthly, 3-year deltas and percentages reconcile with positive and zero baselines", () => {
  for(const onPremPerCoreMonth of [0,37.5,1000]) {
    const r=run({...serverless,onPremPerCoreMonth});
    for(const s of r.scenarios) {
      near(s.threeYear,s.monthly*36);
      near(s.deltaMonthly,s.monthly-r.baseline.monthly);
      near(s.deltaThreeYear,s.threeYear-r.baseline.threeYear);
      if(r.baseline.threeYear) near(s.deltaPct,s.deltaThreeYear/r.baseline.threeYear*100);
      else assert.equal(s.deltaPct,null);
    }
  }
});
test("live MI table class mapping regression: GP East US Gen5 per-core rates", () => {
  const p=livePrices.regions.eastus.miPlans;
  near(p.payg.included,1.008736/4); near(p.payg.base,0.608872/4);
  near(p.sp1.included,0.80696/4); near(p.sp1.base,0.48708/4);
  near(p.ri1.included,0.795744/4);
  near(p.ri3.included,0.673824/4);
  // Reserved base rates come from the reservation term total rather than the
  // page's rounded display value, so they carry full precision. Both figures
  // match the rates the Azure pricing calculator itself is served.
  near(p.ri1.base,867/8760);
  near(p.ri3.base,1800/26280);
  assert.equal(p.sp3,undefined);
});
test("live VM discounts retain Windows uplift and public SQL PAYG licensing", () => {
  const p=livePrices.regions.eastus.vmPlans.Standard_E4bds_v5;
  near(p.rates.payg,0.518);
  near(p.windowsLicensePerHour,0.518-0.334);
  near(p.rates.ri1,1726/8760+p.windowsLicensePerHour);
  near(p.rates.ri3,3335/26280+p.windowsLicensePerHour);
  near(p.rates.sp1,0.2258508+p.windowsLicensePerHour);
  near(p.rates.sp3,0.1414156+p.windowsLicensePerHour);
  near(livePrices.vmLicensePerCoreHour.standard,0.1);
  near(livePrices.vmLicensePerCoreHour.enterprise,0.375);
  near(livePrices.regions.eastus.serverless.paygPerCoreHour,0.521758);
});
test("all 18 live regions, 3 deployment sizes, AHB on/off and every captured commitment", () => {
  assert.equal(Object.keys(livePrices.regions).length,18);
  for(const [region, rates] of Object.entries(livePrices.regions)) {
    for(const unitCores of [4,8,16]) for(const ahb of [false,true]) {
      for(const id of rates.vmPlans[`Standard_E${unitCores}bds_v5`].meterIds) {
        assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      }
      const vmPlans=Object.keys(rates.vmPlans[`Standard_E${unitCores}bds_v5`].rates);
      for(const vmPlan of vmPlans) for(const miPlan of Object.keys(rates.miPlans)) {
        const r=calculateCoreOptions({...defaults,...serverless,region,unitCores,ahb,vmPlan,miPlan,
          standard:100,enterprise:200,rightSizePct:20,licenseBasis:"refresh"},livePrices);
        for(const s of [r.baseline,...r.scenarios]) {
          assert.equal(s.status,"ready",`${region} ${s.key}`);
          assert.ok(Number.isFinite(s.threeYear)&&s.threeYear>0);
          near(s.threeYear,s.upfront+36*s.monthly);
        }
      }
    }
  }
});

test("shipped defaults are 3-year reservations with SQL and Windows Azure Hybrid Benefit", () => {
  const r = calculateCoreOptions({standard: 16, enterprise: 0, migrationPct: 100, rightSizePct: 0,
    region: "test", unitCores: 16, licenseBasis: "existing", onPremPerCoreMonth: 0}, fixture);
  const [vm, mi] = r.scenarios;
  assert.equal(vm.plan, "ri3");
  assert.equal(mi.plan, "ri3");
  // SQL AHB on by default removes the Azure SQL licence charge on both.
  near(vm.sqlLicense, 0);
  near(mi.sqlLicense, 0);
  // Windows AHB on by default deducts the uplift from the selected ri3 rate.
  near(vm.compute, (16 * 0.06 - 16 * 0.046) * 1 * 730);
});

test("the single AHB toggle covers Windows on VM and deducts an undiscounted uplift from every term", () => {
  const input = {standard: 16, enterprise: 0, migrationPct: 100, rightSizePct: 0,
    region: "test", unitCores: 16, licenseBasis: "existing", onPremPerCoreMonth: 0};
  const uplift = 16 * 0.046 * 730;
  for (const [plan, rate] of [["payg", 1.6], ["ri1", 1.28], ["ri3", 0.96], ["sp1", 1.44], ["sp3", 1.12]]) {
    const off = calculateCoreOptions({...input, ahb: false, vmPlan: plan, miPlan: "payg"}, fixture);
    const on = calculateCoreOptions({...input, ahb: true, vmPlan: plan, miPlan: "payg"}, fixture);
    near(off.scenarios[0].compute, rate * 730);
    near(on.scenarios[0].compute, rate * 730 - uplift);
    // The uplift is never discounted by the commitment; it is identical every term.
    near(off.scenarios[0].compute - on.scenarios[0].compute, uplift);
    // Windows licensing is not part of Managed Instance or serverless compute.
    near(on.scenarios[1].compute, off.scenarios[1].compute);
    // The same toggle still clears the SQL licence line on both Azure options.
    near(on.scenarios[0].sqlLicense, 0);
    near(on.scenarios[1].sqlLicense, 0);
    assert.ok(off.scenarios[0].sqlLicense > 0 && off.scenarios[1].sqlLicense > 0);
  }
});

test("AHB fails loudly when no Windows uplift is published rather than crediting zero", () => {
  const bare = structuredClone(fixture);
  delete bare.regions.test.vmPlans.Standard_E16bds_v5.windowsLicensePerHour;
  assert.throws(() => calculateCoreOptions({standard: 16, enterprise: 0, migrationPct: 100,
    rightSizePct: 0, region: "test", unitCores: 16, licenseBasis: "existing",
    onPremPerCoreMonth: 0, ahb: true}, bare), /Windows Server licence uplift/);
});

test("the smallest possible migration still produces a valid, positive comparison", () => {
  // Validation guarantees at least one core, so there is always at least one
  // deployment; a zero-capacity Azure column can no longer be produced.
  const r = run({standard: 1, enterprise: 0, ahb: true, onPremPerCoreMonth: 37.5});
  for (const s of r.scenarios.slice(0, 2)) {
    assert.equal(s.status, "ready");
    assert.deepEqual(s.sizes, [4]);
    assert.ok(s.compute > 0);
    assert.ok(s.threeYear > 0);
  }
});

test("Software Assurance is edition-sensitive and recurring even in existing-license mode", () => {
  const std = run({standard: 100, enterprise: 0, licenseBasis: "existing"});
  const ent = run({standard: 0, enterprise: 100, licenseBasis: "existing"});
  // The old defect: identical on-premises cost regardless of edition.
  assert.ok(ent.baseline.threeYear > std.baseline.threeYear);
  near(std.baseline.sa, 100 * 796.08 / 24);
  near(ent.baseline.sa, 100 * 3052.80 / 24);
  // Sunk purchases are still excluded; SA is what remains.
  near(std.baseline.upfront, 0);
  near(std.baseline.threeYear, 36 * std.baseline.sa);
});

test("migrating without AHB drops SA entirely for the in-scope cores", () => {
  const r = run({standard: 40, enterprise: 0, migrationPct: 40, rightSizePct: 0,
    licenseBasis: "existing", ahb: false, vmPlan: "payg", miPlan: "payg"});
  // Staying put keeps SA on all 16 in-scope cores.
  near(r.baseline.sa, 16 * 796.08 / 24);
  // Moving them without AHB means no SA obligation at all; the Azure SQL meter
  // is paid instead, never both.
  for (const s of r.scenarios) {
    near(s.sa, 0);
    if (s.key !== "serverless") assert.ok(s.sqlLicense > 0);
  }
  // The 24 untouched cores still pay SA, reported outside the comparison.
  near(r.retainedContext.sa, 24 * 796.08 / 24);
});

test("MI Enterprise AHB bills SA on source cores, not the four-to-one vCore expansion", () => {
  const r = run({standard: 0, enterprise: 64, rightSizePct: 0,
    unitCores: 16, licenseBasis: "existing", ahb: true, vmPlan: "payg", miPlan: "payg"});
  const [vm, mi] = r.scenarios;
  // VM is one-to-one: 64 vCPU covered needs 64 source cores of SA.
  near(vm.sa, 64 * 3052.80 / 24);
  // MI Enterprise stretches 1 core to 4 vCores, so the same 64 vCores need 16.
  near(mi.sa, 16 * 3052.80 / 24);
  assert.equal(mi.coveredCores, 64);
});

test("the discount applies to Software Assurance but on-premises operations stay at list", () => {
  const full = run({standard: 40, enterprise: 0, discountPct: 0, onPremPerCoreMonth: 10});
  const cut = run({standard: 40, enterprise: 0, discountPct: 25, onPremPerCoreMonth: 10});
  near(cut.baseline.sa, full.baseline.sa * 0.75);
  near(cut.baseline.infrastructure, full.baseline.infrastructure);
});

test("a missing published SA price fails rather than treating Software Assurance as free", () => {
  const bare = structuredClone(fixture);
  delete bare.sqlSaPack.standard;
  assert.throws(() => calculateCoreOptions({standard: 16, enterprise: 0, migrationPct: 100,    region: "test", licenseBasis: "existing"}, bare), /Software Assurance/);
});

test("all four columns price the same in-scope workload, and Azure right-sizes below it", () => {
  const r = run({...serverless, standard: 100, enterprise: 0, migrationPct: 50,
    rightSizePct: 20, unitCores: 16, onPremPerCoreMonth: 37.5, licenseBasis: "refresh",
    avoidablePct: 50});
  // Same scope in every column: the 50 cores selected for migration.
  for (const s of [r.baseline, ...r.scenarios]) assert.equal(s.scopedCores, 50);
  // Right-sizing means Azure provisions less capacity than the source footprint.
  assert.equal(r.required.standard, 40);
  assert.ok(r.required.standard < 50);
  // Only the on-premises column pays for all 50 cores of hardware.
  near(r.baseline.infrastructure, 50 * 37.5);
  for (const s of r.scenarios) near(s.infrastructure, 50 * 37.5 * 0.5);
  // The untouched 50 cores are excluded from every column, reported separately.
  assert.equal(r.retainedContext.cores, 50);
  assert.ok(r.retainedContext.threeYear > 0);
  for (const s of [r.baseline, ...r.scenarios]) {
    assert.ok(s.threeYear < r.retainedContext.threeYear + s.threeYear);
  }
});

test("reaching the same migrated cores from different footprints gives the same comparison", () => {
  // The retained remainder is a constant in every column, so growing it must not
  // change any scenario total or any delta.
  const small = run({standard: 60, enterprise: 0, migrationPct: 50, rightSizePct: 0,
    licenseBasis: "refresh", onPremPerCoreMonth: 20});
  const large = run({standard: 300, enterprise: 0, migrationPct: 10, rightSizePct: 0,
    licenseBasis: "refresh", onPremPerCoreMonth: 20});
  assert.equal(small.moved.standard, 30);
  assert.equal(large.moved.standard, 30);
  near(small.baseline.threeYear, large.baseline.threeYear);
  for (let i = 0; i < small.scenarios.length; i++) {
    const a = small.scenarios[i], b = large.scenarios[i];
    assert.equal(a.status, b.status);
    if (a.status !== "ready") continue;
    near(a.threeYear, b.threeYear);
    near(a.deltaPct, b.deltaPct);
  }
  // Only the out-of-scope context differs.
  assert.equal(small.retainedContext.cores, 30);
  assert.equal(large.retainedContext.cores, 270);
});

test("deployments fit the published size ladder instead of rounding to uniform blocks", () => {
  // 40 required used to become three 16-core blocks (48 vCores). It now fits
  // exactly, so Azure is not charged for capacity an architect would not buy.
  const r = run({standard: 50, enterprise: 0, rightSizePct: 20, unitCores: 16});
  assert.equal(r.required.standard, 40);
  assert.deepEqual(r.scenarios[0].sizes, [16, 16, 8]);
  assert.equal(r.scenarios[0].azureCores, 40);
  // Provisioned capacity never drops below the right-sized requirement.
  for (const s of r.scenarios.slice(0, 2)) assert.ok(s.azureCores >= r.required.standard);
});

test("fitted capacity is never wasteful and never short across many core counts", () => {
  for (let cores = 1; cores <= 200; cores++) {
    const r = run({standard: cores, enterprise: 0, rightSizePct: 0, unitCores: 16});
    for (const s of r.scenarios.slice(0, 2)) {
      // Always enough capacity for the requirement.
      assert.ok(s.azureCores >= cores, `${cores}: provisioned ${s.azureCores}`);
      // Never more than the smallest deployment size of slack, so rounding can
      // only ever cost part of one 4-core deployment.
      assert.ok(s.azureCores - cores < 4, `${cores}: slack ${s.azureCores - cores}`);
    }
  }
});

test("the maximum deployment size caps individual deployments without inflating total capacity", () => {
  for (const unitCores of [4, 8, 16]) {
    const r = run({standard: 64, enterprise: 0, rightSizePct: 0, unitCores});
    for (const s of r.scenarios.slice(0, 2)) {
      assert.ok(Math.max(...s.sizes) <= unitCores);
      // 64 is reachable exactly at every cap, so the cap changes deployment
      // count and unit price, never the provisioned total.
      assert.equal(s.azureCores, 64);
    }
  }
});

test("licenseCores reports the cores actually bearing Software Assurance", () => {
  // Staying put: every in-scope core carries SA.
  const stay = run({standard: 40, enterprise: 0, migrationPct: 100, rightSizePct: 0, ahb: false});
  assert.equal(stay.baseline.licenseCores, 40);
  // Migrating without AHB: no SA obligation, the Azure meter is paid instead.
  for (const s of stay.scenarios) assert.equal(s.licenseCores, 0);
  // With AHB, VM is 1:1 so the covered vCPUs need the same number of source cores.
  const vmAhb = run({standard: 40, enterprise: 0, migrationPct: 100, rightSizePct: 0, ahb: true});
  assert.equal(vmAhb.scenarios[0].licenseCores, 40);
  // MI stretches Enterprise 4:1, so 64 covered vCores need only 16 source cores.
  const miAhb = run({standard: 0, enterprise: 64, migrationPct: 100, rightSizePct: 0, ahb: true});
  assert.equal(miAhb.scenarios[0].licenseCores, 64);
  assert.equal(miAhb.scenarios[1].licenseCores, 16);
  // Serverless never carries AHB, so it never carries backing cores.
  const sl = run({...serverless, standard: 40, enterprise: 0, migrationPct: 100, ahb: true});
  assert.equal(sl.scenarios[2].licenseCores, 0);
});

test("licenseCores is always consistent with the Software Assurance charged", () => {
  for (const ahb of [true, false]) for (const [s, e] of [[40, 0], [0, 40], [20, 20]]) {
    const r = run({standard: s, enterprise: e, migrationPct: 100, rightSizePct: 0, ahb});
    for (const x of [r.baseline, ...r.scenarios]) {
      if (x.status !== "ready") continue;
      // A zero core count must mean a zero charge, and vice versa: the card
      // cannot claim licensed cores while billing nothing, or the reverse.
      assert.equal(x.licenseCores === 0, x.sa === 0, `${x.key} ${s}S/${e}E ahb=${ahb}`);
    }
  }
});

test("every priced region has a display name, and every display name is priced", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "calculator.js"), "utf8");
  const block = src.match(/const REGION_NAMES = \{([\s\S]*?)\n\};/);
  assert.ok(block, "REGION_NAMES table not found");
  const named = [...block[1].matchAll(/(\w+):\s*"/g)].map(m => m[1]);
  const priced = Object.keys(livePrices.regions);
  // A region added to the price file without a label would surface a raw key
  // like "germanywestcentral" in the picker.
  for (const r of priced) assert.ok(named.includes(r), `no display name for ${r}`);
  // A label left behind after a region is dropped is dead weight.
  for (const r of named) assert.ok(priced.includes(r), `${r} is named but not priced`);
});

test("a known instance count replaces consolidation and respects the four-core floor", () => {
  // 80 right-sized cores. Consolidated, that is 5 x 16 = 80 vCores.
  const packed = run({standard: 100, enterprise: 0, migrationPct: 100, rightSizePct: 20, unitCores: 16});
  assert.equal(packed.required.standard, 80);
  assert.deepEqual(packed.scenarios[0].sizes, [16,16,16,16,16]);
  assert.equal(packed.scenarios[0].azureCores, 80);
  // Twenty instances of four cores each still totals 80: no penalty yet.
  const twenty = run({standard: 100, enterprise: 0, migrationPct: 100, rightSizePct: 20, unitCores: 16, instanceCount: 20});
  assert.equal(twenty.scenarios[0].deployments, 20);
  assert.equal(twenty.scenarios[0].azureCores, 80);
  // Eighty single-core instances cannot go below the four-core floor, so on a
  // virtual machine the same workload now needs 320 vCPUs. This is the case
  // consolidation hides.
  const eighty = run({standard: 100, enterprise: 0, migrationPct: 100, rightSizePct: 20, unitCores: 16, instanceCount: 80});
  assert.equal(eighty.scenarios[0].deployments, 80);
  assert.equal(eighty.scenarios[0].azureCores, 320);
  assert.ok(eighty.scenarios[0].monthly > packed.scenarios[0].monthly * 3);
  // Managed Instance escapes the same floor by pooling, so it is not penalised
  // the same way. See the instance pool tests below.
  assert.equal(eighty.scenarios[1].topology, "pool");
  assert.ok(eighty.scenarios[1].azureCores < eighty.scenarios[0].azureCores);
});

test("instance pools beat single instances only when instances are small", () => {
  const at = n => run({standard: 100, enterprise: 0, migrationPct: 100, rightSizePct: 20,
    unitCores: 16, instanceCount: n}).scenarios[1];
  // One core per server fits the two-vCore size, which exists only in a pool,
  // so the pool halves the billed vCores against the four-vCore floor.
  const small = at(80);
  assert.equal(small.topology, "pool");
  assert.equal(small.instanceSize, 2);
  assert.equal(small.azureCores, 160);
  assert.equal(small.deployments, 10);
  // Four cores per server already sits on the single-instance ladder, so
  // rounding each pool up to a purchasable size would cost more. The cheaper
  // topology must win, not the pool by default.
  const mid = at(25);
  assert.equal(mid.topology, "single");
  assert.equal(mid.azureCores, 100);
  // Both topologies bill the same published rate, so fewer vCores is cheaper.
  assert.ok(small.compute / small.azureCores - mid.compute / mid.azureCores < 1e-6);
});

test("pooling needs a known instance count and never applies to VM or Database", () => {
  const base = {standard: 100, enterprise: 0, migrationPct: 100, rightSizePct: 20, unitCores: 16};
  // Without an instance count the topology is unknown, so consolidation stands.
  assert.equal(run(base).scenarios[1].topology, "single");
  const pooled = run({...base, instanceCount: 80});
  assert.equal(pooled.scenarios[1].topology, "pool");
  // A virtual machine has no equivalent construct.
  assert.equal(pooled.scenarios[0].topology, "single");
  // Azure SQL Database has elastic pools, which are a different construct that
  // does not remove the four-vCore floor, so the Database column must stay on
  // the single-instance topology even where pooling wins for Managed Instance.
  const db = run({...base, instanceCount: 80, purchaseModel: "provisioned"}).scenarios[2];
  assert.equal(db.topology, "single");
  assert.equal(db.azureCores, 320);
  assert.ok(db.azureCores > pooled.scenarios[1].azureCores);
});

test("instances are shared between editions in proportion to their demand", () => {
  const r = run({standard: 75, enterprise: 25, migrationPct: 100, rightSizePct: 0,
    unitCores: 16, instanceCount: 8});
  // 75 and 25 cores across 8 instances splits 6 / 2.
  assert.equal(r.scenarios[0].sizes.length, 8);
  assert.equal(r.scenarios[0].deployments, 8);
  // Every edition present gets at least one instance, even when tiny.
  const lopsided = run({standard: 30, enterprise: 2, migrationPct: 100, rightSizePct: 0,
    unitCores: 16, instanceCount: 4});
  assert.equal(lopsided.scenarios[0].deployments, 4);
  // The single Enterprise instance is sized to its own small share, not to the
  // Standard share, so editions never subsidise each other's capacity.
  assert.ok(lopsided.scenarios[0].sizes.includes(4));
});

test("an instance count too small for the deployment cap is refused, not silently resized", () => {
  // 200 cores over 2 instances is 100 each, far above a 16-core maximum.
  const r = run({standard: 200, enterprise: 0, migrationPct: 100, rightSizePct: 0,
    unitCores: 16, instanceCount: 2});
  for (const s of r.scenarios.slice(0, 2)) {
    assert.equal(s.status, "unavailable");
    assert.match(s.reason, /above the 16-core maximum/);
    assert.equal(s.monthly, null);
  }
  // Serverless is sized independently and is unaffected.
  assert.equal(r.scenarios[2].status, "ready");
});

test("instance and database counts are validated, and optional", () => {
  assert.throws(() => run({instanceCount: 0}), /Instance count/);
  assert.throws(() => run({instanceCount: 2.5}), /Instance count/);
  assert.throws(() => run({standard: 10, enterprise: 10, instanceCount: 1}), /at least 2 instances/);
  // Omitting both keeps the previous consolidated behaviour exactly.
  const bare = run({standard: 100, enterprise: 0, migrationPct: 100, rightSizePct: 20});
  const explicitNull = run({standard: 100, enterprise: 0, migrationPct: 100, rightSizePct: 20,
    instanceCount: null, databaseCount: null});
  near(bare.scenarios[0].threeYear, explicitNull.scenarios[0].threeYear);
});

test("a supplied database count overrides the serverless assumption and clears the label", () => {
  const assumed = run({standard: 100, enterprise: 0, migrationPct: 100, rightSizePct: 20, storageGB: 500});
  assert.ok(assumed.scenarios[2].assumed.length > 0);
  const given = run({standard: 100, enterprise: 0, migrationPct: 100, rightSizePct: 20,
    storageGB: 500, databaseCount: 12});
  assert.equal(given.scenarios[2].deployments, 12);
  assert.equal(given.scenarios[2].assumed.length, 0);
});

test("pricing defaults to the cheapest published term, not a fixed one", () => {
  const r = run({standard: 64, enterprise: 0, migrationPct: 100, rightSizePct: 0,
    vmPlan: "auto", miPlan: "auto"});
  // The fixture's cheapest VM and MI rates are both the three-year reservation.
  assert.equal(r.scenarios[0].plan, "ri3");
  assert.equal(r.scenarios[1].plan, "ri3");
  // Auto never costs more than any term it could have chosen.
  for (const plan of ["payg","ri1","ri3","sp1","sp3"]) {
    const fixed = run({standard: 64, enterprise: 0, migrationPct: 100, rightSizePct: 0,
      vmPlan: plan, miPlan: plan});
    for (const i of [0, 1]) {
      // A term the fixture does not publish yields an unavailable scenario with
      // no compute at all, which is not a cheaper alternative.
      if (fixed.scenarios[i].status !== "ready") continue;
      assert.ok(r.scenarios[i].compute <= fixed.scenarios[i].compute + 1e-9, `${i ? "mi" : "vm"} ${plan}`);
    }
  }
});

test("auto skips terms the snapshot does not publish rather than failing", () => {
  const partial = structuredClone(fixture);
  // Drop both three-year terms; auto must fall back to the best that remains.
  delete partial.regions.test.miPlans.ri3;
  for (const n of [4,8,16]) {
    delete partial.regions.test.vmPlans[`Standard_E${n}bds_v5`].rates.ri3;
    delete partial.regions.test.vmPlans[`Standard_E${n}bds_v5`].rates.sp3;
  }
  const r = calculateCoreOptions({...defaults, standard: 64, migrationPct: 100,
    vmPlan: "auto", miPlan: "auto"}, partial);
  assert.equal(r.scenarios[0].status, "ready");
  assert.equal(r.scenarios[1].status, "ready");
  // Fixture ri1 and sp1 both sit at 0.12 for MI, so the three-year preference
  // order breaks the tie in favour of the reservation.
  assert.equal(r.scenarios[0].plan, "ri1");
  assert.equal(r.scenarios[1].plan, "ri1");
});

test("auto requires a rate for every size in the layout, not just one", () => {
  const partial = structuredClone(fixture);
  // 40 cores fits as 16 + 16 + 8, so a missing 8-core ri3 rate disqualifies ri3
  // for the whole layout even though the 16-core rate is published.
  delete partial.regions.test.vmPlans.Standard_E8bds_v5.rates.ri3;
  const r = calculateCoreOptions({...defaults, standard: 40, migrationPct: 100,
    unitCores: 16, vmPlan: "auto"}, partial);
  assert.deepEqual(r.scenarios[0].sizes, [16,16,8]);
  assert.notEqual(r.scenarios[0].plan, "ri3");
  assert.equal(r.scenarios[0].status, "ready");
});

test("auto reports unavailable when a region publishes no usable rate at all", () => {
  const bare = structuredClone(fixture);
  bare.regions.test.miPlans = {};
  const r = calculateCoreOptions({...defaults, standard: 16, migrationPct: 100, miPlan: "auto"}, bare);
  assert.equal(r.scenarios[1].status, "unavailable");
  assert.match(r.scenarios[1].reason, /No published MI GP Gen5 rate/);
  assert.equal(r.scenarios[1].monthly, null);
  // The VM column is unaffected.
  assert.equal(r.scenarios[0].status, "ready");
});

/* ---- Azure Hybrid Benefit business rules, against the published ratio table ---- */

test("published AHB ratios: one licence core covers the documented vCore count", () => {
  const at = o => run({migrationPct: 100, rightSizePct: 0, unitCores: 16,
    vmPlan: "payg", miPlan: "payg", ahb: true, ...o});
  // Enterprise licence to Managed Instance / SQL Database General Purpose is 1:4.
  const entMi = at({standard: 0, enterprise: 64}).scenarios[1];
  assert.equal(entMi.coveredCores, 64);
  assert.equal(entMi.licenseCores, 16);
  // Standard licence to the same target is 1:1.
  const stdMi = at({standard: 64, enterprise: 0}).scenarios[1];
  assert.equal(stdMi.coveredCores, 64);
  assert.equal(stdMi.licenseCores, 64);
  // An Enterprise VM takes an Enterprise licence one to one.
  const entVm = at({standard: 0, enterprise: 64}).scenarios[0];
  assert.equal(entVm.coveredCores, 64);
  assert.equal(entVm.licenseCores, 64);
  // A Standard VM takes a Standard licence one to one.
  const stdVm = at({standard: 64, enterprise: 0}).scenarios[0];
  assert.equal(stdVm.coveredCores, 64);
  assert.equal(stdVm.licenseCores, 64);
});

test("the benefit is unavailable on the serverless compute tier", () => {
  const r = run({...serverless, standard: 0, enterprise: 64, migrationPct: 100,
    rightSizePct: 0, ahb: true, storageGB: 400, databaseCount: 8});
  const sl = r.scenarios[2];
  assert.equal(sl.status, "ready");
  // No entitlement is drawn, so no cores are held on Software Assurance for it.
  assert.equal(sl.licenseCores, 0);
  assert.equal(sl.sa, 0);
  // Turning the benefit off therefore changes nothing about serverless.
  const off = run({...serverless, standard: 0, enterprise: 64, migrationPct: 100,
    rightSizePct: 0, ahb: false, storageGB: 400, databaseCount: 8});
  near(sl.threeYear, off.scenarios[2].threeYear);
});

test("leftover Enterprise entitlement covers Standard workloads at four vCores per licence", () => {
  // One Standard core still needs a whole four-vCPU VM, which one Standard
  // licence cannot cover. Right-sizing leaves Enterprise licences spare, and the
  // published table lets an Enterprise licence cover four Standard vCPUs.
  const r = run({standard: 1, enterprise: 64, migrationPct: 100, rightSizePct: 50,
    unitCores: 16, vmPlan: "payg", miPlan: "payg", ahb: true});
  const vm = r.scenarios[0];
  // sizes lists Standard deployments before Enterprise ones.
  assert.deepEqual(vm.sizes, [4, 16, 16]);
  // Every deployment is covered, including the Standard one.
  assert.equal(vm.coveredCores, 36);
  // 32 Enterprise licences for the two Enterprise VMs, plus the four-licence
  // minimum for the Standard VM, and the single Standard licence goes unused.
  assert.equal(vm.licenseCores, 36);
  // Without the benefit that Standard VM would pay the Azure SQL meter.
  const off = run({standard: 1, enterprise: 64, migrationPct: 100, rightSizePct: 50,
    unitCores: 16, vmPlan: "payg", miPlan: "payg", ahb: false});
  assert.ok(off.scenarios[0].sqlLicense > vm.sqlLicense);
});

test("each virtual machine consumes at least four core licences", () => {
  // Right-sizing leaves Enterprise licences spare. The four-vCPU Standard VM
  // needs only one licence at the four-to-one ratio, but the published minimum
  // is four per virtual machine.
  const r = run({standard: 1, enterprise: 16, migrationPct: 100, rightSizePct: 50,
    unitCores: 16, vmPlan: "payg", miPlan: "payg", ahb: true});
  const vm = r.scenarios[0];
  assert.deepEqual(vm.sizes, [4, 8]);
  // Eight Enterprise vCPU at one to one, plus four licences for the Standard VM.
  assert.equal(vm.licenseCores, 12);
  assert.equal(vm.coveredCores, 12);
});

test("entitlement comes only from migrating cores, never from retained ones", () => {
  // Half the estate stays behind, so only half the licences are available.
  const r = run({standard: 0, enterprise: 64, migrationPct: 50, rightSizePct: 0,
    unitCores: 16, vmPlan: "payg", miPlan: "payg", ahb: true});
  assert.equal(r.moved.enterprise, 32);
  // Managed Instance stretches those 32 licences across 32 vCores at one to
  // four, so only 8 licence cores are consumed.
  assert.equal(r.scenarios[1].licenseCores, 8);
  // The VM column needs one licence per vCPU and has exactly enough.
  assert.equal(r.scenarios[0].licenseCores, 32);
});

test("only priced service tiers are accepted", () => {
  assert.throws(() => run({serviceTier: "hyperscale"}), /priced service tier/);
  assert.throws(() => run({serviceTier: "premium"}), /priced service tier/);
  for (const tier of ["gp", "bc"]) {
    assert.equal(run({serviceTier: tier}).scenarios[1].status, "ready");
  }
});

test("Business Critical costs more than General Purpose and pools are General Purpose only", () => {
  const args = {standard: 0, enterprise: 64, storageGB: 512};
  const gp = run({...args, serviceTier: "gp"}).scenarios[1];
  const bc = run({...args, serviceTier: "bc"}).scenarios[1];
  assert.equal(gp.status, "ready");
  assert.equal(bc.status, "ready");
  assert.ok(bc.monthly > gp.monthly, "Business Critical should cost more than General Purpose");
  assert.equal(bc.name, "SQL Managed Instance BC");
  // Instance pools are published as a General Purpose construct.
  assert.notEqual(bc.topology, "pool");
});

test("the reference deployment size reaches the whole published Managed Instance ladder", () => {
  for (const size of [4, 8, 16, 24, 32, 40, 64, 80]) {
    assert.equal(run({unitCores: size}).scenarios[1].status, "ready", `${size} vCores should be selectable`);
  }
  assert.throws(() => run({unitCores: 12}), /Choose 4, 8, 16, 24, 32, 40, 64, 80/);
});

test("an unpriced purchase model explains why rather than repeating the prompt", () => {
  // The dropdown offers DTU, so "choose a priced purchase model" tells the
  // reader to do the thing they just did. The message has to say what is
  // different about DTU and where to go instead.
  assert.throws(() => run({purchaseModel: "dtu"}), /bundles compute, storage and I\/O/);
  assert.throws(() => run({purchaseModel: "dtu"}), /vCore model/);
  assert.throws(() => run({purchaseModel: "nonsense"}), /Choose a priced purchase model/);
});

test("Azure SQL Database bills the 30% log allowance, and Hyperscale does not", () => {
  // Learn: "When you configure maximum data size, an extra 30 percent of
  // billable storage is automatically added for the log file." That applies to
  // General Purpose and Business Critical. Hyperscale bills allocated data and
  // charges nothing for log, so it must not carry the uplift.
  const gpRate = fixture.regions.test.storage.db_gp_per_gb_mo;
  const hsRate = fixture.regions.test.storage.db_hs_per_gb_mo;
  const args = {standard: 0, enterprise: 16, storageGB: 100};

  const provisioned = run({...args, purchaseModel: "provisioned"}).scenarios[2];
  assert.equal(Math.round(provisioned.storage), Math.round(100 * 1.3 * gpRate));
  assert.match(provisioned.storageDetail, /30% log allowance/);

  const hyperscale = run({...args, purchaseModel: "hyperscale"}).scenarios[2];
  assert.equal(Math.round(hyperscale.storage), Math.round(100 * hsRate), "Hyperscale charges no log storage");
  assert.doesNotMatch(hyperscale.storageDetail, /log allowance/);

  // Managed Instance covers data and log inside the reserved size, so no uplift
  const mi = run({...args}).scenarios[1];
  const miRate = fixture.regions.test.storage.mi_gp_per_gb_mo;
  assert.equal(Math.round(mi.storage), Math.round((128 - 32) * miRate), "MI bills reserved size less the allowance, with no log uplift");
});

test("Managed Instance does not bill the included first 32 GB per instance", () => {
  // Learn: "The minimum amount of storage available in an instance is 32 GB...
  // First 32 GB are free of charge." The allowance is per instance and applies
  // to both tiers. It is absent from the rate card, so it has to be applied here.
  const rate = fixture.regions.test.storage.mi_gp_per_gb_mo;
  const atFloor = run({standard: 0, enterprise: 16, storageGB: 0}).scenarios[1];
  assert.equal(atFloor.status, "ready");
  assert.equal(atFloor.storage, 0, "a 32 GB instance is entirely within the allowance");

  // 64 GB reserved bills 32 GB, not 64
  const above = run({standard: 0, enterprise: 16, storageGB: 64}).scenarios[1];
  assert.equal(Math.round(above.storage), Math.round(32 * rate));

  // the allowance is per instance, so it scales with instance count
  const many = run({standard: 0, enterprise: 16, storageGB: 256, instanceCount: 4}).scenarios[1];
  const perInstance = 256 / 4;
  assert.equal(Math.round(many.storage), Math.round((perInstance - 32) * 4 * rate));
});

test("Azure SQL Database bills all storage, with no Managed Instance allowance", () => {
  // The included 32 GB is a Managed Instance feature. SQL Database bills from
  // the first gigabyte and is configurable in 1 GB steps, not 32 GB blocks.
  const rate = fixture.regions.test.storage.db_gp_per_gb_mo;
  const db = run({standard: 0, enterprise: 16, storageGB: 40, purchaseModel: "provisioned"}).scenarios[2];
  assert.equal(db.status, "ready");
  assert.ok(db.storage > 0, "SQL Database storage is never free");
  assert.equal(Math.round(db.storage), Math.round(40 * 1.3 * rate), "billed on the exact size plus the log allowance, not rounded to a 32 GB multiple");
});

test("the distribution search stays fast on the largest estate the form accepts", () => {
  // The form accepts up to 100,000 cores per edition. Measuring the spread by
  // building a layout for every candidate instance count made this quadratic,
  // which froze the page for tens of seconds at that size.
  const started = Date.now();
  const r = run({standard: 0, enterprise: 100000, storageGB: 1000000});
  const elapsed = Date.now() - started;
  assert.ok(r.distribution.spreadPct > 0);
  assert.ok(elapsed < 2000, `largest supported estate took ${elapsed}ms; the search has gone superlinear again`);
});

test("the distribution spread is measured against plausible layouts, not degenerate ones", () => {
  const r = run({standard: 0, enterprise: 200, rightSizePct: 0});
  const d = r.distribution;
  assert.equal(d.requiredCores, 200);
  // Consolidating onto the ladder wastes nothing when the total lands on it.
  assert.equal(d.consolidatedCores, 200);
  // The worst fit is real but bounded: one instance per smallest purchasable
  // size is empty capacity, not a distribution, so it is excluded.
  assert.ok(d.worstCores > d.consolidatedCores, "a spread should exist");
  assert.ok(d.spreadPct < 150, `spread should stay plausible, got ${d.spreadPct}`);
  assert.ok(d.worstInstances <= 200 / 4, "never more instances than the 4-vCore minimum allows");
});

test("distribution spread is not monotonic in how uneven the estate is", () => {
  // Twenty ten-core servers bill more than twenty-five eight-core ones: ten
  // rounds up to sixteen while eight lands exactly on the ladder. A single
  // "how uneven is it" question would therefore mislead, which is why the
  // estimator measures the span instead of asking.
  const cores = 200;
  const billed = (instances) => {
    const share = Math.ceil(cores / instances);
    const size = [4, 8, 16, 24, 32, 40, 64, 80].find(s => s >= share);
    return size * instances;
  };
  assert.equal(billed(25), 200);
  assert.equal(billed(20), 320);
  assert.ok(billed(20) > billed(25), "fewer, larger servers can cost more");
});
test("Hyperscale never draws Azure Hybrid Benefit, even when it is requested", () => {
  const args = {standard: 0, enterprise: 64, storageGB: 512, ahb: true};
  for (const purchaseModel of ["hyperscale", "hyperscaleServerless"]) {
    const hs = run({...args, purchaseModel}).scenarios[2];
    assert.equal(hs.status, "ready", purchaseModel);
    // Azure Hybrid Benefit is not available for new Hyperscale databases, so no
    // entitlement is consumed, no licence is billed and no Software Assurance
    // is attributed to the migrated cores.
    assert.equal(hs.licenseCores, 0, purchaseModel);
    assert.equal(hs.sqlLicense, 0, purchaseModel);
    assert.equal(hs.sa, 0, purchaseModel);
  }
});

test("Hyperscale bills allocated storage with a 10 GB floor, not reserved storage", () => {
  const args = {standard: 0, enterprise: 16, purchaseModel: "hyperscale"};
  const none = run({...args, storageGB: 0}).scenarios[2];
  // Managed Instance rounds up to a 32 GB reserved floor; Hyperscale does not.
  assert.match(none.storageDetail, /10 GB allocated/);
  assert.ok(none.assumed.some(a => /allocated/.test(a)));
  const sized = run({...args, storageGB: 4096}).scenarios[2];
  assert.match(sized.storageDetail, /4,096 GB allocated/);
  const rate = fixture.regions.test.storage.db_hs_per_gb_mo;
  assert.equal(Math.round(sized.storage), Math.round(4096 * rate));
});

test("Hyperscale serverless scales compute with billable online time", () => {
  const args = {standard: 0, enterprise: 32, storageGB: 256, purchaseModel: "hyperscaleServerless"};
  const quarter = run({...args, activePct: 25}).scenarios[2];
  const full = run({...args, activePct: 100}).scenarios[2];
  assert.equal(quarter.status, "ready");
  assert.ok(Math.abs(full.compute / quarter.compute - 4) < 1e-6,
    "compute should scale linearly with billable online time");
  // Hyperscale serverless has no auto-pause; the model says so rather than
  // implying the database can drop to zero.
  assert.ok(full.assumed.some(a => /auto-pause/.test(a)));
});
