import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {createService} from '../src/server.mjs';
import {Store} from '../src/security.mjs';

test('USB helper restores private policy and relays accepted, confirmed and queried host actions', {timeout:15000}, async t=>{
  const directory=mkdtempSync(join(tmpdir(),'agent-pet-usb-'));
  const setup=spawnSync(process.execPath,[fileURLToPath(new URL('../src/setup.mjs',import.meta.url)),directory],{encoding:'utf8'});
  assert.equal(setup.status,0,'Fixture setup failed');
  const read=name=>readFileSync(join(directory,name),'utf8');
  const credentials=JSON.parse(read('credentials.json'));
  const store=new Store();store.data=JSON.parse(read('store.json'));
  store.data.devices[0].mode='public';
  const service=createService({tls:{key:read('tls-key.pem'),cert:read('tls-cert.pem')},store,
    signingKey:read('signing-key.pem'),adapterToken:credentials.adapter_token});
  let child;
  t.after(async()=>{
    child?.kill('SIGTERM');
    await service.close();
    const absolute=realpathSync(directory),temporary=realpathSync(tmpdir());
    assert.equal(dirname(absolute),temporary,'Refuse unexpected fixture cleanup parent');
    assert(basename(absolute).startsWith('agent-pet-usb-'),'Refuse unexpected fixture cleanup name');
    rmSync(absolute,{recursive:true});
  });
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  await new Promise(resolve=>service.ipc.listen(0,'127.0.0.1',resolve));
  const ipc=`http://127.0.0.1:${service.ipc.address().port}`;
  const headers={authorization:`Bearer ${credentials.adapter_token}`,'content-type':'application/json'};
  const event={source_id:credentials.source_id,session_id:'selected-session',run_id:'observed-turn',revision:1,
    title:'Synthetic test task',entity_kind:'turn',execution_state:'running',pending_interactions:[],
    capabilities:{open_on_host:true}};
  const ingest=await fetch(ipc+'/v1/events',{method:'POST',headers,
    body:JSON.stringify({source_credential:credentials.source_credential,event})});
  assert.equal(ingest.status,200);await ingest.arrayBuffer();
  const helper=fileURLToPath(new URL('../../tools/agent_pet_usb_bridge.mjs',import.meta.url));
  child=spawn(process.execPath,[helper],{stdio:['pipe','pipe','pipe']});
  const completed=[],statuses=[];let count=0,target,dispatched=0,done=false;
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const lines=createInterface({input:child.stdout});
  let timer;
  const received=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('Duplex USB protocol did not complete')),6000);
    child.once('error',reject);
    child.once('exit',()=>{if(!done)reject(new Error('Helper ended before confirmed action query'))});
    lines.on('line',async line=>{
      try{
        const frame=JSON.parse(line);
        assert.equal(frame.view_epoch,'usb-policy-test');
        if(frame.type==='snapshot.begin')count=0;
        if(frame.type==='snapshot.page'){
          count+=(frame.payload.tasks??[]).length;
          target??=frame.payload.tasks?.[0]?.id;
        }
        if(frame.type==='snapshot.end'){
          completed.push(count);
          assert.equal(count,1,'Do not forward a baseline made under stale public policy');
          // A second auth message from serial must never replace the host credential.
          send({v:1,type:'auth',payload:{credential:'invalid'}});
          send({v:1,type:'action.prepare',payload:{target_id:target}});
        }
        if(frame.type==='action.offer'){
          assert.equal(frame.payload.type,'open_on_host');
          assert.equal(frame.payload.target_id,target);
          assert.equal(typeof frame.payload.token,'string');
          send({v:1,type:'action',payload:{...frame.payload,action_id:'usb-action-one',
            device_boot_id:'usb-boot-one',parameters:{}}});
        }
        if(frame.type==='action.result'){
          statuses.push(frame.payload.status);
          if(frame.payload.status==='accepted'){
            const response=await fetch(ipc+'/v1/commands',{headers:{...headers,'X-Source-Credential':credentials.source_credential}});
            assert.equal(response.status,200);
            const {commands}=await response.json();assert.equal(commands.length,1);dispatched++;
            // This is an explicit host simulator, not a claim of actual GUI selection.
            const result=await fetch(ipc+'/v1/commands/result',{method:'POST',headers,
              body:JSON.stringify({source_credential:credentials.source_credential,
                command_id:commands[0].command_id,status:'succeeded'})});
            assert.equal(result.status,200);await result.arrayBuffer();
          }else if(frame.payload.status==='succeeded'){
            if(statuses.filter(status=>status==='succeeded').length===1){
              send({v:1,type:'action.query',payload:{action_id:'usb-action-one'}});
            }else{done=true;resolve()}
          }
        }
      }catch(error){reject(error)}
    });
  });
  send({url:`wss://127.0.0.1:${service.server.address().port}/v1/device`,
    credential:credentials.device_credential,ca_pem:read('tls-cert.pem'),server_name:'agentpet.local',
    device_id:credentials.device_id,view_epoch:'usb-policy-test',public_mode:false});
  try{await received}finally{clearTimeout(timer);lines.close()}
  assert.deepEqual(completed,[1]);
  assert.deepEqual(statuses,['accepted','succeeded','succeeded']);
  assert.equal(dispatched,1,'Status queries must not dispatch the action again');
  assert.equal(store.data.devices[0].mode,'private');
});
