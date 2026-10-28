import {createHash,randomBytes} from 'node:crypto';
import * as client from 'openid-client';
import {authError,checkedOidcUrl,mappedRole} from './config.js';
const digest=value=>createHash('sha256').update(value).digest('hex');
const failure=()=>authError('Organization sign-in could not be completed. Start sign-in again or contact your administrator.',401,'oidc-signin-failed');
const unavailable=()=>authError('Organization sign-in is temporarily unavailable. Retry later or contact your administrator.',503,'oidc-unavailable');
export class OidcProvider {
  constructor(configuration,{fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=10000}={}) {
    this.configuration=configuration;this.fetchImpl=fetchImpl;this.now=now;this.timeoutMs=timeoutMs;this.transactions=new Map();this.requests=new Set();this.closed=false;
  }
  async boundedFetch(input,options={}) {
    const provider=this.configuration.oidc,url=typeof input==='string'?new URL(input):input;
    checkedOidcUrl(url.href,provider.allowInsecureLoopback,'OIDC endpoint');
    const controller=new AbortController();this.requests.add(controller);
    const timeout=setTimeout(()=>controller.abort(),this.timeoutMs);timeout.unref?.();
    try{
      if(this.closed)throw unavailable();
      const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal,fetchImpl=this.fetchImpl;
      const response=await fetchImpl(input,{...options,signal,redirect:'error',credentials:'omit'});
      if(response.status>=300&&response.status<400){await response.body?.cancel();throw unavailable();}
      const chunks=[];let bytes=0;
      if(response.body)for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024*1024)throw unavailable();chunks.push(Buffer.from(chunk));}
      return new Response(bytes?Buffer.concat(chunks):null,{status:response.status,statusText:response.statusText,headers:response.headers});
    }finally{clearTimeout(timeout);this.requests.delete(controller);}
  }
  async discover() {
    if(this.closed)throw unavailable();
    if(!this.discovery){
      const provider=this.configuration.oidc;
      this.discovery=client.discovery(new URL(provider.issuer),provider.clientId,{...(provider.clientSecret?{client_secret:provider.clientSecret}:{}),id_token_signed_response_alg:'RS256'},
        provider.clientSecret?client.ClientSecretBasic(provider.clientSecret):client.None(),{
          timeout:this.timeoutMs/1000,[client.customFetch]:(...args)=>this.boundedFetch(...args),
          execute:[client.enableNonRepudiationChecks,...(provider.allowInsecureLoopback?[client.allowInsecureRequests]:[])]
        }).then(configuration=>{
          const metadata=configuration.serverMetadata();
          for(const field of ['authorization_endpoint','token_endpoint','jwks_uri'])checkedOidcUrl(metadata[field],provider.allowInsecureLoopback,'OIDC endpoint');
          return configuration;
        }).catch(()=>{this.discovery=null;throw unavailable();});
    }
    return this.discovery;
  }
  prune(){for(const[key,value]of this.transactions)if(value.expiresAt<=this.now())this.transactions.delete(key);}
  async start() {
    const configuration=await this.discover();this.prune();
    if(this.transactions.size>=100)throw authError('Too many sign-in transactions. Retry after an earlier sign-in expires.',429,'oidc-busy');
    const transactionCookie=randomBytes(32).toString('base64url'),state=client.randomState(),nonce=client.randomNonce(),verifier=client.randomPKCECodeVerifier();
    const challenge=await client.calculatePKCECodeChallenge(verifier);
    if(this.closed)throw unavailable();
    if(this.transactions.size>=100)throw authError('Too many sign-in transactions. Retry after an earlier sign-in expires.',429,'oidc-busy');
    const authorizationUrl=client.buildAuthorizationUrl(configuration,{redirect_uri:this.configuration.oidc.callbackUrl,scope:'openid profile',response_mode:'query',
      state,nonce,code_challenge:challenge,code_challenge_method:'S256'}).href;
    if(authorizationUrl.length>8192)throw unavailable();
    this.transactions.set(digest(transactionCookie),{state,nonce,verifier,expiresAt:this.now()+10*60_000});
    return {authorizationUrl,transactionCookie};
  }
  async complete({url,transactionCookie}) {
    this.prune();
    if(typeof transactionCookie!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(transactionCookie))throw failure();
    const key=digest(transactionCookie),transaction=this.transactions.get(key);this.transactions.delete(key);
    if(!transaction||transaction.expiresAt<=this.now()||this.closed)throw failure();
    try{
      const current=new URL(url),expected=new URL(this.configuration.oidc.callbackUrl);
      if(current.origin!==expected.origin||current.pathname!==expected.pathname||current.hash||current.username||current.password||current.href.length>16384)throw failure();
      const configuration=await this.discover();
      const result=await client.authorizationCodeGrant(configuration,current,{pkceCodeVerifier:transaction.verifier,expectedState:transaction.state,expectedNonce:transaction.nonce,idTokenExpected:true});
      const claims=result.claims();
      if(this.closed||!claims||typeof claims.sub!=='string'||!claims.sub||claims.sub.length>255||/[\x00-\x1f\x7f]/.test(claims.sub))throw failure();
      const groups=claims[this.configuration.oidc.groupsClaim]??[];
      if(!Array.isArray(groups)||groups.length>200||groups.some(group=>typeof group!=='string'||!group||group.length>255||/[\x00-\x1f\x7f]/.test(group)))throw failure();
      const identity={issuer:this.configuration.oidc.issuer,subject:claims.sub,groups:[...new Set(groups)]};
      const role=mappedRole(this.configuration,identity);if(!role)throw authError('This organization account has no assigned EASI Store role.',403,'oidc-unmapped');
      const displayName=typeof claims.name==='string'?claims.name.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,120).trim():'Organization account';
      return {identity,id:`oidc:${digest(JSON.stringify([identity.issuer,identity.subject]))}`,role,displayName:displayName||'Organization account',expiresAt:Math.min(this.now()+12*60*60_000,claims.exp*1000)};
    }catch(error){if(error.code==='oidc-unmapped')throw error;throw failure();}
  }
  close(){this.closed=true;this.transactions.clear();for(const controller of this.requests)controller.abort();this.requests.clear();}
}
