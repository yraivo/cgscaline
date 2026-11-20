/**
 * Synthetic accelerometer-magnitude series for the existing upload format.
 * The generator combines cadence-based sine, slow drift and Gaussian noise.
 * 10 Hz and six decimals follow the researched recorder format.
 * Its amplitude clamps are model choices, not physical validity thresholds.
 */

export interface SensorGenerateOptions {
  /** sensor 时长（秒），= 轨迹完整窗口（begin→end），一般等于 summary.durationSec */
  durationSec: number;
  /** 步频（步/分钟），来自轨迹 summary.stepMinute，决定模长振荡频率 */
  stepMinute: number;
  /** 输出采样率 Hz（App 实测 10Hz；不要改成其他值） */
  rate?: number;
  /** Legacy option; the current implementation does not read this waveform. */
  seed?: number[];
  /** 随机种子（可复现；省略用固定默认值） */
  rngSeed?: number;
  /** 白噪声幅度（默认 0.08） */
  noise?: number;
}

/** 统计一个序列隐含的步频（Hz）：模长过均值的交叉次数 / 2 / 时长 */
export function estimateCadence(values: number[], rate: number): number {
  if (values.length < 4 || rate <= 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let crossings = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i]! - mean) * (values[i - 1]! - mean) < 0) crossings++;
  }
  return crossings / 2 / (values.length / rate);
}

/** mulberry32 —— 确定性 PRNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller 高斯噪声 */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Generate a synthetic 10 Hz magnitude series; sample count follows duration. */
export function generateSensor(opts: SensorGenerateOptions): number[] {
  const rate = opts.rate ?? 10;
  const rng = mulberry32(opts.rngSeed ?? 20260801);
  const noiseAmp = opts.noise ?? 0.08;
  const durationSec = Math.max(0, opts.durationSec);
  const n = Math.max(2, Math.round(durationSec * rate));

  // Model baseline and amplitude; these are not measured limits for running.
  const G = 9.810013;
  // Oscillation amplitude is tied to the requested average cadence.
  const targetCadence = opts.stepMinute / 60;
  const oscAmp = Math.min(1.5, 0.25 + Math.max(0, targetCadence - 1.0) * 0.5);
  // 慢变漂移（模拟手机握持角度缓慢变化）：±0.3，周期 ~60s
  const driftAmp = 0.3;

  const out = new Array<number>(n);
  let phase = rng() * Math.PI * 2;
  let driftPhase = rng() * Math.PI * 2;

  for (let i = 0; i < n; i++) {
    // 每 ~30s 微调相位（自然变化）
    if (i % (rate * 30) === 0) {
      phase = rng() * Math.PI * 2;
      driftPhase = rng() * Math.PI * 2;
    }
    const tSec = i / rate;
    // 走路步频振荡（sin，步频 = targetCadence Hz → 周期 1/targetCadence s）
    const osc = oscAmp * Math.sin(2 * Math.PI * targetCadence * tSec + phase);
    // 慢漂移
    const drift = driftAmp * Math.sin(2 * Math.PI * tSec / 60 + driftPhase);
    // 白噪声
    const noise = gaussian(rng) * noiseAmp;
    // Preserve the existing generator clamp [8.0, 11.5].
    const raw = G + osc + drift + noise;
    out[i] = round6(Math.min(11.5, Math.max(8.0, raw)));
  }
  return out;
}

/** 输出为 App sensor 文件文本：`[v1,v2,...vn]`（含闭合括号，App 上传格式） */
export function sensorToText(values: number[]): string {
  return "[" + values.join(",") + "]";
}

/** 输出为无闭合括号文本：`[v1,v2,...`（兼容直接提交的 buildSensorZip 补 `]`） */
export function sensorToTextOpen(values: number[]): string {
  return "[" + values.join(",");
}
