import type { AppState } from '../app/contracts.js';
import { resolveLanguage, tr } from '../core/i18n.js';
import { cachedInformation, detailLines } from './information-view.js';
import { durationText, parseDistance, parseDuration } from '../track/fit.js';
import type { UIController } from './controller.js';
import type { RenderView } from './view.js';

type Command = 'start' | 'schedule' | 'regenerate' | 'advanced' | 'distance' | 'duration' | 'automatic'
  | 'refresh-history' | 'toggle-scope' | 'open-detail' | 'refresh-detail';
export interface WorkoutAction {
  command: Command | 'move' | 'back';
  keys: readonly string[];
  hint?: string;
}

/** Only these three pages share this definition; other pages keep their own controls. */
export function workoutPageActions(view: RenderView, state: AppState): WorkoutAction[] | undefined {
  if (!['oneshot', 'history', 'records'].includes(view.screen)) return undefined;
  if (view.form || view.busy) return [];
  const lang = resolveLanguage(state.settings.language);
  const account = state.accounts.find(a => a.id === view.accountId);
  const actions: WorkoutAction[] = [];
  if (view.screen === 'oneshot') {
    if (view.preview && account) actions.push(
      { command: 'start', keys: ['return'], hint: tr(lang, 'Enter 开始', 'Enter Start') },
      { command: 'schedule', keys: ['p'], hint: tr(lang, 'P 定时', 'P Schedule') },
      { command: 'regenerate', keys: ['r'], hint: tr(lang, 'R 换一版', 'R Reroll') },
      { command: 'advanced', keys: ['a'], hint: view.advanced ? tr(lang, 'A 收起', 'A Collapse') : tr(lang, 'A 高级', 'A Tuning') },
      { command: 'distance', keys: ['d'], hint: view.advanced ? tr(lang, 'D 距离', 'D Dist') : undefined },
      { command: 'duration', keys: ['t'], hint: view.advanced ? tr(lang, 'T 时长', 'T Time') : undefined },
      { command: 'automatic', keys: ['0'], hint: view.advanced ? tr(lang, '0 自动', '0 Auto') : undefined },
    );
  } else {
    const canRefresh = account?.session && account.session.status !== 'invalid'
      && !state.tasks.some(t => t.accountId === account.id && ['starting', 'waiting', 'committing'].includes(t.phase));
    if (view.screen === 'history') {
      if (account && view.history?.[view.selected]?.sportId)
        actions.push({ command: 'open-detail', keys: ['return'], hint: tr(lang, 'Enter 详情', 'Enter Detail') });
      if (canRefresh) actions.push({ command: 'refresh-history', keys: ['r'], hint: tr(lang, 'R 刷新', 'R Refresh') });
      if (account) actions.push({
        command: 'toggle-scope',
        keys: ['tab'],
        hint: view.historyScope === 'archive' ? tr(lang, 'Tab 本学期', 'Tab Current') : tr(lang, 'Tab 往期', 'Tab Archive'),
      });
    } else if (canRefresh && (view.detailRecord?.sportId || view.noticeId)) {
      actions.push({ command: 'refresh-detail', keys: ['r'], hint: tr(lang, 'R 刷新', 'R Refresh') });
    }
  }
  const hasRows = view.screen === 'oneshot' ? !!view.preview
    : view.screen === 'history' ? !!view.history?.length : !!view.lines?.length;
  if (hasRows) actions.push({
    command: 'move',
    keys: ['up', 'down', 'pageup', 'pagedown', 'home', 'end'],
    hint: view.screen === 'history' ? tr(lang, '↑↓ / PgUp PgDn 选择', '↑↓ / PgUp PgDn Select') : tr(lang, '↑↓ / PgUp PgDn 滚动', '↑↓ / PgUp PgDn Scroll'),
  });
  actions.push({ command: 'back', keys: ['escape'], hint: tr(lang, 'Esc 返回', 'Esc Back') });
  return actions;
}

export class WorkoutPages {
  constructor(private ui: UIController) {}
  async run(command: Command) {
    const { view, shots } = this.ui;
    const lang = resolveLanguage(this.ui.app.state.settings.language);
    switch (command) {
      case 'start': return shots.startPreview();
      case 'schedule': return shots.schedulePreview();
      case 'regenerate': return shots.refreshOneShot();
      case 'advanced': view.advanced = !view.advanced; return;
      case 'automatic': return shots.refreshOneShot({});
      case 'distance': {
        const current = view.preview?.targets ?? {};
        const distanceKm = parseDistance(await this.ui.ask(
          tr(lang, '目标距离', 'TARGET DISTANCE'),
          tr(lang, '距离（km），留空自动', 'Distance in km (blank for auto)'),
          current.distanceKm?.toFixed(2) ?? '',
        ));
        return shots.refreshOneShot({ ...current, distanceKm });
      }
      case 'duration': {
        const current = view.preview?.targets ?? {};
        const durationSec = parseDuration(await this.ui.ask(
          tr(lang, '目标时长', 'TARGET DURATION'),
          tr(lang, '时长（分钟或 MM:SS），留空自动', 'Duration in min or MM:SS (blank for auto)'),
          current.durationSec === undefined ? '' : durationText(current.durationSec),
        ));
        return shots.refreshOneShot({ ...current, durationSec });
      }
      case 'refresh-history': {
        const id = this.ui.current().id;
        const isArchive = view.historyScope === 'archive';
        const history = isArchive
          ? await this.ui.app.commands.records(id, 'archive')
          : await this.ui.app.commands.records(id);
        const cache = isArchive
          ? await this.ui.app.commands.loadCachedRecords(id, undefined, 'archive')
          : await this.ui.app.commands.loadCachedRecords(id);
        view.history = history;
        view.historyFetchedAt = cache?.fetchedAt;
        view.selected = Math.min(view.selected, Math.max(0, history.length - 1));
        return;
      }
      case 'toggle-scope': {
        const id = this.ui.current().id;
        const next = view.historyScope === 'archive' ? 'current' : 'archive';
        const cache = next === 'archive'
          ? await this.ui.app.commands.loadCachedRecords(id, undefined, 'archive')
          : await this.ui.app.commands.loadCachedRecords(id);
        view.historyScope = next;
        view.history = cache?.records;
        view.historyFetchedAt = cache?.fetchedAt;
        view.selected = 0;
        view.notice = '';
        return;
      }
      case 'open-detail': {
        const record = view.history![view.selected]!;
        const account = this.ui.current();
        const cache = view.historyScope === 'archive'
          ? await this.ui.app.commands.loadCachedRecords(account.id, record.sportId, 'archive')
          : await this.ui.app.commands.loadCachedRecords(account.id, record.sportId);
        this.ui.navigate('records');
        view.title = tr(lang, '运动详情', 'WORKOUT DETAIL');
        view.returnTo = 'history';
        view.detailRecord = record;
        view.detailMinimap = cache?.detail?.minimap;
        view.lines = detailLines(record, cache?.detail, cachedInformation(account)?.reasons.data, lang);
        return;
      }
      case 'refresh-detail': {
        const account = this.ui.current();
        if (view.noticeId) {
          view.lines = await this.ui.app.commands.noticeDetail(account.id, view.noticeId, true);
          return;
        }
        const record = view.detailRecord!;
        const detail = await this.ui.app.commands.recordDetail(account.id, record.sportId, true);
        view.detailMinimap = detail.minimap;
        view.lines = detailLines(record, detail, cachedInformation(account)?.reasons.data, lang);
      }
    }
  }
}
