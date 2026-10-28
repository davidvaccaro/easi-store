import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Auth} from '../src/http/Auth.js';
const password='synthetic-local-password',credentials={username:'research',password};
const cookie=token=>({headers:{cookie:'easi_store_session='+token}}),bearer=token=>({headers:{authorization:'Bearer '+token}});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'easi-store-auth-core-'));let auth=await new Auth(dir).open();t.after(async()=>{await auth.close();await rm(dir,{recursive:true,force:true});});return {dir,get auth(){return auth;},async restart(){await auth.close();auth=await new Auth(dir).open();return auth;}};}

test('legacy local hashes/tokens migrate durably without changing credential validity and sessions remain restart-scoped',async t=>{
  const f=await fixture(t);await f.auth.setup(credentials,'127.0.0.1');const oldToken=randomBytes(32).toString('base64url'),oldHash=f.auth.record.hash;
  const legacy={version:1,username:f.auth.record.username,salt:f.auth.record.salt,hash:oldHash,apiTokens:[{hash:createHash('sha256').update(oldToken).digest('hex'),label:'Legacy synthetic integration',createdAt:new Date().toISOString()}]};
  await writeFile(join(f.dir,'auth.json'),JSON.stringify(legacy));await f.restart();
  assert.equal(f.auth.record.version,2);assert.equal(f.auth.record.hash,oldHash);assert.equal(f.auth.identify(bearer(oldToken)).role,'administrator');
  const session=await f.auth.login(credentials,'127.0.0.1'),actor=f.auth.identify(cookie(session));assert.equal(actor.source,'local');assert.equal(actor.type,'session');
  const listed=f.auth.listTokens(actor);assert.equal(listed.items[0].legacy,true);assert.equal(listed.items[0].expiresAt,null);assert.equal(JSON.stringify(listed).includes(legacy.apiTokens[0].hash),false);
  assert.equal((await readFile(join(f.dir,'auth.json'),'utf8')).includes(oldToken),false);
  if(process.platform!=='win32')assert.equal((await stat(join(f.dir,'auth.json'))).mode&0o777,0o600);
  await f.auth.revokeApiToken(listed.items[0].id,actor);await f.restart();assert.equal(f.auth.identify(cookie(session)),null);assert.equal(f.auth.identify(bearer(oldToken)),null);
});

test('single built-in administrator setup is reserved before derivation and requires bootstrap outside literal loopback',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.auth.setup(credentials,'192.0.2.2'),{code:'bootstrap-required'});
  const results=await Promise.allSettled([f.auth.setup({...credentials,bootstrapToken:f.auth.bootstrap},'192.0.2.2'),f.auth.setup({username:'other',password},'127.0.0.1')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(f.auth.record.username,'research');
  assert.deepEqual(f.auth.description(),{mode:'local',localLoginAvailable:true,oidcAvailable:false,setupRequired:false,oidcLabel:null});
});

