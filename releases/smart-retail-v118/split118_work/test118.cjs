'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const {browser,locks,source}=require('./runtime-harness.cjs');
const results=[],tick=()=>new Promise(ok=>setImmediate(ok));
async function test(name,fn){try{await fn();results.push({name,status:'pass'});}catch(e){results.push({name,status:'FAIL',error:e.message,stack:e.stack});console.error(name,e);}}
const authKey='uzum-analytics-merged-session-v3',admin={role:'admin',username:'Admin',at:'unit-test'};
function analytic(options={}){return browser('Analitika',{storage:{srerp_products:'[]',[authKey]:JSON.stringify(admin)},...options});}
async function hold(manager,name){let release;const ready=new Promise(ok=>manager.request(name,{ifAvailable:true},async lock=>{assert(lock);await new Promise(done=>{release=done;ok()})}));await ready;return async()=>{release();await tick()};}
(async()=>{
await test('Both standalone files and all retained PRO/lazy JS modules compile',()=>{
 const rows=JSON.parse(fs.readFileSync(path.join(__dirname,'extracted.json')));
 for(const r of rows)new vm.Script(fs.readFileSync(r.file,'utf8'),{filename:r.realm+'/'+r.id+'/'+r.i});
 assert.equal(rows.length,226);
});
await test('Analytics and ERP acquire distinct writer locks on the same origin',async()=>{
 const manager=locks(),erp=browser('ERP',{locks:manager,realWriter:true}),a=analytic({locks:manager,realWriter:true});
 assert.equal(await erp.c.SRWriter101.ready,true);assert.equal(await a.c.SRWriter101.ready,true);
 assert.equal(manager.active.size,2);erp.c.emit('pagehide');a.c.emit('pagehide');await tick();assert.equal(manager.active.size,0);
});
await test('A second ERP is still prevented from writing',async()=>{
 const manager=locks(),one=browser('ERP',{locks:manager,realWriter:true}),two=browser('ERP',{locks:manager,realWriter:true});
 assert.equal(await one.c.SRWriter101.ready,true);assert.equal(await two.c.SRWriter101.ready,false);
 assert.throws(()=>two.c.SRWriter101.assert());one.c.emit('pagehide');await tick();
});
await test('A second analytics document stops before initialization',async()=>{
 const manager=locks(),one=analytic({locks:manager,realWriter:true}),two=analytic({locks:manager,realWriter:true});
 assert.equal(await one.c.SRWriter101.ready,true);assert.equal(await two.c.SRWriter101.ready,false);
 await assert.rejects(two.c.SRTransfer113.boot(),/boshqa|Boshqa/);one.c.emit('pagehide');await tick();
});
for(const mode of ['ERP','Analitika']){
 await test(mode+' can create, verify and restore a ZIP without its former parent',async()=>{
  const {c}=mode==='ERP'?browser(mode):analytic(),t=c.SRTransfer113;
  assert.equal(c.parent,c);assert(c.localStorage instanceof c.Storage);await t.boot();assert(t.booted);
  await t.archiveFile(new File(['original Excel bytes'],'hisobot.xlsx'),{source:'test-import'});
  const packed=await t.engine.exportBackup(await t.grant('settings.backup'));
  const inspected=await t.engine.inspect(packed.blob);assert.equal(inspected.snapshot.databases.length,4);
  assert.equal(inspected.snapshot.databases.find(x=>x.id==='imports').stores.files.length,1);
  c.localStorage.setItem('srerp_products','[{"id":"later"}]');
  const receipt=await t.engine.restore(inspected,await t.grant('settings.restore'));
  assert.equal(receipt.restored,true);assert.equal(c.localStorage.getItem('srerp_products'),'[]');assert.equal(t.busy,false);
  assert.equal(c.navigator.locks.active.size,0);assert.equal(c.localStorage.getItem(authKey),null);
 });
 await test(mode+' refuses a full backup while the other app is writing and resumes after close',async()=>{
  const manager=locks(),{c}=mode==='ERP'?browser(mode,{locks:manager}):analytic({locks:manager}),t=c.SRTransfer113;
  const other=mode==='ERP'?'smart-retail-analytics-writer-v118':'smart-retail-business-writer-v101';
  const release=await hold(manager,other),token=await t.grant('settings.backup');
  await assert.rejects(t.engine.exportBackup(token),/oynasini yoping/);assert.equal(t.busy,false);
  assert.equal(c.localStorage.getItem('SellerSmart.transfer113.lock'),null);await release();
  assert((await t.engine.exportBackup(token)).blob.size>0);assert.equal(manager.active.size,0);
 });
 await test(mode+' refuses full restore before changing data while the other app is active',async()=>{
  const manager=locks(),{c}=mode==='ERP'?browser(mode,{locks:manager}):analytic({locks:manager}),t=c.SRTransfer113;
  const p=await t.engine.inspect((await t.engine.exportBackup(await t.grant('settings.backup'))).blob);
  c.localStorage.setItem('srerp_products','[{"id":"keep"}]');
  const release=await hold(manager,mode==='ERP'?'smart-retail-analytics-writer-v118':'smart-retail-business-writer-v101');
  await assert.rejects(t.engine.restore(p,await t.grant('settings.restore')),/oynasini yoping/);
  assert.equal(c.localStorage.getItem('srerp_products'),'[{"id":"keep"}]');await release();
 });
}
await test('Starting another app cannot erase an active restore lock',async()=>{
 const manager=locks(),{c}=analytic({locks:manager}),release=await hold(manager,'smart-retail-business-writer-v101');
 c.localStorage.setItem('SellerSmart.transfer113.lock','in-progress');
 await assert.rejects(c.SRTransfer113.recover(),/oynasini yoping/);
 assert.equal(c.localStorage.getItem('SellerSmart.transfer113.lock'),'in-progress');await release();
 assert.equal(await c.SRTransfer113.recover(),false);assert.equal(c.localStorage.getItem('SellerSmart.transfer113.lock'),null);
});
await test('Analytics backup checks its own administrator password',async()=>{
 const bad=analytic({password:'wrong'}),ok=analytic();
 await assert.rejects(bad.c.SRTransfer113.grant('settings.backup'),/paroli noto‘g‘ri/);
 assert(await ok.c.SRTransfer113.grant('settings.backup'));
 assert.equal(ok.c.emp70.owner(),true); // ERP stub is immaterial to the analytics grant.
 ok.c.emp70=null;assert(await ok.c.SRTransfer113.grant('settings.backup'));
});
await test('Limited accounts cannot receive backup grants even with ERP admin state',async()=>{
 const {c}=analytic();c.localStorage.setItem(authKey,JSON.stringify({role:'limited',username:'staff'}));
 await assert.rejects(c.SRTransfer113.grant('settings.backup'),/administratori/);
});
await test('Logout and credential changes revoke existing analytics backup grants',async()=>{
 const {c}=analytic(),t=c.SRTransfer113,one=await t.grant('settings.backup');
 c.localStorage.removeItem(authKey);await assert.rejects(t.engine.exportBackup(one),/tasdig‘i eskirgan/);
 c.localStorage.setItem(authKey,JSON.stringify(admin));const two=await t.grant('settings.backup');
 c.localStorage.setItem('uzum-analytics-merged-credentials-v3','changed');
 await assert.rejects(t.engine.exportBackup(two),/tasdig‘i eskirgan/);
});
await test('Analytics restore grant is action-bound; cancellation does not grant access',async()=>{
 const {c}=analytic(),t=c.SRTransfer113,token=await t.grant('settings.restore');
 await assert.rejects(t.engine.exportBackup(token),/Administrator/);
 const cancelled=analytic({password:null});assert.equal(await cancelled.c.SRTransfer113.grant('settings.backup'),null);
});
await test('Analytics session bridge stays read-only and PRO AI reads admin reports without an ERP frame',()=>{
 const {c}=analytic();c.document.getElementById=()=>null;vm.runInContext(source('Analitika','smartRetailErpSessionBridge40'),c);
 c.state={datasets:{funnelProducts:[{sku:'P1'}],funnelCategories:[]}};c.inPeriod=()=>true;c.Funnel104={selectRows:a=>a};
 const before=[...Array(c.localStorage.length)].map((_,i)=>c.localStorage.key(i)).sort();
 vm.runInContext(source('Analitika','sellerSmartOuter103'),c);
 assert.equal(c.smartRetailUzumPro103.standaloneRows()[0].sku,'P1');
 assert.equal(c.smartRetailErpSessionBridge40.resolvePrincipal().role,'ADMIN');
 assert.equal(c.smartRetailErpSessionBridge40.grant,undefined);
 assert.deepEqual([...Array(c.localStorage.length)].map((_,i)=>c.localStorage.key(i)).sort(),before);
});
await test('Standalone ERP resolves all optional assets without a parent application',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../outputs/split118/Smart_Retail_ERP_v118.html'),'utf8');
 const all=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
 const byId=new Map(all.map(m=>[m[1].match(/id="([^"]+)"/)?.[1],{textContent:m[2]}]));
 const c={document:{getElementById:id=>byId.get(id)},atob:s=>Buffer.from(s,'base64').toString('binary'),Uint8Array,TextDecoder};c.window=c;c.parent=c;vm.createContext(c);vm.runInContext(source('ERP','sr108Assets'),c);
 for(const name of ['waybill','uzum','scanner','canvas','pdf'])assert(c.SRAssets108.text(name).length>100);
 assert(c.SRAssets108.decode(c.SRAssets108.text('uzum')).includes('UZUM_PRO_DATA'));assert(JSON.parse(c.SRAssets108.text('waybill')).pdf);
});
await test('Old shared server sync routes stay inactive until explicitly configured per app',()=>{
 for(const mode of ['ERP','Analitika']){
  let calls=0;const c={emp70:{takeSyncStorage:()=>({})},location:{protocol:'https:'},fetch:()=>{calls++}};c.window=c;vm.createContext(c);
  vm.runInContext(source(mode,mode==='ERP'?'crm21ServerSync':'smartRetailParentServerSync'),c);assert.equal(calls,0);
 }
});
const report={environment:'Node VM with simulated native Storage, IndexedDB, Web Locks and minimal DOM; no browser/device/server run',tests:results.length,passed:results.filter(r=>r.status==='pass').length,results};
fs.writeFileSync(path.join(__dirname,'test118-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({tests:report.tests,passed:report.passed,failed:results.filter(r=>r.status!=='pass')},null,2));process.exitCode=report.passed===report.tests?0:1;
})();
