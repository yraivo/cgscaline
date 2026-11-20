import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store, unlockStale } from './runtime/storage.js';
import { UserError } from './core/model.js';
import { useColor } from './render/appearance.js';
import { cliLanguage } from './core/i18n.js';
import { connectWorker, runWorker } from './runtime/worker.js';
import { APP_NAME } from './core/brand.js';

async function main() {
  const args = process.argv.slice(2), [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  const forcedLang = cliLanguage(args);
  const en = forcedLang === 'en';
  if (major < 22 || major === 22 && minor < 19 || major >= 26)
    throw new UserError(en ? 'Requires Node.js 22.19+ or 24 LTS.' : '此构建支持 Node 22.19+ / 24；请使用对应 LTS 版本。');
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(en
      ? `${APP_NAME}\n\n  npm start         Launch TUI & connect/spawn daemon\n  npm run demo      Offline synthetic demo (--en for English)\n  npm run preview   Render single ANSI preview frame\n\n  --en / --zh       Switch UI language (or press L on Home)\n  --headless        Start background daemon and exit\n  --status          Print daemon & task queue status\n  --stop            Pause tasks and stop daemon\n  --data-dir PATH   Custom DPAPI vault directory\n  --unlock          Clear stale lock from exited process\n  --color / --no-color\n  --no-motion       Freeze shader backdrop\n`
      : `${APP_NAME}\n\n  npm start         打开界面，连接或启动后台\n  npm run demo      离线演示（附加 --en 切换英文界面）\n  npm run preview   演示界面预览\n\n  --en / --zh       指定界面语言（主页按 L 也可随时切换）\n  --headless        启动后台后返回\n  --status          查看后台与任务状态\n  --stop            暂停任务并停止后台\n  --data-dir PATH   自定义加密档案目录\n  --unlock          检查并释放已退出进程的旧锁\n  --color / --no-color\n  --no-motion       固定装饰画面\n`);
    return;
  }
  const demo = args.includes('--demo'), index = args.indexOf('--data-dir');
  if (index >= 0 && !args[index + 1]) throw new UserError(en ? '--data-dir requires a path.' : '--data-dir 需要路径。');
  const root = index >= 0 ? resolve(args[index + 1]!) : join(process.env.LOCALAPPDATA ?? homedir(), 'CGSPORT', demo ? 'terminal-demo-v2' : 'terminal-v1');
  if (args.includes('--unlock')) { unlockStale(root); process.stdout.write(en ? 'Stale lock check complete.\n' : '旧锁检查完成。\n'); return; }
  const worker = args.includes('--worker'), headless = args.includes('--headless'), status = args.includes('--status'), stop = args.includes('--stop');
  if (!demo && process.platform !== 'win32') throw new UserError(en ? 'Live DPAPI vault requires Windows; use --demo on other platforms.' : '真实档案当前需要 Windows；其他平台可使用 --demo。');
  if (worker) { await runWorker(root, demo, !args.includes('--no-notifications')); return; }
  if (args.includes('--preview') && !demo) throw new UserError(en ? 'Use --demo with --preview.' : '预览请使用 --demo，不输出真实档案。');
  if (demo && !headless && !status && !stop) {
    const [{ Engine }, { demoFetch, seedDemo }] = await Promise.all([import('./runtime/engine.js'), import('./core/demo.js')]);
    const store = new Store(null); await store.open(); const engine = new Engine(store, demoFetch);
    try {
      await seedDemo(store, forcedLang ?? 'zh'); await engine.initialize();
      if (forcedLang) store.state.settings.language = forcedLang;
      if (args.includes('--preview')) {
        const { frame } = await import('./render/theme.js');
        process.stdout.write(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 104, 32, useColor(args), true) + '\n'); await engine.shutdown(); return;
      }
      const { TerminalUI } = await import('./ui/index.js'); const { LocalAppClient } = await import('./app/local-client.js'); await new TerminalUI(new LocalAppClient(engine), true, useColor(args), !args.includes('--no-motion')).run();
    } catch (e) { store.close(); throw e; }
    return;
  }
  if (!headless && !status && !stop && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new UserError(en ? 'Interactive mode requires a TTY; use --headless for daemon.' : '交互模式需要终端；后台运行可用 --headless。');
  const seaMod = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => { isSea?: () => boolean } }).getBuiltinModule?.('node:sea');
  const entryPath = seaMod?.isSea?.() ? process.execPath : fileURLToPath(import.meta.url);
  const engine = await connectWorker(root, { demo, start: !status && !stop, entry: entryPath, notifications: !args.includes('--no-notifications') });
  if (forcedLang && engine.state.settings.language !== forcedLang && !status && !stop) {
    await engine.commands.configureAppearance({ language: forcedLang });
  }
  if (stop) { try { await engine.commands.stopBackground(); process.stdout.write(en ? 'Daemon stopped; waiting tasks paused.\n' : '后台已停止，等待任务已暂停。\n'); } finally { await engine.close(); } return; }
  if (headless || status) {
    const tasks = engine.state.tasks;
    const running = tasks.filter(t => ['starting', 'waiting', 'committing'].includes(t.phase)).length;
    const queued = tasks.filter(t => t.phase === 'queued').length;
    const pending = tasks.filter(t => ['paused', 'review'].includes(t.phase)).length;
    process.stdout.write(en
      ? `${APP_NAME} daemon online · active ${running} · queued ${queued} · pending ${pending}\n`
      : `${APP_NAME} 后台运行中 · 运行 ${running} · 计划 ${queued} · 待处理 ${pending}\n`);
    await engine.close(); return;
  }
  const { TerminalUI } = await import('./ui/index.js'); await new TerminalUI(engine, demo, useColor(args), !args.includes('--no-motion')).run();
}
main().catch(e => {
  process.stderr.write(`${e instanceof UserError ? e.message : `${APP_NAME} 未能启动；请检查安装与加密档案。`}\n`); process.exitCode = 1;
});
