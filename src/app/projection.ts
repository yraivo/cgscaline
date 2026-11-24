import { deviceConflicts } from "../core/device-identity.js";
import { geometryErrors, geometryWarnings } from "../track/geometry.js";
import { extractMinimap } from "../render/minimap.js";
import { identity, type Account, type Prepared, type State, type Task } from "../core/model.js";
import type {
  AccountView,
  AppState,
  PreparedSummary,
  TaskView,
} from "./contracts.js";
export function accountView(a: Account, accounts: readonly Account[] = []): AccountView {
  const { session, recordCache: _recordCache, ...account } = a;
  void _recordCache;
  const view = { ...account, device: { ...a.device, androidId: "" }, profileIdentity: identity(a),
    deviceConflict: !!a.bindingConflict || deviceConflicts(a, accounts).length > 0 };
  if (!session) return structuredClone(view);
  const { token, secret, ...publicSession } = session;
  return structuredClone({ ...view, session: publicSession });
}
export function preparedView(
  p: Prepared,
  mode: "preview" | "history" = "preview",
): PreparedSummary {
  const { sensor, body, preparedSessionId: _sessionId, ...summary } = p;
  const minimap = mode === "preview" ? extractMinimap(body.coordinate) : undefined;
  return structuredClone({
    ...summary,
    kind: "summary",
    body: { odometer: body.odometer, avgPace: body.avgPace },
    coordinateCount: p.coordinateCount ?? body.coordinate?.length ?? 0,
    sensorSampleCount: p.sensorSampleCount ?? sensor.length,
    previewWarnings: p.previewWarnings ?? geometryWarnings(p),
    validationErrors: mode === "history" ? [] : geometryErrors(p),
    ...(minimap ? { minimap } : {}),
  });
}
export function taskView(t: Task): TaskView {
  const { prepared, identity, sessionId, ...task } = t;
  return structuredClone({
    ...task,
    prepared: preparedView(prepared, "history"),
  });
}
export function appState(state: State): AppState {
  const { pendingBindings: _pending, ...view } = state;
  return structuredClone({
    ...view,
    accounts: state.accounts.map(a => accountView(a, state.accounts)),
    tasks: state.tasks.map(taskView),
  });
}
