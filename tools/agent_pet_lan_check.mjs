// Read-only readiness check for a LAN bridge profile; never listens or binds.
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {networkInterfaces} from 'node:os';

const path=resolve(process.argv[2]??'.agent-pet/lan/config.json');
const base=dirname(path);
const config=JSON.parse(readFileSync(path,'utf8'));
const file=p=>readFileSync(resolve(base,p),'utf8');
const problems=[];
const local=new Set();
for(const list of Object.values(networkInterfaces()))for(const item of list??[])if(!item.internal)local.add(item.address);
if(config.bind==='0.0.0.0'||config.bind==='::')problems.push('bind must be an explicit interface address');
if(!local.has(config.bind))problems.push(`bind ${config.bind} is not a current local address`);
const cert=new X509Certificate(file(config.tls_cert));
const key=createPrivateKey(file(config.tls_key));
const keyMatches=cert.checkPrivateKey(key);
if(keyMatches===false)problems.push('certificate does not match the private key');
const san=cert.subjectAltName??'';
const names=[...san.matchAll(/(?:DNS|IP Address):([^,\s]+)/g)].map(m=>m[1]);
if(!names.includes(config.server_name))problems.push(`certificate SAN does not include server_name ${config.server_name}`);
if(!names.includes(config.bind))problems.push(`certificate SAN does not include bind address ${config.bind}`);
const endpoint=new URL(config.public_endpoint);
if(endpoint.protocol!=='wss:')problems.push('public_endpoint must use wss://');
if(endpoint.hostname!==config.bind)problems.push('public_endpoint host must equal bind address');
if(config.time_bootstrap_url&&new URL(config.time_bootstrap_url).hostname!==config.bind)
  problems.push('time_bootstrap_url host must equal bind address');
const now=Date.now();
if(!(new Date(cert.validFrom)<=now&&now<=new Date(cert.validTo)))problems.push('certificate is not currently valid');
JSON.parse(file(config.credentials));JSON.parse(file(config.store));
console.log(JSON.stringify({
  bind:config.bind,endpoint:config.public_endpoint,server_name:config.server_name,
  certificate_sans:names,certificate_valid_until:cert.validTo,
  key_matches_certificate:keyMatches,
  exposure:'would listen on the local network interface while running',
  ready:problems.length===0,problems},null,1));
process.exit(problems.length?1:0);
