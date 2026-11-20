import { CANVAS } from '../render/chroma.js';
import type { Scene } from './scene.js';

export function sceneRows(scene: Scene): string[] {
  return [...scene.header, ...scene.body, ...scene.form, ...scene.separator, ...scene.footer];
}

/** Absolute row writes avoid bottom-row newlines and preserve unchanged rows. */
export class TerminalCanvas {
  private previous: string[] = [];
  private width = 0;
  private height = 0;
  private dirty = true;
  invalidate() { this.dirty = true; }
  paint(scene: Scene, color: boolean): string | undefined {
    const full = this.dirty || this.width !== scene.width || this.height !== scene.height;
    const background = color ? CANVAS : '\x1b[0m';
    const rows = sceneRows(scene).slice(0, scene.height);
    let output = full ? background + '\x1b[2J' : '';
    for (let y = 0; y < scene.height; y++) {
      const row = rows[y] ?? '';
      if (full || row !== this.previous[y]) output += `\x1b[${y + 1};1H${row}${background}\x1b[K`;
    }
    this.width = scene.width;
    this.height = scene.height;
    this.dirty = false;
    this.previous = rows;
    return output ? output + '\x1b[0m' : undefined;
  }
}
