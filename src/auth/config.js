export const ROLES = Object.freeze(['reader','contributor','administrator']);
export const roleRank = role => ROLES.indexOf(role);
export const roleAllowed = (role,ceiling) => roleRank(role) >= 0 && roleRank(role) <= roleRank(ceiling);
export const CALLBACK_PATH = '/api/v1/auth/oidc/callback';
export const authError = (message,statusCode=400,code='invalid-authentication') => Object.assign(new Error(message),{statusCode,code});
export function checkedObject(value,keys,label='authentication') {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))
    ||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!keys.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')))throw authError(`Invalid ${label} fields.`);
  return value;
}
export function checkedText(value,max,label,{empty=false}={}) {
  if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value)||!empty&&!value.trim())throw authError(`Invalid ${label}.`);
  return value;
}
const loopback = hostname => ['127.0.0.1','[::1]'].includes(hostname);
export function checkedOidcUrl(value,allowInsecureLoopback,label) {
  let url;try{url=new URL(checkedText(value,2048,label));}catch{throw authError(`Invalid ${label}.`);}
  if(url.username||url.password||url.hash||url.search||url.protocol!=='https:'&&!(allowInsecureLoopback&&url.protocol==='http:'&&loopback(url.hostname)))throw authError(`${label} requires HTTPS; explicit development HTTP is limited to literal loopback addresses.`);
  if(url.protocol==='http:'&&!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(value))throw authError(`${label} development HTTP must use a literal 127.0.0.1 or [::1] address.`);
  return url;
}
function mapping(value,label) {
  value??={};checkedObject(value,Object.keys(value),label);
  if(Object.keys(value).length>1000)throw authError(`Too many ${label}.`);
  const result=Object.create(null);
  for(const [key,role]of Object.entries(value)){
    checkedText(key,255,label);
    if(!ROLES.includes(role))throw authError(`Invalid ${label} role.`);
    result[key]=role;
  }
  return result;
}
/** Private server-side policy. Never return this object from an HTTP endpoint. */
export function validateAuthConfiguration(input={mode:'local'},{publicUrl}={}) {
  checkedObject(input,['mode','oidc']);
  const mode=input.mode??'local';
  if(!['local','oidc','hybrid'].includes(mode))throw authError('Choose local, oidc or hybrid authentication.');
  if(input.oidc==null){if(mode!=='local')throw authError('Configure an OIDC provider for this authentication mode.');return {mode};}
  const value=checkedObject(input.oidc,['issuer','clientId','clientSecret','callbackUrl','allowInsecureLoopback','label','groupsClaim','subjectRoles','groupRoles'],'OIDC provider');
  if(value.allowInsecureLoopback!==undefined&&typeof value.allowInsecureLoopback!=='boolean')throw authError('The loopback development flag must be boolean.');
  const insecure=value.allowInsecureLoopback??false;
  const issuer=checkedOidcUrl(value.issuer,insecure,'OIDC issuer');
  if(issuer.pathname.includes('/.well-known/'))throw authError('Configure the exact issuer, not a discovery document URL.');
  const base=checkedOidcUrl(publicUrl??value.callbackUrl,insecure,'Public Store URL');
  if(publicUrl&&(base.pathname!=='/'||base.search||base.hash))throw authError('The public Store URL must be an origin without a path.');
  const expected=base.origin+CALLBACK_PATH;
  if(value.callbackUrl!==undefined&&value.callbackUrl!==expected)throw authError('OIDC callback URL must exactly match the configured public Store callback.');
  if(!publicUrl&&base.pathname!==CALLBACK_PATH)throw authError('Configure the public Store URL or its exact OIDC callback URL.');
  const clientId=checkedText(value.clientId,255,'OIDC client ID');
  const clientSecret=value.clientSecret===undefined?undefined:checkedText(value.clientSecret,4096,'OIDC client secret');
  const groupsClaim=checkedText(value.groupsClaim??'groups',80,'OIDC groups claim');
  if(!/^[A-Za-z0-9_:/.-]+$/.test(groupsClaim))throw authError('Choose a single exact OIDC groups claim name.');
  return {mode,oidc:{issuer:value.issuer,clientId,...(clientSecret===undefined?{}:{clientSecret}),callbackUrl:expected,
    allowInsecureLoopback:insecure,label:checkedText(value.label??'Organization sign-in',80,'OIDC provider label'),groupsClaim,
    subjectRoles:mapping(value.subjectRoles,'subject mappings'),groupRoles:mapping(value.groupRoles,'group mappings')}};
}
export function mappedRole(configuration,identity) {
  const provider=configuration.oidc;
  if(configuration.mode==='local'||!provider||identity.issuer!==provider.issuer)return null;
  const candidates=[provider.subjectRoles[identity.subject],...(identity.groups??[]).map(group=>provider.groupRoles[group])].filter(role=>ROLES.includes(role));
  return candidates.sort((a,b)=>roleRank(b)-roleRank(a))[0]??null;
}
