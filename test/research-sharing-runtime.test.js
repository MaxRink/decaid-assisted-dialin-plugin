const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {timedMeasurements} = require('./shot-fixtures');
const source = fs.readFileSync('plugin.js', 'utf8');
const sharedSource = fs.readFileSync('research-sharing.js', 'utf8');
const KEY = 'researchSharing.v1';
const tick = () => new Promise(setImmediate);
const clone = value => JSON.parse(JSON.stringify(value));
const reply = (value, ok = true) => ({ok, json: async () => value});
const shot = {id: 'PRIVATE-SHOT', timestamp: '2026-10-12T09:11:22.000Z', notes: 'PRIVATE-NOTE',
  workflow: {context: {grinderId: 'PRIVATE-GRINDER', beanBatchId: 'PRIVATE-BEAN', grinderModel: 'E64 WS',
    grinderSetting: '50', targetDoseWeight: 18, targetYield: 36, extras: {grinderSettingUnit: 'micrometres'}},
    profile: {title: 'PRIVATE-PROFILE', steps: [{pump: 'pressure', pressure: 9}]}},
  measurements: timedMeasurements('2026-10-12T09:11:22.000Z', 25), annotations: {actualDoseWeight: 18}};
function fixture(t, {stored = new Map(), send = async (_, init) => reply({accepted: JSON.parse(init.body).records.length}), delayWrite = false, readShot = async () => reply(clone(shot))} = {}) {
  let plugin;
  const posts = [], writes = [], pendingWrites = [];
  const context = vm.createContext({console, Date, JSON, Math, Promise, setTimeout, clearTimeout});
  vm.runInContext(sharedSource + '\n' + source + '\nthis.make = createPlugin;', context);
  plugin = context.make({log() {}, storage(command) {
    if (command.type === 'read') queueMicrotask(() => plugin.onEvent({name:'storageRead',payload:{key:command.key,value:clone(stored.get(command.key) ?? null)}}));
    else {
      writes.push(clone(command));
      const acknowledge = () => { stored.set(command.key,clone(command.data)); plugin.onEvent({name:'storageWrite',payload:clone(command.data)}); };
      if (delayWrite && command.key === KEY) pendingWrites.push(acknowledge); else queueMicrotask(acknowledge);
    }
  }}, {fetch: async (url, init) => {
    if (url.startsWith('http://127.0.0.1:8080/api/v1/shots/')) return readShot();
    if (url.startsWith('https://')) { posts.push({url,init:clone(init)}); return send(url,init); }
    throw new Error('unexpected fetch ' + url);
  }});
  plugin.onLoad({});
  t.after(() => plugin.onUnload());
  const request = async (method = 'GET',body,endpoint = 'sharing') => {
    const response = await plugin.handleHttpRequest({endpoint,method,body});
    return {status:response.status,body:JSON.parse(response.body)};
  };
  return {plugin,posts,writes,pendingWrites,stored,request};
}
async function captured(f,count=1) {
  for(let i=0;i<30;i++){await tick();const result=await f.request();if(result.body.localCount===count)return result.body;}
  assert.fail('research capture did not settle');
}
const enable = f => f.request('POST',{sharing:true,endpoint:'https://collector.example/v1/records',acknowledgeHostLimits:true});
test('local archive defaults on, remote off; export omits identities, notes and timestamps',async t=>{
  const f=fixture(t);assert.equal((await f.request()).body.sharing,false);
  f.plugin.onEvent({name:'shotStored',payload:{id:shot.id}});await captured(f);
  assert.equal(f.posts.length,0);
  const exported=(await f.request('GET',null,'sharing-export')).body;
  assert.equal(exported.records.length,1);assert.equal(exported.records[0].grinder.setting,50);
  const data=JSON.stringify(exported.records);assert.doesNotMatch(data,/PRIVATE-|2026-10-12|timestamp|shotId|beanBatchId/);
});
test('consent requires HTTPS and host-limits acknowledgment; no archive backfill',async t=>{
  const f=fixture(t);f.plugin.onEvent({name:'shotStored',payload:{id:shot.id}});await captured(f);
  assert.equal((await f.request('POST',{sharing:true,endpoint:'https://collector.example/v1/records'})).status,400);
  assert.equal((await f.request('POST',{sharing:true,endpoint:'http://collector.example',acknowledgeHostLimits:true})).status,400);
  assert.equal((await enable(f)).status,200);assert.equal((await f.request()).body.queuedCount,0);
  assert.equal((await f.request()).body.hostCapabilities.requestCancellation,false);
});
test('duplicate events coalesce and corrected feedback replaces the pending record',async t=>{
  const f=fixture(t);await enable(f);
  f.plugin.onEvent({name:'shotStored',payload:{id:shot.id}});await captured(f);
  f.plugin.onEvent({name:'shotUpdated',payload:{id:shot.id}});await tick();await tick();
  const saved=await f.request('POST',{shotId:shot.id,good:true,taste:'balanced',notes:'PRIVATE-NOTE'},'feedback');
  assert.equal(saved.status,200);
  for(let i=0;i<30;i++){await tick();const out=(await f.request('GET',null,'sharing-export')).body;if(out.records[0]?.taste?.intent==='balanced')break;}
  assert.equal((await f.request()).body.queuedCount,1);
  await f.request('POST',{operation:'retry'});
  assert.equal(f.posts.length,1);
  const batch=JSON.parse(f.posts[0].init.body);assert.equal(batch.records.length,1);assert.equal(batch.records[0].taste.intent,'balanced');
  assert.deepEqual(Object.keys(f.posts[0].init.headers),['Content-Type']);assert.doesNotMatch(f.posts[0].init.body,/PRIVATE-|timestamp/);
});
test('offline queue survives reload; opting out clears queue but keeps local records',async t=>{
  const stored=new Map();const f=fixture(t,{stored,send:async()=>{throw new Error('offline');}});await enable(f);
  f.plugin.onEvent({name:'shotStored',payload:{id:shot.id}});await captured(f);
  const failed=await f.request('POST',{operation:'retry'});assert.equal(failed.body.queuedCount,1);assert.match(failed.body.error,/upload failed/);
  f.plugin.onUnload();const reloaded=fixture(t,{stored});assert.equal((await reloaded.request()).body.queuedCount,1);
  const off=await reloaded.request('POST',{sharing:false});assert.equal(off.body.sharing,false);assert.equal(off.body.queuedCount,0);assert.equal(off.body.localCount,1);
  await reloaded.request('POST',{operation:'retry'});assert.equal(reloaded.posts.length,0);
});
test('local opt-out stops capture and deleting all removes the archive',async t=>{
  const f=fixture(t);f.plugin.onEvent({name:'shotStored',payload:{id:shot.id}});await captured(f);
  await f.request('POST',{operation:'local',enabled:false});await f.request('DELETE');
  f.plugin.onEvent({name:'shotStored',payload:{id:shot.id}});await tick();await tick();
  const state=await f.request();assert.equal(state.body.localEnabled,false);assert.equal(state.body.localCount,0);assert.equal(state.body.sharing,false);
});
test('sharing storage acknowledgment cannot acknowledge a feedback write',async t=>{
  const f=fixture(t,{delayWrite:true});await f.request();
  const enabling=enable(f);await tick();assert.equal(f.pendingWrites.length,1);
  const saved=await f.request('POST',{shotId:shot.id,good:true},'feedback');assert.equal(saved.status,200);
  f.pendingWrites.shift()();assert.equal((await enabling).status,200);
});

