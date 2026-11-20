import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { Socks5ProxyAgent } from 'undici';
import { Transport } from '../src/runtime/transport.js';
import { BASE } from '../src/core/model.js';

test('原生 fetch 经本地 SOCKS5 握手发送目标域名，代理拒绝后不会直连',async()=>{
  const sockets=new Set<Socket>();let target:{host:string;port:number;type:number}|undefined;
  const server=createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let phase=0,pending=Buffer.alloc(0);
    socket.on('data',chunk=>{
      pending=Buffer.concat([pending,chunk]);
      if(phase===0){
        if(pending.length<2||pending.length<2+pending[1]!)return;
        pending=pending.subarray(2+pending[1]!);phase=1;socket.write(Buffer.from([5,0]));
      }
      if(phase===1&&pending.length>=5){
        const type=pending[3]!,hostLength=type===3?pending[4]!:type===1?4:16,offset=type===3?5:4;
        if(pending.length<offset+hostLength+2)return;
        target={type,host:pending.subarray(offset,offset+hostLength).toString('utf8'),port:pending.readUInt16BE(offset+hostLength)};
        phase=2;socket.end(Buffer.from([5,5,0,1,0,0,0,0,0,0]));
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const transport=new Transport(`socks5://127.0.0.1:${address.port}`),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(input,init)=>{
    calls++;assert.ok((init as RequestInit&{dispatcher?:unknown}).dispatcher instanceof Socks5ProxyAgent);
    return original(input,init);
  };
  try{
    await assert.rejects(transport.fetch(BASE+'api/l/v7/sportlist'),/连接失败/);
    assert.equal(calls,1);assert.deepEqual(target,{type:3,host:new URL(BASE).hostname,port:443});
  }finally{
    globalThis.fetch=original;for(const socket of sockets)socket.destroy();await transport.close();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
