import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateAuthConfiguration,mappedRole} from '../src/auth/config.js';
import {OidcProvider} from '../src/auth/OidcProvider.js';
import {Auth} from '../src/http/Auth.js';
import {createOidcFixture} from './fixtures/oidc-provider.js';
const request=token=>({headers:{cookie:'easi_store_session='+token}});

test('private configuration enforces exact HTTPS callback, literal-loopback opt-in, explicit mappings and safe own fields',()=>{
  const valid={mode:'oidc',oidc:{issuer:'https://issuer.example',clientId:'store',subjectRoles:{'subject-1':'reader'},groupRoles:{team:'administrator'}}};
  const configured=validateAuthConfiguration(valid,{publicUrl:'https://store.example'});
  assert.equal(configured.oidc.callbackUrl,'https://store.example/api/v1/auth/oidc/callback');
  assert.equal(mappedRole(configured,{issuer:'https://issuer.example',subject:'subject-1',groups:['team']}),'administrator');
  assert.equal(mappedRole(configured,{issuer:'https://issuer.example',subject:'unknown',groups:[]}),null);
  assert.equal(mappedRole(configured,{issuer:'https://other.example',subject:'subject-1',groups:['team']}),null);
  for(const oidc of [{...valid.oidc,issuer:'http://127.0.0.1:9999'}, {...valid.oidc,issuer:'http://localhost:9999',allowInsecureLoopback:true},
    {...valid.oidc,callbackUrl:'https://store.example/wrong'},{...valid.oidc,defaultRole:'reader'},{...valid.oidc,groupRoles:{'*':'owner'}},
    {...valid.oidc,issuer:'https://user:secret@issuer.example'},{...valid.oidc,issuer:'https://issuer.example/.well-known/openid-configuration'}])assert.throws(()=>validateAuthConfiguration({...valid,oidc},{publicUrl:'https://store.example'}));
  assert.throws(()=>validateAuthConfiguration(valid,{publicUrl:'http://0.0.0.0:8048'}));
  for(const issuer of ['http://127.1:9999','http://2130706433:9999','http://0x7f000001:9999'])assert.throws(()=>validateAuthConfiguration({...valid,oidc:{...valid.oidc,issuer,allowInsecureLoopback:true}},{publicUrl:'http://127.0.0.1:8048'}));
  let accessed=false;assert.throws(()=>validateAuthConfiguration({mode:'oidc',get oidc(){accessed=true;return valid.oidc;}}));assert.equal(accessed,false);
  assert.deepEqual(validateAuthConfiguration(),{mode:'local'});
});

