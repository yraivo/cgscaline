import type { AppCommands, AppState } from "./contracts.js";
export type Invoke = <K extends keyof AppCommands>(
  method: K,
  args: Parameters<AppCommands[K]>,
) => ReturnType<AppCommands[K]>;
/** One checked transport boundary; application code uses named, typed commands. */
export function commandsFor(invoke: Invoke): AppCommands {
  return {
    listSchools: (...args) => invoke("listSchools", args),
    addAccount: (...args) => invoke("addAccount", args),
    configure: (...args) => invoke("configure", args),
    regenerateDevice: (...args) => invoke("regenerateDevice", args),
    configureAppearance: (...args) => invoke("configureAppearance", args),
    setColorTheme: (...args) => invoke("setColorTheme", args),
    configureSettings: (...args) => invoke("configureSettings", args),
    configureSchool: (...args) => invoke("configureSchool", args),
    check: (...args) => invoke("check", args),
    checkSchool: (...args) => invoke("checkSchool", args),
    ensureCompatible: (...args) => invoke("ensureCompatible", args),
    login: (...args) => invoke("login", args),
    assertSession: (...args) => invoke("assertSession", args),
    clearSession: (...args) => invoke("clearSession", args),
    deleteAccount: (...args) => invoke("deleteAccount", args),
    records: (...args) => invoke("records", args),
    loadCachedRecords: (...args) => invoke("loadCachedRecords", args),
    information: (...args) => invoke("information", args),
    schoolInformation: (...args) => invoke("schoolInformation", args),
    schoolNotices: (...args) => invoke("schoolNotices", args),
    noticeDetail: (...args) => invoke("noticeDetail", args),
    recordDetail: (...args) => invoke("recordDetail", args),
    importLibrary: (...args) => invoke("importLibrary", args),
    importLibraryFromPhone: (...args) => invoke("importLibraryFromPhone", args),
    deleteLibrary: (...args) => invoke("deleteLibrary", args),
    exportBackup: (...args) => invoke("exportBackup", args),
    importBackup: (...args) => invoke("importBackup", args),
    prepareDefault: (...args) => invoke("prepareDefault", args),
    prepare: (...args) => invoke("prepare", args),
    start: (...args) => invoke("start", args),
    queuePrepared: (...args) => invoke("queuePrepared", args),
    queuePlan: (...args) => invoke("queuePlan", args),
    resume: (...args) => invoke("resume", args),
    pause: (...args) => invoke("pause", args),
    archive: (...args) => invoke("archive", args),
    fastForwardDemo: (...args) => invoke("fastForwardDemo", args),
    reconcileTask: (...args) => invoke("reconcileTask", args),
    stopBackground: (...args) => invoke("stopBackground", args),
  };
}
export class ClientState {
  state: AppState = {
    schemaVersion: 1,
    accounts: [],
    tasks: [],
    libraries: [],
    settings: { maxConcurrent: 2 },
  };
  notices: string[] = [];
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  changed() {
    for (const listener of this.listeners) listener();
  }
}
