// Child transport for agent_pet_device.py. Secrets arrive over stdin, never argv.
// The first line is host configuration; subsequent lines are bounded device
// commands. This process never accepts a second credential or authentication.
import {createRequire} from 'node:module';
const require=createRequire(new URL('../services/package.json',import.meta.url));
const WebSocket=require('ws');
const business=new Set(['snapshot.begin','snapshot.page','snapshot.end','state.delta','heartbeat']);
const responses=new Set(['action.offer','action.result']);
const commands=new Set(['action.prepare','action','action.query','resync']);
const epoch=/^[A-Za-z0-9:._-]{1,64}$/;
let input='',config,socket,started=false,welcomed=false,policyReady=false,closed=false;
const timeout=setTimeout(()=>fail('Bridge configuration timeout',2),5000);

function close(code=0){
  if(closed)return;
  closed=true;clearTimeout(timeout);
  socket?.terminate();process.stdin.destroy();
  process.stdout.end(()=>process.exit(code));
  setTimeout(()=>process.exit(code),1000).unref();
}
function fail(message,code=3){process.stderr.write(message+'\n');close(code)}
function send(command){
  if(socket?.readyState!==WebSocket.OPEN)return;
  if(socket.bufferedAmount+Buffer.byteLength(JSON.stringify(command))>65536){
    fail('Bridge command queue exceeded its bound');return;
  }
  socket.send(JSON.stringify(command));
}
function configureView(viewEpoch,publicMode){
  config.view_epoch=viewEpoch;config.public_mode=publicMode;policyReady=false;
  send({v:1,type:'view.configure',payload:{mode:publicMode?'public':'private',view_epoch:viewEpoch}});
}
function acceptConfiguration(line){
  try{
    config=JSON.parse(line);
    const url=new URL(config.url);
    if(url.protocol!=='wss:'||url.username||url['pass'+'word']||url.search||url.hash||
       typeof config.credential!=='string'||config.credential.length<32||
       typeof config.view_epoch!=='string'||!epoch.test(config.view_epoch))throw Error();
    socket=new WebSocket(url,{ca:config.ca_pem,servername:config.server_name||url.hostname,
      rejectUnauthorized:true,handshakeTimeout:5000,perMessageDeflate:false,maxPayload:4096});
  }catch{fail('Invalid bridge configuration',2);return}
  socket.on('open',()=>{
    send({v:1,type:'hello',payload:{device_id:config.device_id,versions:[1],
      view_epoch:config.view_epoch,public_mode:config.public_mode===true}});
    send({v:1,type:'auth',payload:{credential:config.credential}});
    config.credential='';
  });
  socket.on('message',(data,binary)=>{
    if(binary||data.length>4096)return;
    let frame;try{frame=JSON.parse(data.toString())}catch{return}
    if(frame.v!==1||frame.view_epoch!==config.view_epoch)return;
    if(frame.type==='welcome'&&!welcomed){
      welcomed=true;
      // HELLO only forces public mode. Explicit authenticated configuration
      // also restores private mode when the host retained an older policy.
      configureView(config.view_epoch,config.public_mode===true);
      return;
    }
    if(frame.type==='view.ready'&&welcomed){
      if(frame.payload?.mode!==(config.public_mode?'public':'private')){
        fail('Bridge privacy acknowledgment mismatch');return;
      }
      policyReady=true;return;
    }
    // Never expose the initial projection made under a previous host policy.
    if(!policyReady||(!business.has(frame.type)&&!responses.has(frame.type)))return;
    if(!process.stdout.write(JSON.stringify(frame)+'\n'))socket.pause();
  });
  process.stdout.on('drain',()=>socket?.resume());
  socket.on('error',()=>fail('TLS bridge connection failed'));
  socket.on('close',code=>{if(!closed)close(code===1000?0:3)});
}
function acceptCommand(line){
  let command;try{command=JSON.parse(line)}catch{return}
  if(command.v!==1||!welcomed||!command.payload||typeof command.payload!=='object'||Array.isArray(command.payload))return;
  if(command.type==='view.configure'){
    const {mode,view_epoch:viewEpoch}=command.payload;
    if(!['public','private'].includes(mode)||typeof viewEpoch!=='string'||!epoch.test(viewEpoch))return;
    configureView(viewEpoch,mode==='public');
  }else if(policyReady&&commands.has(command.type))send(command);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  if(closed)return;
  input+=chunk;
  while(input.includes('\n')){
    const end=input.indexOf('\n'),line=input.slice(0,end);input=input.slice(end+1);
    if(Buffer.byteLength(line)>(started?4096:16384)){fail('Bridge input exceeded its bound',2);return}
    if(!started){started=true;clearTimeout(timeout);acceptConfiguration(line)}
    else acceptCommand(line);
    if(closed)return;
  }
  if(Buffer.byteLength(input)>(started?4096:16384))fail('Bridge input exceeded its bound',2);
});
process.on('SIGTERM',()=>close(0));
