import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/runtime/storage.js";
import { seedDemo } from "../src/core/demo.js";
import { appState } from "../src/app/projection.js";
import { TerminalCanvas, sceneRows } from "../src/ui/canvas.js";
import { buildScene } from "../src/ui/scene.js";
import { frame, cells, stripAnsi } from "../src/render/theme.js";
import { dye, gradient, gradientLine, paletteColor } from "../src/render/chroma.js";
import type { Scene } from "../src/ui/scene.js";

test("只输出变化的行，缩小视口清理残留，不写底部换行或清除滚动历史", () => {
  const canvas = new TerminalCanvas();
  const scene: Scene = {width: 10, height: 3, header: [], body: ["abc", "def", "ghi"], form: [], separator: [], footer: []};
  assert.ok(canvas.paint(scene, false)?.includes("\x1b[2J"));
  assert.equal(canvas.paint(scene, false), undefined);
  const changed = canvas.paint({...scene, body: ["abc", "new", "ghi"]}, false)!;
  assert.ok(changed.includes("\x1b[2;1Hnew"));
  assert.equal(changed.includes("\x1b[1;1H"), false);
  assert.equal(changed.includes("\x1b[3;1H"), false);
  const resized = canvas.paint({...scene, height: 2}, false)!;
  assert.ok(resized.includes("\x1b[2J"));
  assert.equal(resized.includes("\x1b[3;1H"), false);
  assert.equal(resized.includes("\x1b[3J"), false);
  assert.equal(resized.includes("\n"), false);
});

test("渐变压缩保持可见字形、字符颜色及后续文字颜色", () => {
  const visible = (text: string) => {
    let color = "";
    return [...text.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m|([^\x1b])/gu)].flatMap(m => {
      if (m[1]) { color = m[1]; return []; }
      return m[2] === " " ? [] : [[m[2], color]];
    });
  };
  for (const theme of ["spectrum", "astolfo"] as const) {
    const text = "CGSCALINE 中文 👟", motion = 5;
    assert.equal(stripAnsi(gradient(text, motion, true, theme)), text);
    const old = [...text].map((c, i) => dye(c, paletteColor(theme, i * .017 + motion * .035), true)).join("");
    assert.deepEqual(visible(gradient(text, motion, true, theme) + "tail"), visible(old + "tail"));
    const width = 144;
    const oldLine = Array.from({length: width}, (_, x) => dye("─", paletteColor(theme, x / (width - 1) * .8 + motion * .025), true)).join("");
    const line = gradientLine(width, motion, true, theme);
    assert.deepEqual(visible(line + "tail"), visible(oldLine + "tail"));
    assert.ok(line.length < oldLine.length * .6);
  }
});
test("终端与离线预览使用相同页面内容；中文、emoji 与背景在不同尺寸内不越界", async () => {
  const store = new Store(null);
  await seedDemo(store);
  store.state.accounts[0]!.label = "测试 é👟";
  Object.assign(store.state.settings, {
    visualStyle: "spiral",
    logoFont: "figlet:The Edge",
  });
  for (const [width, height] of [
    [40, 16],
    [118, 38],
    [144, 40],
    [232, 62],
  ]) {
    const view = {
      screen: "home" as const,
      selected: 1,
      notice: "",
      motion: 5,
    };
    const scene = buildScene(
          appState(store.state),
          view,
          width!,
          height!,
          true,
          true,
        );
    const canvas = new TerminalCanvas();
    assert.ok(canvas.paint(scene, true)?.includes("\x1b[2J"));
    assert.equal(canvas.paint(scene, true), undefined);
    const rows = sceneRows(scene).map(stripAnsi);
    assert.equal(rows.length, height);
    assert.ok(rows.every((r) => cells(r) <= width!));
    assert.deepEqual(
      rows.map((r) => r.trimEnd()),
      stripAnsi(frame(store.state, view, width!, height!, true, true))
        .split("\n")
        .map((r) => r.trimEnd()),
    );
  }
});
