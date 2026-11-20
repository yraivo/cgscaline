// Offline ANSI preview adapter; shares Scene with the interactive renderer.
import { appState } from "../app/projection.js";
import type { State } from "../core/model.js";
import { buildScene } from "../ui/scene.js";
import type { RenderView } from "../ui/view.js";
export * from "../ui/actions.js";
export * from "../ui/text.js";
export type { View } from "../ui/view.js";
export function frame(
  state: State,
  view: RenderView,
  width = 104,
  height = 34,
  color = true,
  demo = false,
) {
  const s = buildScene(appState(state), view, width, height, color, demo);
  return (
    [...s.header, ...s.body, ...s.form, ...s.separator, ...s.footer].join(
      "\n",
    ) + (color ? "\x1b[0m" : "")
  );
}
