import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { UserError, type State } from '../core/model.js';
import type {AppState} from '../app/contracts.js';

export const WORKER_BUILD_REV = '2026.11-r13';
export interface WorkerAddress { version:1; pid:number; pipe:string; key:string; demo:boolean; startedAt:number; rev?:string }
export interface Snapshot { revision:number; state:State|AppState; notices:string[];viewVersion?:2 }
type Message = Record<string,any>;
export const proof=(key:string,text:string)=>createHmac('sha256',key).update(text).digest('hex');
export function verified(a:unknown,b:string){
  if(typeof a!=='string'||!/^[a-f0-9]{64}$/.test(a))return false;
  return timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
export function send(socket:Socket,message:Message){
  if(socket.destroyed)return;
  const line=JSON.stringify(message)+'\n';
  if(Buffer.byteLength(line)>16_000_000||socket.writableLength>16_000_000){socket.destroy();return;}
  socket.write(line);
}
export function receive(socket:Socket,limit:number,handler:(value:Message)=>void){
  let pending='';socket.setEncoding('utf8');
  socket.on('data',(chunk:string)=>{
    pending+=chunk;
    if(Buffer.byteLength(pending)>limit){socket.destroy();return;}
    let i:number;
    while((i=pending.indexOf('\n'))>=0){
      const line=pending.slice(0,i);pending=pending.slice(i+1);
      try{const value=JSON.parse(line);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();handler(value);}
      catch{socket.destroy();return;}
    }
  });
}
export class WorkerChannel {
  private sequence=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private constructor(readonly socket:Socket,readonly address:WorkerAddress,private update:(snapshot:Snapshot)=>void){}
  static connect(address:WorkerAddress,update:(snapshot:Snapshot)=>void):Promise<WorkerChannel>{
    return new Promise((resolve,reject)=>{
      const socket=createConnection(address.pipe),channel=new WorkerChannel(socket,address,update);
      let authenticated=false,challenged=false,clientNonce='',serverNonce='';
      const timer=setTimeout(()=>{socket.destroy();reject(new UserError('后台连接超时。'));},6000);
      socket.on('error',()=>{});
      socket.on('close',()=>{
        clearTimeout(timer);
        if(!authenticated)reject(new UserError('无法连接或验证后台。'));
        for(const p of channel.pending.values()){clearTimeout(p.timer);p.reject(new UserError('后台已断开，请重新打开。'));}
        channel.pending.clear();
      });
      receive(socket,16_000_000,message=>{
        if(!authenticated){
          if(message.type==='challenge'&&!challenged&&typeof message.nonce==='string'&&message.nonce.length===64&&
            verified(message.proof,proof(address.key,'server:'+message.nonce))){
            challenged=true;clientNonce=randomBytes(32).toString('hex');serverNonce=message.nonce;
            send(socket,{type:'auth',nonce:clientNonce,proof:proof(address.key,'client:'+serverNonce+':'+clientNonce)});return;
          }
          if(challenged&&message.type==='ready'&&message.snapshot&&verified(message.proof,proof(address.key,'ready:'+serverNonce+':'+clientNonce))){authenticated=true;clearTimeout(timer);update(message.snapshot);resolve(channel);return;}
          socket.destroy();return;
        }
        if(message.snapshot)update(message.snapshot);
        if(message.type==='reply'){
          const p=channel.pending.get(message.id);if(!p)return;
          clearTimeout(p.timer);channel.pending.delete(message.id);
          if(message.error)p.reject(new UserError(String(message.error)));else p.resolve(message.value);
        }
      });
    });
  }
  call<T=any>(method:string,args:unknown[]=[]):Promise<T>{
    if(this.socket.destroyed)return Promise.reject(new UserError('后台已断开，请重新启动界面。'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id);reject(new UserError('后台响应超时，请重新打开查看任务。'));
        this.socket.destroy();
      },120_000);
      this.pending.set(id,{resolve,reject,timer});send(this.socket,{type:'call',id,method,args});
    });
  }
  close(){this.socket.end();}
}