test('opting out during an upload fences its late failure and prevents further sends',async t=>{
  let failUpload;
  const f=fixture(t,{send:()=>new Promise((_,reject)=>{failUpload=reject;})});await enable(f);
  f.plugin.onEvent({name:'shotStored',payload:{id:shot.id}});await captured(f);
  const flushing=f.request('POST',{operation:'retry'});await tick();assert.equal(typeof failUpload,'function');
  const off=await f.request('POST',{sharing:false});assert.equal(off.body.queuedCount,0);
  failUpload(new Error('late offline failure'));await flushing;
  const status=await f.request();assert.equal(status.body.sharing,false);assert.equal(status.body.error,null);
  assert.equal(f.posts.length,1);
});

test('an unchanged shot is not uploaded again after reload',async t=>{
  const stored=new Map(), first=fixture(t,{stored});await enable(first);
  first.plugin.onEvent({name:'shotStored',payload:{id:shot.id}});await captured(first);
  await first.request('POST',{operation:'retry'});assert.equal(first.posts.length,1);first.plugin.onUnload();
  const next=fixture(t,{stored});await next.request();
  next.plugin.onEvent({name:'shotUpdated',payload:{id:shot.id}});
  for(let i=0;i<10;i++)await tick();
  assert.equal((await next.request()).body.queuedCount,0);
  await next.request('POST',{operation:'retry'});assert.equal(next.posts.length,0);
});


test('a late older shot fetch cannot replace a newer correction',async t=>{
  let firstResolve,calls=0;
  const updated=clone(shot);updated.workflow.context.grinderSetting='55';
  const f=fixture(t,{readShot:()=>++calls===1?new Promise(resolve=>{firstResolve=resolve;}):reply(updated)});
  await f.request();f.plugin.onEvent({name:'shotStored',payload:{id:shot.id}});await tick();
  f.plugin.onEvent({name:'shotUpdated',payload:{id:shot.id}});await captured(f);
  firstResolve(reply(clone(shot)));for(let i=0;i<10;i++)await tick();
  const exported=(await f.request('GET',null,'sharing-export')).body;
  assert.equal(exported.records[0].grinder.setting,55);
});