test('real code flow verifies signed ID token, state, nonce, PKCE and exact issuer+subject identity without retaining provider tokens',async t=>{
  const idp=await createOidcFixture(t),configuration=validateAuthConfiguration(idp.configuration()),provider=new OidcProvider(configuration);t.after(()=>provider.close());
  assert.equal(idp.requests.length,0,'Provider discovery is lazy.');
  const start=await provider.start(),authorization=new URL(start.authorizationUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');assert.equal(authorization.searchParams.get('scope'),'openid profile');
  assert.ok(authorization.searchParams.get('nonce'));assert.ok(authorization.searchParams.get('state'));
  const url=await idp.authorize(start.authorizationUrl),identity=await provider.complete({url,transactionCookie:start.transactionCookie});
  assert.equal(identity.role,'reader');assert.equal(identity.displayName,'Synthetic Researcher');assert.match(identity.id,/^oidc:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(identity).includes('synthetic-unused-access-token'),false);
  assert.equal(idp.requests.filter(item=>item.path==='/jwks').length,1,'JWS verification fetches the real generated public key.');
  await assert.rejects(provider.complete({url,transactionCookie:start.transactionCookie}),{code:'oidc-signin-failed'});
});

for(const fault of ['wrong-nonce','wrong-issuer','wrong-audience','expired','bad-signature','missing-id-token'])test(`real OIDC library rejects ${fault} before creating an identity`,async t=>{
  const idp=await createOidcFixture(t);idp.fault=fault;const provider=new OidcProvider(validateAuthConfiguration(idp.configuration()));t.after(()=>provider.close());
  const start=await provider.start(),url=await idp.authorize(start.authorizationUrl);
  await assert.rejects(provider.complete({url,transactionCookie:start.transactionCookie}),error=>error.code==='oidc-signin-failed'&&!error.message.includes('synthetic-provider-secret'));
});

test('browser binding, expiry, duplicate callback parameters and exact callback origin fail closed',async t=>{
  const idp=await createOidcFixture(t);let now=Date.now();const provider=new OidcProvider(validateAuthConfiguration(idp.configuration()),{now:()=>now});t.after(()=>provider.close());
  let start=await provider.start(),url=await idp.authorize(start.authorizationUrl);
  await assert.rejects(provider.complete({url,transactionCookie:'A'.repeat(43)}),{code:'oidc-signin-failed'});
  assert.equal((await provider.complete({url,transactionCookie:start.transactionCookie})).role,'reader','A wrong browser cookie does not consume another transaction.');
  start=await provider.start();url=await idp.authorize(start.authorizationUrl);now+=10*60_000+1;
  await assert.rejects(provider.complete({url,transactionCookie:start.transactionCookie}),{code:'oidc-signin-failed'});
  start=await provider.start();url=await idp.authorize(start.authorizationUrl);
  await assert.rejects(provider.complete({url:url.replace('127.0.0.1:8048','unrelated.example'),transactionCookie:start.transactionCookie}),{code:'oidc-signin-failed'});
  start=await provider.start();url=await idp.authorize(start.authorizationUrl);
  await assert.rejects(provider.complete({url:url+'&state=repeated',transactionCookie:start.transactionCookie}),{code:'oidc-signin-failed'});
});

test('unmapped identities and malformed group claims cannot receive fallback or email-based access',async t=>{
  const idp=await createOidcFixture(t),provider=new OidcProvider(validateAuthConfiguration(idp.configuration()));t.after(()=>provider.close());
  idp.claims={sub:'unmapped-user',groups:[],email:'same@example.test',email_verified:true};let start=await provider.start(),url=await idp.authorize(start.authorizationUrl);
  await assert.rejects(provider.complete({url,transactionCookie:start.transactionCookie}),{code:'oidc-unmapped',statusCode:403});
  idp.claims={sub:'synthetic-user',groups:'research-admins'};start=await provider.start();url=await idp.authorize(start.authorizationUrl);
  await assert.rejects(provider.complete({url,transactionCookie:start.transactionCookie}),{code:'oidc-signin-failed'});
});

test('IdP outage does not block local startup or silently enable local login in OIDC-only mode',async t=>{
  const idp=await createOidcFixture(t);idp.fault='discovery-unavailable';const dataDir=await mkdtemp(join(tmpdir(),'easi-auth-oidc-'));
  const configuration=idp.configuration();configuration.mode='oidc';const auth=await new Auth(dataDir,{configuration}).open();t.after(async()=>{await auth.close();await rm(dataDir,{recursive:true,force:true});});
  assert.equal(auth.description().localLoginAvailable,false);assert.equal(auth.description().setupRequired,false);
  await assert.rejects(auth.startOidc(),{code:'oidc-unavailable',statusCode:503});
  await assert.rejects(auth.login({username:'recovery',password:'synthetic-password'},'127.0.0.1'),{code:'local-auth-disabled'});
  await assert.rejects(auth.setup({username:'recovery',password:'synthetic-password'},'127.0.0.1'),{code:'local-auth-disabled'});
  assert.equal(auth.sessions.size,0);
});

test('OIDC sessions and delegated credentials re-evaluate static roles and never merge separate subjects by email',async t=>{
  const idp=await createOidcFixture(t),dataDir=await mkdtemp(join(tmpdir(),'easi-auth-mapped-')),auth=await new Auth(dataDir,{configuration:idp.configuration()}).open();
  t.after(async()=>{await auth.close();await rm(dataDir,{recursive:true,force:true});});await auth.setup({username:'recovery',password:'synthetic-recovery-password'},'127.0.0.1');
  idp.claims={sub:'first',groups:['research-admins'],name:'Same display',email:'same@example.test'};
  let start=await auth.startOidc(),url=await idp.authorize(start.authorizationUrl),login=await auth.completeOidc({url,transactionCookie:start.transactionCookie});
  const first=auth.identify(request(login.token)),credential=await auth.createApiToken({label:'Synthetic role binding',role:'administrator',expiresInDays:1},first);
  auth.configuration.oidc.groupRoles['research-admins']='reader';
  assert.equal(auth.identify(request(login.token)).role,'reader');assert.equal(auth.identify({headers:{authorization:'Bearer '+credential.token}}).role,'reader');
  delete auth.configuration.oidc.groupRoles['research-admins'];assert.equal(auth.identify(request(login.token)),null);assert.equal(auth.identify({headers:{authorization:'Bearer '+credential.token}}),null);
  idp.claims={sub:'second',groups:['research-readers'],name:'Same display',email:'same@example.test'};
  start=await auth.startOidc();url=await idp.authorize(start.authorizationUrl);login=await auth.completeOidc({url,transactionCookie:start.transactionCookie});
  assert.notEqual(login.principal.id,first.id);
});

test('bounded provider transport rejects redirects, excessive bodies and non-loopback insecure endpoints',async()=>{
  const configuration=validateAuthConfiguration({mode:'hybrid',oidc:{issuer:'https://issuer.example',clientId:'store',callbackUrl:'https://store.example/api/v1/auth/oidc/callback'}});
  let called=false;const provider=new OidcProvider(configuration,{fetchImpl:async()=>{called=true;return new Response('x'.repeat(1024*1024+1));}});
  await assert.rejects(provider.boundedFetch(new URL('http://127.0.0.1:8048/token')));assert.equal(called,false);
  await assert.rejects(provider.boundedFetch(new URL('https://issuer.example/jwks')));assert.equal(provider.requests.size,0);
  const redirects=new OidcProvider(configuration,{fetchImpl:async()=>new Response(null,{status:302,headers:{Location:'https://unrelated.example'}})});
  await assert.rejects(redirects.boundedFetch(new URL('https://issuer.example/jwks')));provider.close();redirects.close();
});

test('parallel sign-in starts remain capped and close releases browser transactions',async t=>{
  const idp=await createOidcFixture(t),provider=new OidcProvider(validateAuthConfiguration(idp.configuration()));
  const results=await Promise.allSettled(Array.from({length:105},()=>provider.start()));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,100);assert.equal(provider.transactions.size,100);
  assert.ok(results.filter(result=>result.status==='rejected').every(result=>result.reason.statusCode===429));provider.close();assert.equal(provider.transactions.size,0);
});

test('bounded discovery timeout aborts upstream work, releases requests and returns a safe availability error',async()=>{
  const configuration=validateAuthConfiguration({mode:'hybrid',oidc:{issuer:'https://issuer.example',clientId:'store',callbackUrl:'https://store.example/api/v1/auth/oidc/callback'}});
  let aborted=false;const provider=new OidcProvider(configuration,{timeoutMs:20,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Synthetic private upstream detail'));},{once:true});})});
  // Keep a referenced test timer: provider timeouts deliberately do not keep a process alive.
  const keepAlive=setTimeout(()=>{},1000);
  try{await assert.rejects(provider.start(),error=>error.code==='oidc-unavailable'&&!error.message.includes('private upstream'));assert.equal(aborted,true);assert.equal(provider.requests.size,0);assert.equal(provider.transactions.size,0);}finally{clearTimeout(keepAlive);provider.close();}
});
