// Independent local protocol fixture. All keys, identities and tokens are generated test data.
import {createServer} from 'node:http';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
export async function createOidcFixture(t){
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),codes=new Map();
  const fixture={fault:null,requests:[],clientId:'synthetic-store',clientSecret:'synthetic-provider-secret',claims:{sub:'synthetic-user',groups:['research-readers'],name:'Synthetic Researcher'}};
  const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,fixture.issuer);fixture.requests.push({path:url.pathname,method:req.method});
    if(url.pathname==='/.well-known/openid-configuration'){
      if(fixture.fault==='discovery-unavailable')return send(res,503,{error:'temporarily_unavailable'});
      return send(res,200,{issuer:fixture.issuer,authorization_endpoint:fixture.issuer+'/authorize',token_endpoint:fixture.issuer+'/token',jwks_uri:fixture.issuer+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_basic'],code_challenge_methods_supported:['S256']});
    }
    if(url.pathname==='/jwks')return send(res,200,{keys:[{...publicKey.export({format:'jwk'}),kid:'generated-test-key',use:'sig',alg:'RS256'}]});
    if(url.pathname==='/authorize'){
      if(url.searchParams.get('code_challenge_method')!=='S256'||!url.searchParams.get('state')||!url.searchParams.get('nonce'))return send(res,400,{error:'invalid_request'});
      const code=randomBytes(24).toString('base64url');codes.set(code,{parameters:new URLSearchParams(url.searchParams),claims:structuredClone(fixture.claims),fault:fixture.fault});
      const target=new URL(url.searchParams.get('redirect_uri'));target.searchParams.set('code',code);target.searchParams.set('state',url.searchParams.get('state'));
      res.writeHead(302,{Location:target.href});res.end();return;
    }
    if(url.pathname==='/token'&&req.method==='POST'){
      let bytes='';for await(const chunk of req){bytes+=chunk;if(bytes.length>16384)return send(res,400,{error:'invalid_request'});}
      const parameters=new URLSearchParams(bytes),code=parameters.get('code'),transaction=codes.get(code);codes.delete(code);
      const credentialParts=Buffer.from((req.headers.authorization??'').split(' ')[1]??'','base64').toString('utf8').split(':').map(value=>decodeURIComponent(value.replaceAll('+',' ')));
      const basic=req.headers.authorization?.startsWith('Basic ')&&credentialParts[0]===fixture.clientId&&credentialParts[1]===fixture.clientSecret;
      fixture.lastTokenChecks={basic,knownCode:!!transaction,grant:parameters.get('grant_type')==='authorization_code',callback:parameters.get('redirect_uri')===transaction?.parameters.get('redirect_uri'),pkce:!!transaction&&createHash('sha256').update(parameters.get('code_verifier')??'').digest('base64url')===transaction.parameters.get('code_challenge')};
      if(!basic||!transaction||parameters.get('grant_type')!=='authorization_code'||parameters.get('redirect_uri')!==transaction.parameters.get('redirect_uri')
        ||createHash('sha256').update(parameters.get('code_verifier')??'').digest('base64url')!==transaction.parameters.get('code_challenge'))return send(res,400,{error:'invalid_grant'});
      const now=Math.floor(Date.now()/1000),claims={iss:fixture.issuer,aud:fixture.clientId,iat:now,exp:now+300,nonce:transaction.parameters.get('nonce'),...transaction.claims};
      if(transaction.fault==='wrong-nonce')claims.nonce='wrong-generated-nonce';
      if(transaction.fault==='wrong-issuer')claims.iss='https://unrelated.invalid';
      if(transaction.fault==='wrong-audience')claims.aud='other-generated-client';
      if(transaction.fault==='expired')claims.exp=now-300;
      const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'generated-test-key'})).toString('base64url'),body=Buffer.from(JSON.stringify(claims)).toString('base64url'),payload=head+'.'+body;
      let signature=sign('RSA-SHA256',Buffer.from(payload),privateKey).toString('base64url');
      if(transaction.fault==='bad-signature')signature=(signature[0]==='A'?'B':'A')+signature.slice(1);
      return send(res,200,{access_token:'synthetic-unused-access-token',token_type:'Bearer',expires_in:300,...(transaction.fault==='missing-id-token'?{}:{id_token:payload+'.'+signature})});
    }
    send(res,404,{error:'not_found'});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  fixture.issuer=`http://127.0.0.1:${server.address().port}`;
  fixture.authorize=async authorizationUrl=>{
    const response=await fetch(authorizationUrl,{redirect:'manual'});await response.body?.cancel();
    if(response.status!==302)throw new Error('Synthetic IdP did not issue an authorization code.');return response.headers.get('location');
  };
  fixture.configuration=(overrides={})=>({mode:'hybrid',oidc:{issuer:fixture.issuer,clientId:fixture.clientId,clientSecret:fixture.clientSecret,callbackUrl:'http://127.0.0.1:8048/api/v1/auth/oidc/callback',allowInsecureLoopback:true,groupsClaim:'groups',subjectRoles:{},groupRoles:{'research-readers':'reader','research-writers':'contributor','research-admins':'administrator'},...overrides}});
  fixture.close=()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  t?.after(()=>fixture.close());return fixture;
}
