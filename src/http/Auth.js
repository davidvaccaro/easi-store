import {randomBytes,randomUUID,scrypt as derive,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {readFile,open,rename,mkdir,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {authError,checkedObject,checkedText,mappedRole,roleAllowed,roleRank,ROLES,validateAuthConfiguration} from '../auth/config.js';
import {OidcProvider} from '../auth/OidcProvider.js';
const scrypt=promisify(derive),digest=value=>createHash('sha256').update(value).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,TOKEN=/^[A-Za-z0-9_-]{43}$/;
export const isLoopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const denied=()=>authError('This identity is not authorized for that credential operation.',403,'identity-forbidden');
const unauthorized=()=>authError('Invalid username or password.',401,'invalid-credentials');
const passwordValue=value=>{if(typeof value!=='string'||value.length<12||value.length>1024)throw authError('Use a password with 12–1024 characters.');return value;};
const usernameValue=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_.@-]{3,80}$/.test(value))throw authError('Username must contain 3–80 letters, numbers, or . _ @ -.');return value;};
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
function cookieValue(req,name){const cookies=req.headers?.cookie;if(typeof cookies!=='string'||cookies.length>16384)return null;const matches=cookies.split(';').map(item=>item.trim()).filter(item=>item.startsWith(name+'='));return matches.length===1?matches[0].slice(name.length+1):null;}
async function syncDirectory(directory){if(process.platform==='win32')return;const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
function checkedRecord(record){
  if(!record||![1,2].includes(record.version)||typeof record.username!=='string'||typeof record.salt!=='string'||!/^[a-f0-9]{32}$/.test(record.salt)||typeof record.hash!=='string'||!/^[a-f0-9]{128}$/.test(record.hash)||!Array.isArray(record.apiTokens)||record.apiTokens.length>1000)throw new Error('Authentication state requires an integrity review.');
  usernameValue(record.username);const seen=new Set(),ids=new Set();
  for(const token of record.apiTokens){
    if(!token||!HASH.test(token.hash)||seen.has(token.hash)||typeof token.label!=='string'||!iso(token.createdAt))throw new Error('Authentication state requires an integrity review.');seen.add(token.hash);
    if(record.version===2){
      if(!UUID.test(token.id)||ids.has(token.id)||!ROLES.includes(token.role)||token.expiresAt!==null&&!iso(token.expiresAt)||token.revokedAt!==null&&!iso(token.revokedAt)||typeof token.createdBy!=='string'||!token.creator||!['local','oidc','token'].includes(token.creator.source))throw new Error('Authentication state requires an integrity review.');
      ids.add(token.id);const creator=token.creator;
      if(creator.source==='local'&&!UUID.test(creator.binding)||creator.source==='token'&&!UUID.test(creator.tokenId)
        ||creator.source==='oidc'&&(!creator.identity||typeof creator.identity.issuer!=='string'||typeof creator.identity.subject!=='string'||!Array.isArray(creator.identity.groups)||creator.identity.groups.length>200||creator.identity.groups.some(group=>typeof group!=='string')||typeof creator.id!=='string'||typeof creator.displayName!=='string'))throw new Error('Authentication state requires an integrity review.');
    }
  }
  if(record.version===2&&!UUID.test(record.credentialVersion))throw new Error('Authentication state requires an integrity review.');
  return record;
}

/** One local recovery administrator, externally mapped identities, and scoped integration credentials. */
export class Auth {
  constructor(dataDir,{configuration,publicUrl,onAudit,oidcOptions={}}={}){
    this.path=path.join(dataDir,'auth.json');this.dataDir=dataDir;this.record=null;this.sessions=new Map();this.attempts=new Map();this.queue=Promise.resolve();this.contexts=new WeakMap();
    this.configuration=validateAuthConfiguration(configuration??{mode:'local'},{publicUrl});this.onAudit=onAudit;
    this.oidc=this.configuration.mode!=='local'?new OidcProvider(this.configuration,oidcOptions):null;
  }
  async open(){
    await mkdir(this.dataDir,{recursive:true,mode:0o700});
    try{
      const info=await lstat(this.path);if(!info.isFile()||info.isSymbolicLink()||info.size>2*1024*1024)throw new Error('Authentication state requires an integrity review.');
      const record=checkedRecord(JSON.parse(await readFile(this.path,'utf8')));
      if(record.version===1){
        const credentialVersion=randomUUID();
        const upgraded={...record,version:2,credentialVersion,apiTokens:record.apiTokens.map(token=>({...token,id:randomUUID(),label:token.label.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,120),role:'administrator',expiresAt:null,revokedAt:null,createdBy:'local:administrator',creator:{source:'local',binding:credentialVersion},legacy:true}))};
        await this.save(upgraded);this.record=upgraded;
      }else this.record=record;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const bootstrapPath=path.join(this.dataDir,'bootstrap-token');
    try{this.bootstrap=(await readFile(bootstrapPath,'utf8')).trim();}
    catch(error){if(error.code!=='ENOENT')throw error;this.bootstrap=randomBytes(32).toString('base64url');const handle=await open(bootstrapPath,'wx',0o600);try{await handle.writeFile(this.bootstrap+'\n');await handle.sync();}finally{await handle.close();}await syncDirectory(this.dataDir);}
    return this;
  }
  description(){return {mode:this.configuration.mode,localLoginAvailable:this.configuration.mode!=='oidc',oidcAvailable:!!this.oidc,setupRequired:!this.record&&this.configuration.mode!=='oidc',oidcLabel:this.configuration.oidc?.label??null};}
  ensureAvailable(){if(this.closed||this.failed)throw authError('Authentication is unavailable until the server is restarted.',503,'authentication-unavailable');}
  async save(record=this.record){
    const temporary=`${this.path}.${randomBytes(8).toString('hex')}.tmp`;let renamed=false;
    try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();}finally{await handle.close();}await rename(temporary,this.path);renamed=true;await syncDirectory(this.dataDir);}
    catch(error){if(renamed)this.failed=true;await rm(temporary,{force:true}).catch(()=>{});throw error;}
  }
  async mutate(operation){
    this.ensureAvailable();const pending=this.queue.then(async()=>{this.ensureAvailable();const next=this.record?structuredClone(this.record):null;const result=await operation(next);
      if(Buffer.byteLength(JSON.stringify(result.record))>1024*1024)result.record.apiTokens=result.record.apiTokens.filter(token=>!token.revokedAt&&(!token.expiresAt||Date.parse(token.expiresAt)>Date.now()));
      if(Buffer.byteLength(JSON.stringify(result.record))>1024*1024)throw authError('Credential storage is full. Revoke unused credentials before creating more.',409,'credential-storage-limit');
      await this.save(result.record);this.record=result.record;return result.value;});
    this.queue=pending.catch(()=>{});return pending;
  }
  audit(action,actor=null,tokenId){try{const result=this.onAudit?.({action,outcome:'success',actor:actor?{id:actor.id,source:actor.source,role:actor.role}:null,...(tokenId?{tokenId}:{})});result?.catch?.(()=>{});}catch{/* The host owns durable request audit admission. */}}
  rateLimit(address){const now=Date.now();for(const[key,value]of this.attempts)if(value.reset<now)this.attempts.delete(key);if(!this.attempts.has(address)){if(this.attempts.size>=500)throw authError('Too many authentication attempts. Try again later.',429,'authentication-rate-limit');this.attempts.set(address,{count:0,reset:now+15*60_000});}if(++this.attempts.get(address).count>10)throw authError('Too many authentication attempts. Try again later.',429,'authentication-rate-limit');}
  localContext(){return {source:'local',binding:this.record?.credentialVersion};}
  resolveContext(context,seen=new Set()){
    if(!context||!this.record)return null;
    if(context.source==='local')return context.binding===this.record.credentialVersion?{id:'local:administrator',source:'local',role:'administrator',displayName:this.record.username}:null;
    if(context.source==='oidc'){const role=mappedRole(this.configuration,context.identity);return role?{id:context.id,source:'oidc',role,displayName:context.displayName}:null;}
    if(context.source==='token'){
      const token=this.record.apiTokens.find(item=>item.id===context.tokenId);
      if(!token||token.revokedAt||token.expiresAt&&Date.parse(token.expiresAt)<=Date.now()||seen.has(token.id)||seen.size>=8)return null;
      seen.add(token.id);const creator=this.resolveContext(token.creator,seen);if(!creator)return null;
      const role=roleRank(token.role)<=roleRank(creator.role)?token.role:creator.role;
      return {id:`token:${token.id}`,source:'token',role,displayName:token.label,tokenId:token.id};
    }return null;
  }
  principal(context,type){const identity=this.resolveContext(context);if(!identity)return null;const result={...identity,type};this.contexts.set(result,structuredClone(context));return result;}
  authorized(principal){const context=this.contexts.get(principal),current=this.principal(context,principal?.type);if(!current)throw denied();return {principal:current,context};}
  session(context=this.localContext(),expiresAt=Date.now()+12*60*60_000){
    this.ensureAvailable();if(!this.resolveContext(context))throw denied();
    const now=Date.now();for(const[key,value]of this.sessions)if(value.expiresAt<=now)this.sessions.delete(key);
    if(this.sessions.size>=100)this.sessions.delete(this.sessions.keys().next().value);
    const token=randomBytes(32).toString('base64url');this.sessions.set(digest(token),{context:structuredClone(context),expiresAt});return token;
  }
  async setup(input,address){
    this.ensureAvailable();if(this.configuration.mode==='oidc')throw authError('Local password setup is disabled in this authentication mode.',403,'local-auth-disabled');
    checkedObject(input,['username','password','bootstrapToken'],'administrator setup');if(this.record||this.settingUp)throw authError('An administrator is already configured or setup is in progress.',409,'already-configured');this.rateLimit(address);
    if(!isLoopback(address)&&(typeof input.bootstrapToken!=='string'||digest(input.bootstrapToken)!==digest(this.bootstrap)))throw authError('Enter the one-time bootstrap token from the server data directory.',401,'bootstrap-required');
    const username=usernameValue(input.username),password=passwordValue(input.password);this.settingUp=true;
    try{await this.mutate(async current=>{if(current)throw authError('An administrator is already configured.',409);const salt=randomBytes(16).toString('hex'),hash=Buffer.from(await scrypt(password,salt,64)).toString('hex');return {record:{version:2,username,salt,hash,credentialVersion:randomUUID(),apiTokens:[]}};});}
    finally{this.settingUp=false;}
    this.audit('administrator-setup');return this.session();
  }
  async verifyPassword(password,record){if(typeof password!=='string'||password.length>1024)return false;const actual=Buffer.from(await scrypt(password,record.salt,64));return timingSafeEqual(actual,Buffer.from(record.hash,'hex'));}
  async login(input,address){
    this.ensureAvailable();if(this.configuration.mode==='oidc')throw authError('Local password sign-in is disabled in this authentication mode.',403,'local-auth-disabled');checkedObject(input,['username','password'],'sign-in');this.rateLimit(address);
    const record=this.record;if(!record||!await this.verifyPassword(input.password,record)||input.username!==record.username||record.credentialVersion!==this.record?.credentialVersion)throw unauthorized();
    this.attempts.delete(address);const token=this.session();this.audit('local-signin',this.principal(this.localContext(),'session'));return token;
  }
  identify(req){
    if(this.closed||this.failed)return null;
    const authorization=req.headers?.authorization;
    if(authorization!==undefined){if(typeof authorization!=='string'||!authorization.startsWith('Bearer ')||!TOKEN.test(authorization.slice(7)))return null;const hash=digest(authorization.slice(7)),record=this.record?.apiTokens.find(token=>token.hash===hash);return record?this.principal({source:'token',tokenId:record.id},'bearer'):null;}
    const value=cookieValue(req,'easi_store_session');if(!value||!TOKEN.test(value))return null;const key=digest(value),session=this.sessions.get(key);
    if(!session||session.expiresAt<=Date.now()){this.sessions.delete(key);return null;}
    const principal=this.principal(session.context,'session');if(!principal)this.sessions.delete(key);return principal;
  }
  logout(req){const value=cookieValue(req,'easi_store_session');if(value)this.sessions.delete(digest(value));}
  listTokens(principal){const {principal:actor}=this.authorized(principal);return {items:this.record.apiTokens.filter(token=>actor.role==='administrator'||token.createdBy===actor.id).map(({id,label,role,createdAt,expiresAt,revokedAt,createdBy,legacy})=>({id,label,role,createdAt,expiresAt,revokedAt,createdBy,...(legacy?{legacy:true}:{})}))};}
  async createApiToken(input,principal){
    checkedObject(input,['label','role','expiresInDays'],'API credential');const label=checkedText(input.label,120,'credential label'),role=input.role,days=input.expiresInDays;
    if(!ROLES.includes(role)||!Number.isInteger(days)||days<1||days>365)throw authError('Choose a credential role and an expiry between 1 and 365 days.');
    const initial=this.authorized(principal);if(!roleAllowed(role,initial.principal.role))throw denied();
    const token=randomBytes(32).toString('base64url'),id=randomUUID();
    const record=await this.mutate(next=>{
      const {principal:actor,context}=this.authorized(principal);if(!roleAllowed(role,actor.role))throw denied();
      if(next.apiTokens.length>=1000)next.apiTokens=next.apiTokens.filter(token=>!token.revokedAt&&(!token.expiresAt||Date.parse(token.expiresAt)>Date.now()));
      if(next.apiTokens.length>=1000)throw authError('The archive has reached its limit of 1,000 active credential records. Revoke an existing credential first.',409,'credential-limit');
      const now=Date.now(),stored={id,hash:digest(token),label,role,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+days*86400000).toISOString(),revokedAt:null,createdBy:actor.id,creator:context};next.apiTokens.push(stored);
      const {hash,creator,...safe}=stored;return {record:next,value:safe};
    });this.audit('api-credential-created',initial.principal,id);return {token,record};
  }
  async issueApiToken(label='Local integration'){
    if(!this.record)throw new Error('Create an administrator in the browser before creating an API token.');
    return (await this.createApiToken({label,role:'administrator',expiresInDays:365},this.principal(this.localContext(),'session'))).token;
  }
  async revokeApiToken(id,principal){
    if(typeof id!=='string'||!UUID.test(id))throw authError('Choose a valid API credential.');const initial=this.authorized(principal);
    const result=await this.mutate(next=>{const {principal:actor}=this.authorized(principal),token=next.apiTokens.find(item=>item.id===id);if(!token)throw authError('API credential not found.',404,'credential-not-found');if(actor.role!=='administrator'&&token.createdBy!==actor.id)throw denied();token.revokedAt??=new Date().toISOString();return {record:next,value:{revoked:true}};});
    this.audit('api-credential-revoked',initial.principal,id);return result;
  }
  async changePassword(input,principal){
    checkedObject(input,['currentPassword','newPassword'],'password change');const password=passwordValue(input.newPassword),{principal:actor}=this.authorized(principal);
    if(actor.source!=='local'||actor.type!=='session')throw denied();
    await this.mutate(async next=>{this.authorized(principal);if(!await this.verifyPassword(input.currentPassword,next))throw unauthorized();next.salt=randomBytes(16).toString('hex');next.hash=Buffer.from(await scrypt(password,next.salt,64)).toString('hex');next.credentialVersion=randomUUID();for(const token of next.apiTokens)token.revokedAt??=new Date().toISOString();return {record:next};});
    for(const[key,value]of this.sessions)if(value.context.source==='local')this.sessions.delete(key);
    this.audit('local-password-changed',actor);return {changed:true,reauthenticate:true};
  }
  async resetLocalAdmin(input){
    checkedObject(input,['username','password'],'local recovery');const username=usernameValue(input.username),password=passwordValue(input.password);
    await this.mutate(async current=>{const salt=randomBytes(16).toString('hex'),hash=Buffer.from(await scrypt(password,salt,64)).toString('hex');return {record:{version:2,username,salt,hash,credentialVersion:randomUUID(),apiTokens:(current?.apiTokens??[]).map(token=>({...token,revokedAt:token.revokedAt??new Date().toISOString()}))}};});
    this.sessions.clear();this.audit('local-administrator-recovered');return {reset:true,reauthenticate:true};
  }
  async startOidc(){this.ensureAvailable();if(!this.oidc)throw authError('Organization sign-in is not configured.',404,'oidc-disabled');return this.oidc.start();}
  async completeOidc(input){
    this.ensureAvailable();if(!this.oidc)throw authError('Organization sign-in is not configured.',404,'oidc-disabled');const identity=await this.oidc.complete(input);
    const context={source:'oidc',identity:identity.identity,id:identity.id,displayName:identity.displayName},token=this.session(context,identity.expiresAt),principal=this.principal(context,'session');this.audit('organization-signin',principal);return {token,principal};
  }
  async close(){this.closed=true;this.oidc?.close();this.sessions.clear();await this.queue;}
}
