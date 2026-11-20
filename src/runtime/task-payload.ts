import {createHash} from 'node:crypto';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {geometryWarnings} from '../track/geometry.js';
import type {Prepared} from '../core/model.js';
const compress=promisify(gzip),decompress=promisify(gunzip);
const uuid=/^[a-f0-9-]{36}$/;
export interface TaskPayloadRef {version:1;sha256:string}
export function payloadName(taskId:string,ref:TaskPayloadRef){
  if(!uuid.test(taskId)||ref?.version!==1||!/^[a-f0-9]{64}$/.test(ref.sha256))throw new Error('Invalid task payload reference');
  return `task-${taskId}-${ref.sha256}.dpapi`;
}
export function freezePrepared<T>(value:T):T{
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freezePrepared(child);Object.freeze(value);
  }return value;
}
export function preparedSummary(p:Prepared):Prepared{
  return freezePrepared(structuredClone({...p,sensor:[],body:{...p.body,coordinate:[]},
    coordinateCount:p.coordinateCount??p.body.coordinate?.length??0,sensorSampleCount:p.sensorSampleCount??p.sensor.length,previewWarnings:p.previewWarnings??geometryWarnings(p)}));
}
export function encodePayload(taskId:string,accountId:string,prepared:Prepared){
  const bytes=Buffer.from(JSON.stringify({format:'cgscaline-task-v1',taskId,accountId,prepared}));
  if(bytes.length>80_000_000)throw new Error('Task payload too large');
  return{bytes,ref:{version:1 as const,sha256:createHash('sha256').update(bytes).digest('hex')}};
}
export const compressPayload=(bytes:Buffer)=>compress(bytes);
export async function decodePayload(bytes:Buffer,taskId:string,accountId:string,ref:TaskPayloadRef):Promise<Prepared>{
  const plain=await decompress(bytes,{maxOutputLength:80_000_000});
  if(createHash('sha256').update(plain).digest('hex')!==ref.sha256)throw new Error('Task payload checksum mismatch');
  const value=JSON.parse(plain.toString('utf8'));
  if(value.format!=='cgscaline-task-v1'||value.taskId!==taskId||value.accountId!==accountId||
    !value.prepared?.body||!Array.isArray(value.prepared.sensor)||!Array.isArray(value.prepared.body.coordinate))throw new Error('Invalid task payload');
  return freezePrepared(value.prepared as Prepared);
}
