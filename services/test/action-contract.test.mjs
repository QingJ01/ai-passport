import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {createService} from '../src/server.mjs';
import {Store} from '../src/security.mjs';

const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const template=readFileSync(join(repo,'tests/fixtures/agent-pet-action-frames.jsonl'),'utf8')
  .trim().split('\n').map(line=>JSON.parse(line));

test('bridged host actions accept the firmware-built frames end to end',{timeout:20000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'agent-pet-action-'));
  const setup=spawnSync(process.execPath,[fileURLToPath(new URL('../src/setup.mjs',import.meta.url)),directory],{encoding:'utf8'});
  assert.equal(setup.status,0,'Fixture setup failed');
  const read=name=>readFileSync(join(directory,name),'utf8');
  const credentials=JSON.parse(read('credentials.json'));
  const store=new Store();store.data=JSON.parse(read('store.json'));
  const service=createService({tls:{key:read('tls-key.pem'),cert:read('tls-cert.pem')},store,
    signingKey:read('signing-key.pem'),adapterToken:credentials.adapter_token});
  t.after(async()=>{
    await service.close();
    const absolute=realpathSync(directory),temporary=realpathSync(tmpdir());
    assert.equal(dirname(absolute),temporary,'Refuse unexpected fixture cleanup parent');
    assert(basename(absolute).startsWith('agent-pet-action-'),'Refuse unexpected fixture cleanup name');
    rmSync(absolute,{recursive:true});
  });
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  await new Promise(r=>service.ipc.listen(0,'127.0.0.1',r));
  const ipc=`http://127.0.0.1:${service.ipc.address().port}`;
  const headers={authorization:`Bearer ${credentials.adapter_token}`,'content-type':'application/json'};
  const event={source_id:credentials.source_id,session_id:'selected-session',run_id:'contract-turn',
    revision:1762300000123,title:'Contract task',entity_kind:'turn',execution_state:'running',
    pending_interactions:[],capabilities:{open_on_host:true}};
  const ingest=await fetch(ipc+'/v1/events',{method:'POST',headers,
    body:JSON.stringify({source_credential:credentials.source_credential,event})});
  assert.equal(ingest.status,200);await ingest.arrayBuffer();
  const device=new WebSocket(`wss://127.0.0.1:${service.server.address().port}/v1/device`,
    {ca:read('tls-cert.pem'),servername:'agentpet.local',rejectUnauthorized:true});
  t.after(()=>device.terminate());

  const statuses=[],seen=[];
  let target,offerResolve;
  const offer=new Promise(r=>{offerResolve=r});
  await new Promise((ready,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Bridge contract flow stalled')),8000);
    device.on('open',()=>{
      device.send(JSON.stringify({v:1,type:'hello',payload:{device_id:credentials.device_id,versions:[1],
        view_epoch:'fixture-epoch',public_mode:false}}));
      device.send(JSON.stringify({v:1,type:'auth',payload:{credential:credentials.device_credential}}));
    });
    device.on('error',reject);
    device.on('message',async data=>{
      let frame;try{frame=JSON.parse(data.toString())}catch{return}
      seen.push(frame.type);
      try{
        if(frame.type==='snapshot.page'&&frame.payload.tasks?.length&&!target){
          target=frame.payload.tasks[0].id;
          assert.equal(frame.payload.tasks[0].state_revision,1762300000123);
          assert.deepEqual(frame.payload.tasks[0].available_actions,['open_on_host']);
          const prepare=structuredClone(template[0]);
          prepare.view_epoch='fixture-epoch';prepare.payload.target_id=target;
          device.send(JSON.stringify(prepare));
        }else if(frame.type==='action.offer'){
          assert.equal(frame.payload.type,'open_on_host');
          assert.equal(frame.payload.target_id,target);
          assert.equal(frame.payload.target_revision,1762300000123);
          assert.equal(typeof frame.payload.token,'string');
          offerResolve(frame.payload);
          const execute=structuredClone(template[1]);
          execute.view_epoch='fixture-epoch';execute.payload.target_id=target;
          execute.payload.token=frame.payload.token;
          execute.payload.target_revision=frame.payload.target_revision;
          device.send(JSON.stringify(execute));
        }else if(frame.type==='action.result'&&frame.payload.action_id===template[1].payload.action_id){
          statuses.push(frame.payload.status);
          if(frame.payload.status==='accepted'){
            const pending=await fetch(ipc+'/v1/commands',{headers:{...headers,'X-Source-Credential':credentials.source_credential}});
            const {commands}=await pending.json();assert.equal(commands.length,1);
            const done=await fetch(ipc+'/v1/commands/result',{method:'POST',headers,
              body:JSON.stringify({source_credential:credentials.source_credential,
                command_id:commands[0].command_id,status:'succeeded'})});
            assert.equal(done.status,200);await done.arrayBuffer();
          }else if(frame.payload.status==='succeeded'){
            const query=structuredClone(template[2]);
            query.view_epoch='fixture-epoch';query.payload.action_id=template[1].payload.action_id;
            device.send(JSON.stringify(query));
            clearTimeout(timer);ready();
          }
        }
      }catch(error){clearTimeout(timer);reject(error)}
    });
  });
  await offer;
  assert.deepEqual(statuses,['accepted','succeeded']);
  assert(seen.includes('welcome')&&seen.includes('snapshot.begin')&&seen.includes('action.offer'),
    'the device saw a real welcome, snapshot and offer');
});
