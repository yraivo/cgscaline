/** Offline experiment. Donors are recorded 10 Hz magnitude arrays from one chosen library.
 * Keeps contiguous blocks instead of constructing a cadence sine. Not used by submissions.
 */
import {mulberry32} from '../protocol/sensor.js';
export interface SensorDonor {id:string;values:readonly number[]}
export function generateSensorExperiment(donors:readonly SensorDonor[],durationSec:number,seed:number,method:'recorded-blocks-v1'|'recorded-blocks-v2'='recorded-blocks-v1'){
  if(!Number.isFinite(durationSec)||durationSec<.2||durationSec>7200||!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new Error('Invalid duration or seed');
  if(!donors.length||donors.some(d=>!d.id||d.values.length<100||d.values.some(v=>!Number.isFinite(v)||v<0)))throw new Error('Invalid recorded donors');
  const rng=mulberry32(seed),count=Math.round(durationSec*10),values:number[]=[],blocks:Array<{donorId:string;sourceStart:number;targetStart:number;length:number;overlap:number}>=[];
  while(values.length<count){
    const sample=()=>{
      const donor=donors[Math.floor(rng()*donors.length)]!,length=Math.min(donor.values.length,100+Math.floor(rng()*201));
      return{donor,length,sourceStart:Math.floor(rng()*(donor.values.length-length+1))};
    };
    let selected=sample();const overlap=Math.min(10,values.length),targetStart=values.length-overlap;
    if(method==='recorded-blocks-v2'&&overlap){
      const tail=values.slice(-overlap),mean=tail.reduce((a,b)=>a+b,0)/overlap;
      const energy=tail.reduce((a,b)=>a+(b-mean)**2,0)/overlap;
      const score=(candidate:ReturnType<typeof sample>)=>{
        let mismatch=0,otherMean=0,otherEnergy=0;
        for(let i=0;i<overlap;i++){const v=candidate.donor.values[candidate.sourceStart+i]!;otherMean+=v;mismatch+=(v-tail[i]!)**2;}
        otherMean/=overlap;
        for(let i=0;i<overlap;i++)otherEnergy+=(candidate.donor.values[candidate.sourceStart+i]!-otherMean)**2/overlap;
        // Compare phase and local amplitude; no hard-coded acceleration range.
        return mismatch/(energy+otherEnergy+.01)+Math.abs(Math.log((otherEnergy+.01)/(energy+.01)))*.25;
      };
      let best=score(selected);for(let i=1;i<8;i++){const candidate=sample(),cost=score(candidate);if(cost<best){selected=candidate;best=cost;}}
    }
    const {donor,length,sourceStart}=selected;
    for(let i=0;i<length&&targetStart+i<count;i++){
      const index=targetStart+i,sample=donor.values[sourceStart+i]!;
      const weight=method==='recorded-blocks-v2'?(1-Math.cos(Math.PI*(i+1)/(overlap+1)))/2:(i+1)/(overlap+1);
      values[index]=Number((i<overlap?values[index]!*(1-weight)+sample*weight:sample).toFixed(6));
    }
    blocks.push({donorId:donor.id,sourceStart,targetStart,length:values.length-targetStart,overlap});
  }
  return{values,blocks,rate:10 as const,method};
}
/** Duration agreement is a screening heuristic, never proof of a shared time origin.
 * Default tolerance is max(2s, 1% of GPS window); callers can supply a stricter bound.
 */
export function assessSensorTimeline(sampleCount:number,gpsDurationSec:number|undefined,toleranceSec?:number){
  if(!Number.isSafeInteger(sampleCount)||sampleCount<2)throw new Error('Invalid sample count');
  if(toleranceSec!==undefined&&(!Number.isFinite(toleranceSec)||toleranceSec<0))throw new Error('Invalid tolerance');
  if(gpsDurationSec===undefined||!Number.isFinite(gpsDurationSec)||gpsDurationSec<=0)return{status:'unknown' as const};
  const deltaSec=sampleCount/10-gpsDurationSec,tolerance=toleranceSec??Math.max(2,gpsDurationSec*.01);
  return{status:Math.abs(deltaSec)<=tolerance?'duration-compatible' as const:'mismatch' as const,deltaSec,toleranceSec:tolerance};
}
export function sensorSeams(values:readonly number[],blocks:readonly {targetStart:number;overlap:number}[]){
  const joins=blocks.slice(1).flatMap(b=>[b.targetStart,b.targetStart+b.overlap]).filter(i=>i>0&&i<values.length);
  const deltas=joins.map(i=>Math.abs(values[i]!-values[i-1]!)).sort((a,b)=>a-b);
  return{joinCount:joins.length,meanDelta:deltas.length?deltas.reduce((a,b)=>a+b,0)/deltas.length:0,p95Delta:deltas[Math.floor((deltas.length-1)*.95)]??0};
}
export function sensorMetrics(values:readonly number[]){
  if(values.length<2||values.some(v=>!Number.isFinite(v)))throw new Error('Invalid samples');
  const sorted=[...values].sort((a,b)=>a-b),mean=values.reduce((s,v)=>s+v,0)/values.length;
  const variance=values.reduce((s,v)=>s+(v-mean)**2,0)/values.length;
  let lag=0,jump=0;for(let i=1;i<values.length;i++){lag+=(values[i]!-mean)*(values[i-1]!-mean);jump+=Math.abs(values[i]!-values[i-1]!);}
  return{count:values.length,mean,std:Math.sqrt(variance),p01:sorted[Math.floor((sorted.length-1)*.01)]!,p99:sorted[Math.floor((sorted.length-1)*.99)]!,
    lag1:variance?lag/(values.length*variance):0,meanAbsoluteDelta:jump/(values.length-1)};
}
