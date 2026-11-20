import type { RunRecord,TrackPoint } from './types.js';
import { UserError,type OneShotTargets } from '../core/model.js';

export const FIT_TIME_CHANGE=.15;
export const FIT_DISTANCE_CHANGE=.15;
export function validateTargets(target:OneShotTargets){
  if(target.distanceKm!==undefined&&(!Number.isFinite(target.distanceKm)||target.distanceKm<3||target.distanceKm>100))throw new UserError('距离需为 3–100 km，实际范围受同路线样本限制。');
  if(target.distanceKm!==undefined&&Math.abs(target.distanceKm*100-Math.round(target.distanceKm*100))>1e-7)throw new UserError('目标距离最多两位小数。');
  if(target.durationSec!==undefined&&(!Number.isInteger(target.durationSec)||target.durationSec<120||target.durationSec>7200))throw new UserError('时长需为 2–120 分钟，支持精确到秒。');
}
export function parseDistance(value:string):number|undefined{
  if(!value.trim())return undefined;
  if(!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))throw new UserError('距离用 km，最多两位小数。');
  const distanceKm=Number(value);validateTargets({distanceKm});return distanceKm;
}
export function parseDuration(value:string):number|undefined{
  const text=value.trim();if(!text)return undefined;
  let durationSec:number;
  if(/^\d+(?:\.\d+)?$/.test(text))durationSec=Math.round(Number(text)*60);
  else{
    const match=/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(text);
    if(!match||Number(match[2])>=60||Number(match[3])>=60)throw new UserError('时长用分钟数或 MM:SS / HH:MM:SS。');
    durationSec=Number(match[1]??0)*3600+Number(match[2])*60+Number(match[3]);
  }
  validateTargets({durationSec});return durationSec;
}
export function durationText(seconds:number){
  const n=Math.round(seconds);return`${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
}
const paceText=(seconds:number)=>{const n=Math.round(seconds);return`${String(Math.floor(n/60)).padStart(2,'0')}'${String(n%60).padStart(2,'0')}''`;};
export function coordinateWindow(run:RunRecord):number{
  const positive=run.points.filter(p=>(p.timestampMs??0)>0);
  return positive.length>1?(positive.at(-1)!.timestampMs!-positive[0]!.timestampMs!)/1000:0;
}

/** Trim a source prefix; never extend the route, add laps, or enlarge its coordinates. */
export function fitRun(run:RunRecord,target:OneShotTargets,originalDistanceKm:number){
  validateTargets(target);
  let points=run.points.map(p=>({...p}));
  if(points.length<200||points[0]!.timestampMs!==0)throw new UserError('样本缺少初始化点或有效点不足。');
  if(points.some((p,i)=>!Number.isFinite(p.distanceTotalM)||p.distanceTotalM!<0||!Number.isFinite(p.stepDelta??0)||(p.stepDelta??0)<0||
    i>0&&(!Number.isFinite(p.timestampMs)||p.timestampMs!<=0||p.distanceTotalM!<points[i-1]!.distanceTotalM!||
      i>1&&p.timestampMs!<points[i-1]!.timestampMs!)))throw new UserError('样本的时间或累计距离不单调，不能自定义拟合。');
  const total=points.at(-1)!.distanceTotalM!,endM=target.distanceKm===undefined?total:target.distanceKm*1000;
  if(endM>total+.001)throw new UserError('样本距离不足，不能外推或添加圈数。');
  if(Math.abs(endM/(originalDistanceKm*1000)-1)>FIT_DISTANCE_CHANGE+1e-9)throw new UserError('目标距离相对来源变化超过 15%。');
  if(endM<total){
    const index=points.findIndex(p=>p.distanceTotalM!>=endM),a=points[index-1]!,b=points[index]!;
    const fraction=(endM-a.distanceTotalM!)/(b.distanceTotalM!-a.distanceTotalM!);
    const interpolate=(key:keyof TrackPoint)=>Number(a[key])+(Number(b[key])-Number(a[key]))*fraction;
    const end:TrackPoint={...b,latGcj02:interpolate('latGcj02'),lngGcj02:interpolate('lngGcj02'),
      timestampMs:Math.max(a.timestampMs!+1,Math.round(interpolate('timestampMs'))),distanceTotalM:endM,distanceDeltaM:endM-a.distanceTotalM!,
      stepDelta:Math.round((b.stepDelta??0)*fraction),stepTotal:0};
    points=[...points.slice(0,index),end];
  }
  const cropped={...run,points},sourceWindowSec=coordinateWindow(cropped),durationSec=target.durationSec??Math.round(sourceWindowSec);
  const factor=durationSec/sourceWindowSec;
  if(!Number.isFinite(factor)||sourceWindowSec<=0||Math.abs(factor-1)>FIT_TIME_CHANGE+1e-9)throw new UserError('目标时长相对截取后的样本调整超过 15%。');
  if(points.length<200)throw new UserError('截取后有效点不足 200 个。');
  const first=points.find(p=>p.timestampMs!>0)!.timestampMs!;let steps=0;
  points=points.map((p,i)=>{
    const st=i===0?0:Math.max(0,Math.round(p.stepDelta??0));steps+=st;
    const timestampMs=i===0?0:Math.round(first+(p.timestampMs!-first)*factor),distanceDeltaM=i===0?0:p.distanceTotalM!-points[i-1]!.distanceTotalM!;
    const dt=i===1?2000*factor:i>1?timestampMs-Math.round(first+(points[i-1]!.timestampMs!-first)*factor):0;
    return{...p,timestampMs,stepDelta:st,stepTotal:steps,speedKmh:dt>0?distanceDeltaM/dt*3600:0,distanceDeltaM};
  });
  const timed=points.slice(1),offset=(p:TrackPoint)=>(p.timestampMs!-first)/1000;
  const timeAt=(metres:number)=>{
    const i=timed.findIndex(p=>p.distanceTotalM!>=metres);if(i<0)return durationSec;
    const b=timed[i]!,a=timed[i-1];if(!a)return 0;
    const ratio=(metres-a.distanceTotalM!)/Math.max(.000001,b.distanceTotalM!-a.distanceTotalM!);
    return offset(a)+(offset(b)-offset(a))*ratio;
  };
  const distanceAt=(seconds:number)=>{
    if(seconds<=0)return 0;if(seconds>=durationSec)return endM;
    const i=timed.findIndex(p=>offset(p)>=seconds),b=timed[i]!,a=timed[i-1];if(!a)return b.distanceTotalM!;
    const ratio=(seconds-offset(a))/Math.max(.000001,offset(b)-offset(a));return a.distanceTotalM!+(b.distanceTotalM!-a.distanceTotalM!)*ratio;
  };
  let previous=0;
  const paceSplits=Array.from({length:Math.floor(endM/1000)},(_,i)=>{
    const boundary=timeAt((i+1)*1000),seconds=boundary-previous;previous=boundary;
    return{km:i+1,pace:paceText(seconds)};
  });
  const minuteSpeeds=Array.from({length:Math.floor(durationSec/60)},(_,i)=>({minute:i+1,speed:Number(((distanceAt((i+1)*60)-distanceAt(i*60))*.06).toFixed(2))}));
  const distanceKm=Number((endM/1000).toFixed(2));
  const fitted:RunRecord={...run,points,durationSec,distanceKm,totalSteps:steps,avgSpeedKmh:Number((distanceKm*3600/durationSec).toFixed(2)),
    avgPace:paceText(durationSec/distanceKm),stepMinute:Number((steps*60/durationSec).toFixed(2)),paceSplits,minuteSpeeds};
  return{run:fitted,sourceWindowSec,timeScale:factor,lastOdometerTime:durationText(Math.max(1,durationSec-previous))};
}