test('scoped expiring credentials show secrets once, enforce delegation ceilings and revoke descendant capabilities',async t=>{
  const f=await fixture(t),session=await f.auth.setup(credentials,'127.0.0.1'),admin=f.auth.identify(cookie(session));
  const issued=await f.auth.createApiToken({label:'Synthetic reader',role:'reader',expiresInDays:7},admin);
  assert.match(issued.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(issued.record.role,'reader');assert.equal(f.auth.identify(bearer(issued.token)).role,'reader');
  const reader=f.auth.identify(bearer(issued.token));
  await assert.rejects(f.auth.createApiToken({label:'Escalation',role:'administrator',expiresInDays:1},reader),{statusCode:403});
  const child=await f.auth.createApiToken({label:'Synthetic delegate',role:'reader',expiresInDays:1},reader);
  assert.equal(f.auth.identify(bearer(child.token)).role,'reader');assert.equal(f.auth.listTokens(reader).items.length,1);
  await assert.rejects(f.auth.revokeApiToken(issued.record.id,reader),{statusCode:403});
  await f.auth.revokeApiToken(issued.record.id,admin);assert.equal(f.auth.identify(bearer(issued.token)),null);assert.equal(f.auth.identify(bearer(child.token)),null);
  const listing=JSON.stringify(f.auth.listTokens(admin));assert.equal(listing.includes(issued.token),false);assert.equal(listing.includes('"hash"'),false);assert.equal(listing.includes('"creator"'),false);
});

test('credential expiry, malformed authorization and duplicate cookies fail closed without session fallback',async t=>{
  const f=await fixture(t),session=await f.auth.setup(credentials,'127.0.0.1'),admin=f.auth.identify(cookie(session));
  const issued=await f.auth.createApiToken({label:'Expiry',role:'contributor',expiresInDays:1},admin);
  f.auth.record.apiTokens[0].expiresAt=new Date(Date.now()-1000).toISOString();assert.equal(f.auth.identify(bearer(issued.token)),null);
  assert.equal(f.auth.identify({headers:{authorization:'Bearer invalid',cookie:'easi_store_session='+session}}),null);
  assert.equal(f.auth.identify({headers:{cookie:`easi_store_session=${session}; easi_store_session=${session}`}}),null);
  f.auth.sessions.get(createHash('sha256').update(session).digest('hex')).expiresAt=Date.now()-1;assert.equal(f.auth.identify(cookie(session)),null);
});

test('password change requires the current secret and invalidates every local session and API token durably',async t=>{
  const f=await fixture(t),a=await f.auth.setup(credentials,'127.0.0.1'),b=await f.auth.login(credentials,'127.0.0.1'),actor=f.auth.identify(cookie(a)),token=await f.auth.issueApiToken('Local synthetic');
  await assert.rejects(f.auth.changePassword({currentPassword:'wrong',newPassword:'replacement-synthetic-password'},actor),{code:'invalid-credentials'});
  assert.ok(f.auth.identify(cookie(b)));assert.ok(f.auth.identify(bearer(token)));
  assert.deepEqual(await f.auth.changePassword({currentPassword:password,newPassword:'replacement-synthetic-password'},actor),{changed:true,reauthenticate:true});
  assert.equal(f.auth.identify(cookie(a)),null);assert.equal(f.auth.identify(cookie(b)),null);assert.equal(f.auth.identify(bearer(token)),null);
  await assert.rejects(f.auth.login(credentials,'127.0.0.1'),{code:'invalid-credentials'});
  await f.restart();assert.equal(f.auth.identify(bearer(token)),null);assert.match(await f.auth.login({username:'research',password:'replacement-synthetic-password'},'127.0.0.1'),/^[A-Za-z0-9_-]{43}$/);
});

test('offline local recovery serializes replacement, revokes credentials and does not alter configured login policy',async t=>{
  const f=await fixture(t),session=await f.auth.setup(credentials,'127.0.0.1'),token=await f.auth.issueApiToken('Before recovery');
  const mode=f.auth.configuration.mode;assert.deepEqual(await f.auth.resetLocalAdmin({username:'recovered',password:'recovered-synthetic-password'}),{reset:true,reauthenticate:true});
  assert.equal(f.auth.configuration.mode,mode);assert.equal(f.auth.identify(cookie(session)),null);assert.equal(f.auth.identify(bearer(token)),null);
  await f.restart();await assert.rejects(f.auth.login(credentials,'127.0.0.1'),{code:'invalid-credentials'});
  assert.ok(await f.auth.login({username:'recovered',password:'recovered-synthetic-password'},'127.0.0.1'));
});

test('failed persistent changes leave memory and disk unchanged and do not poison later serialized writes',async t=>{
  const f=await fixture(t),session=await f.auth.setup(credentials,'127.0.0.1'),actor=f.auth.identify(cookie(session)),before=await readFile(join(f.dir,'auth.json'),'utf8'),save=f.auth.save.bind(f.auth);
  f.auth.save=async()=>{throw new Error('synthetic write failure');};
  await assert.rejects(f.auth.createApiToken({label:'Not committed',role:'reader',expiresInDays:1},actor),/synthetic write failure/);
  assert.equal(f.auth.record.apiTokens.length,0);assert.equal(await readFile(join(f.dir,'auth.json'),'utf8'),before);
  await assert.rejects(f.auth.changePassword({currentPassword:password,newPassword:'not-committed-password'},actor),/synthetic write failure/);
  assert.ok(f.auth.identify(cookie(session)));f.auth.save=save;
  const results=await Promise.all(Array.from({length:24},(_,i)=>f.auth.createApiToken({label:`Concurrent ${i}`,role:'reader',expiresInDays:1},actor)));
  assert.equal(f.auth.record.apiTokens.length,24);await f.restart();assert.ok(results.every(result=>f.auth.identify(bearer(result.token))?.role==='reader'));
});

test('strict credential schemas, roles and untrusted principal objects cannot bypass privilege checks',async t=>{
  const f=await fixture(t),session=await f.auth.setup(credentials,'127.0.0.1'),actor=f.auth.identify(cookie(session));
  for(const input of [{label:'',role:'reader',expiresInDays:1},{label:'line\nbreak',role:'reader',expiresInDays:1},{label:'x'.repeat(121),role:'reader',expiresInDays:1},
    {label:'Bad',role:'owner',expiresInDays:1},{label:'Bad',role:'reader',expiresInDays:0},{label:'Bad',role:'reader',expiresInDays:366},{label:'Bad',role:'reader',expiresInDays:1.5},
    {label:'Bad',role:'reader',expiresInDays:NaN},{label:'Bad',role:'reader',expiresInDays:1,hash:'injected'}])await assert.rejects(f.auth.createApiToken(input,actor),{statusCode:400});
  await assert.rejects(f.auth.createApiToken({label:'Forged admin',role:'administrator',expiresInDays:1},{id:'local:administrator',source:'local',type:'session',role:'administrator'}),{statusCode:403});
  let accessed=false;await assert.rejects(f.auth.createApiToken({get label(){accessed=true;return 'bad';},role:'reader',expiresInDays:1},actor),{statusCode:400});assert.equal(accessed,false);
  assert.equal(f.auth.record.apiTokens.length,0);
});

test('authentication throttling, logout and shutdown release ephemeral state without writing raw secrets to audit events',async t=>{
  const f=await fixture(t),events=[];f.auth.onAudit=event=>events.push(event);
  const token=await f.auth.setup(credentials,'127.0.0.1'),apiToken=await f.auth.issueApiToken('Synthetic audited integration');f.auth.logout(cookie(token));assert.equal(f.auth.identify(cookie(token)),null);
  for(let i=0;i<10;i++)await assert.rejects(f.auth.login({username:'research',password:'wrong'},'192.0.2.10'),{statusCode:401});
  await assert.rejects(f.auth.login(credentials,'192.0.2.10'),{statusCode:429});
  const serialized=JSON.stringify(events);for(const secret of [password,token,apiToken,f.auth.bootstrap])assert.equal(serialized.includes(secret),false);
  await f.auth.close();assert.equal(f.auth.sessions.size,0);assert.equal(f.auth.identify(bearer(apiToken)),null);
});

test('credential cap is bounded but recovers capacity from revoked/expired records without invalidating live credentials',async t=>{
  const f=await fixture(t),session=await f.auth.setup(credentials,'127.0.0.1'),actor=f.auth.identify(cookie(session)),live=await f.auth.createApiToken({label:'Retained live credential',role:'reader',expiresInDays:1},actor),template=f.auth.record.apiTokens[0];
  for(let index=1;index<1000;index++)f.auth.record.apiTokens.push({...structuredClone(template),id:randomUUID(),hash:createHash('sha256').update(String(index)).digest('hex'),revokedAt:new Date().toISOString()});
  await f.auth.createApiToken({label:'Capacity recovered',role:'reader',expiresInDays:1},actor);assert.equal(f.auth.record.apiTokens.length,2);assert.ok(f.auth.identify(bearer(live.token)));
  for(let index=2;index<1000;index++)f.auth.record.apiTokens.push({...structuredClone(template),id:randomUUID(),hash:createHash('sha256').update('live'+index).digest('hex')});
  await assert.rejects(f.auth.createApiToken({label:'Too many live credentials',role:'reader',expiresInDays:1},actor),{code:'credential-limit',statusCode:409});
  assert.equal(f.auth.record.apiTokens.length,1000);
});

test('corrupted durable credential identifiers and creator bindings are rejected before serving authentication',async t=>{
  const f=await fixture(t),session=await f.auth.setup(credentials,'127.0.0.1'),actor=f.auth.identify(cookie(session));await f.auth.createApiToken({label:'Integrity fixture',role:'reader',expiresInDays:1},actor);
  const baseline=structuredClone(f.auth.record),cases=[];
  const duplicate=structuredClone(baseline);duplicate.apiTokens.push({...structuredClone(duplicate.apiTokens[0]),hash:'a'.repeat(64)});cases.push(duplicate);
  const binding=structuredClone(baseline);binding.apiTokens[0].creator.binding='invalid-binding';cases.push(binding);
  const unknown=structuredClone(baseline);unknown.apiTokens[0].creator={source:'unknown'};cases.push(unknown);
  const malformed=structuredClone(baseline);malformed.apiTokens[0].creator={source:'oidc',identity:{issuer:'https://issuer.example',subject:'test',groups:'administrators'}};cases.push(malformed);
  for(const record of cases){await writeFile(join(f.dir,'auth.json'),JSON.stringify(record));const damaged=new Auth(f.dir);await assert.rejects(damaged.open(),/integrity review/);assert.equal(damaged.identify(bearer('A'.repeat(43))),null);}
});
