// Usage: node deploy/test-server/smoke-ip.mjs /private/access.private.json
// Real TLS verification is mandatory. Never prints credentials or session tokens.
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const credentials=JSON.parse(readFileSync(process.argv[2]));
const ip='47.110.245.29';
// Server-local diagnostics retain verification against the public IP certificate.
const loopback=process.argv.includes('--loopback');
console.log(`Connection path: ${loopback?'server loopback (not public acceptance)':'public IP'}`);
const ports={platform:9441,tenant:9442,web:443};
let checks=0;
async function request(scope,path,{body,token,host,cookie,method,origin}={}) {
  const port=ports[scope];
  return new Promise((resolve,reject)=>{
    const data=body === undefined ? undefined : JSON.stringify(body);
    const req=https.request({hostname:loopback?'127.0.0.1':ip,checkServerIdentity:(_host,cert)=>checkServerIdentity(ip,cert),port,path,method:method ?? (data?'POST':'GET'),headers:{
      host:host ?? `${ip}${port===443?'':`:${port}`}`,
      ...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),
      ...(token?{authorization:`Bearer ${token}`} : {}),...(cookie?{cookie}:{}),
      ...(origin === undefined?{}:{origin}),
    }},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{
      let json;try{json=JSON.parse(raw)}catch{}
      resolve({status:res.statusCode,headers:res.headers,json,raw});
    });});req.setTimeout(15000,()=>req.destroy(new Error('HTTPS request timed out')));
    req.on('error',reject);req.end(data);
  });
}
function check(result,status,name){assert.equal(result.status,status,`${name}: ${result.json?.message ?? result.status}`);checks++;console.log(`PASS ${name} (${status})`);return result;}
for(const scope of Object.keys(ports)) {
  const ready=check(await request(scope,'/api/v1/health/ready'),200,`${scope} DB/cache readiness`);
  assert.equal(ready.json.status,'ready');
  assert.match(check(await request(scope,'/'),200,`${scope} static page`).raw,/<html/);
  check(await request(scope,'/api/v1/health/ready',{host:'unverified.test'}),421,`${scope} Host guard`);
}
const adminOrigin=`https://${ip}:9441`,agentOrigin=`https://${ip}:9442`;
const admin=check(await request('platform','/api/v1/platform/auth/login',{body:credentials.admin,origin:adminOrigin}),200,'HQ browser login');
assert.match(admin.headers['set-cookie'][0],/Secure/);
const token=admin.json.accessToken;
const tenants=check(await request('platform','/api/v1/platform/merchants',{token}),200,'HQ merchants');
const tenant=tenants.json.items.find(item=>item.code==='demo');assert.ok(tenant);
const agent=check(await request('tenant','/api/v1/tenant/auth/login',{body:credentials.agent,origin:agentOrigin}),200,'agent browser login');
assert.equal(agent.json.principal.tenantId,tenant.id);
check(await request('tenant','/api/v1/tenant/customers',{token:agent.json.accessToken}),200,'agent customer list');
check(await request('tenant','/api/v1/tenant/customers',{token}),401,'HQ token rejected by agent');
for(const origin of [agentOrigin,'https://evil.test','null']) {
  check(await request('platform','/api/v1/platform/auth/login',{body:credentials.admin,origin}),403,`HQ rejects cross-origin ${origin}`);
}
check(await request('tenant','/api/v1/tenant/auth/login',{body:credentials.agent,origin:adminOrigin}),400,'agent rejects HQ browser origin');
check(await request('platform','/api/v1/platform/auth/refresh',{method:'POST',cookie:admin.headers['set-cookie'][0].split(';')[0],origin:adminOrigin}),200,'HQ refresh preserves secure cookie');
for(const [scope,path] of [['web','platform/merchants'],['web','tenant/customers'],['platform','tenant/customers'],['tenant','platform/merchants']]) {
  check(await request(scope,`/api/v1/${path}`,{token}),404,`${scope} rejects foreign service route`);
}
const bootstrap=check(await request('web','/api/v1/customer/bootstrap'),200,'IP guest bootstrap');
assert.equal(bootstrap.json.defaultLocale,'zh-CN');assert.equal(bootstrap.json.supportedLocales.length,15);
assert.equal(bootstrap.json.capabilities.inAppPurchases,false);
const viewer=check(await request('web','/api/v1/customer/auth/login',{body:{identifier:credentials.customer.username,password:credentials.customer.password,devicePlatform:'android',deviceLabel:'IP gateway smoke test'}}),200,'test viewer login');
assert.equal(viewer.json.principal.tenantId,tenant.id);
check(await request('web','/api/v1/customer/account/me',{token:viewer.json.accessToken}),200,'viewer profile');
const wallet=check(await request('web','/api/v1/customer/wallet/points',{token:viewer.json.accessToken}),200,'gift wallet');
assert.equal(String(wallet.json.balancePoints),'1000');
console.log(`IP HTTPS smoke complete: ${checks} checks; credentials not printed.`);
