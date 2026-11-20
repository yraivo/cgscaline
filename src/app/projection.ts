import { geometryErrors, geometryWarnings } from "../track/geometry.js";
import { extractMinimap } from "../render/minimap.js";
import type { Account, Prepared, State, Task } from "../core/model.js";
import type {
  AccountView,
  AppState,
  PreparedSummary,
  TaskView,
} from "./contracts.js";
export function accountView(a: Account): AccountView {
  const { session, recordCache: _recordCache, ...account } = a;
  void _recordCache;
  if (!session) return structuredClone(account);
  const { token, secret, ...publicSession } = session;
  return structuredClone({ ...account, session: publicSession });
}
export function preparedView(
  p: Prepared,
  mode: "preview" | "history" = "preview",
): PreparedSummary {
  const { sensor, body, ...summary } = p;
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
  return structuredClone({
    ...state,
    accounts: state.accounts.map(accountView),
    tasks: state.tasks.map(taskView),
  });
}
