export function useColor(args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (args.includes('--no-color')) return false;
  if (args.includes('--color')) return true;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  return !env.NO_COLOR;
}

export const animationRates = Object.freeze([20, 30, 60] as const);
export const resolveAnimationFps = (value: unknown): number =>
  typeof value === 'number' && (animationRates as readonly number[]).includes(value) ? value : 20;

export const visualOpacities = Object.freeze([20, 35, 50, 65, 80] as const);
export const resolveVisualOpacity = (value: unknown): number =>
  typeof value === 'number' && (visualOpacities as readonly number[]).includes(value) ? value : 35;
