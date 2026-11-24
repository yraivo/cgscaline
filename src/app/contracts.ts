import type { DevicePreset } from "../core/device-profiles.js";
import type { AccountInformation, RecordDetail } from "../campus/information.js";
import type { MinimapPoint } from "../render/minimap.js";
import type {
  Account,
  ColorTheme,
  Compatibility,
  Device,
  Language,
  Library,
  LogoFont,
  OneShotTargets,
  Prepared,
  RecordScope,
  Session,
  State,
  Task,
  VisualStyle,
} from "../core/model.js";
import type { ExportBackupResult, ImportBackupResult } from "../runtime/portable-backup.js";
import type { WorkoutRecord } from "../protocol/records.js";
import type { SchoolDirectoryEntry } from "../campus/school-directory.js";

export type AccountView = Readonly<Omit<Account, "session" | "recordCache">> & {
  readonly profileIdentity?: string;
  readonly deviceConflict?: boolean;
  readonly session?: Readonly<Omit<Session, "token" | "secret">>;
};
export interface PreparedSummary
  extends Omit<
    Prepared,
    "body" | "sensor" | "preparedSessionId" | "sensorSampleCount" | "previewWarnings"
  > {
  kind: "summary";
  body: Readonly<Pick<Prepared["body"], "odometer" | "avgPace">>;
  coordinateCount: number;
  sensorSampleCount: number;
  previewWarnings: string[];
  validationErrors: string[];
  minimap?: MinimapPoint[];
}
export interface PreviewDraft extends PreparedSummary {
  draftId: string;
}
export type TaskView = Readonly<
  Omit<Task, "prepared" | "identity" | "sessionId">
> & {
  readonly prepared: PreparedSummary;
};
export type AppState = Readonly<
  Omit<State, "pendingBindings" | "accounts" | "tasks" | "settings" | "libraries">
> & {
  readonly accounts: readonly AccountView[];
  readonly tasks: readonly TaskView[];
  readonly libraries: readonly Library[];
  readonly settings: Readonly<State["settings"]>;
};
export type PrepareOptions = OneShotTargets & {
  avoidRunId?: number;
  avoidSeed?: number;
  seed?: number;
  runId?: number;
};
export type AppearanceChange = {
  colorTheme?: ColorTheme;
  logoFont?: LogoFont;
  visualStyle?: VisualStyle;
  visualOpacity?: number;
  gradientSpeed?: number;
  animationFps?: number;
  motion?: boolean;
  privacyMode?: boolean;
  language?: Language;
};
export type AccountChange = Partial<
  Pick<
    Account,
    | "label"
    | "libraryId"
    | "device"
    | "proxy"
    | "routeId"
    | "sourceMode"
    | "school"
  >
>;
export interface PhoneCandidateSummary {
  libraryId: string;
  username: string;
  serverUrl: string;
  schoolId?: string;
  model: string;
  displayAndroidId: string;
  hasDevice: boolean;
  hasSession: boolean;
  matchedAccountId?: string;
  sameDevice?: boolean;
  accountUsed?: boolean;
}
export interface AppCommands {
  listSchools(): Promise<SchoolDirectoryEntry[]>;
  addAccount(
    label: string,
    username: string,
    school: string | SchoolDirectoryEntry,
    preset?: DevicePreset | "auto",
  ): Promise<AccountView>;
  inspectDevice(id: string): Promise<{ device: Device; registered?: Device; revision?: number; conflict: boolean }>;
  acceptRegisteredDevice(id: string, revision: number): Promise<void>;
  inspectPhoneCandidate(libraryId: string): Promise<PhoneCandidateSummary | undefined>;
  adoptPhoneCandidate(accountId: string, libraryId: string, restoreSession?: boolean): Promise<{ deviceChanged: boolean; sessionRestored: boolean }>;
  stagePhoneCandidate(libraryId: string): Promise<void>;
  configure(id: string, change: AccountChange): Promise<void>;
  configureAppearance(change: AppearanceChange): Promise<void>;
  setColorTheme(theme: ColorTheme): Promise<void>;
  configureSettings(change: {
    maxConcurrent?: number;
    notifications?: boolean;
    termTarget?: number;
  }): Promise<void>;
  configureSchool(school: string | SchoolDirectoryEntry, proxy?: string): Promise<void>;
  check(id: string): Promise<Compatibility>;
  checkSchool(): Promise<void>;
  ensureCompatible(id: string): Promise<void>;
  login(id: string, password: string): Promise<void>;
  assertSession(id: string): Promise<void>;
  clearSession(id: string): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  records(id: string, scope?: RecordScope): Promise<WorkoutRecord[]>;
  /** Cache only; sportId optionally includes an already cached detail. */
  loadCachedRecords(
    id: string,
    sportId?: string,
    scope?: RecordScope,
  ): Promise<{ fetchedAt: number; records: WorkoutRecord[]; detail?: RecordDetail } | undefined>;
  information(id: string, refresh?: boolean): Promise<AccountInformation>;
  schoolInformation(id: string, refresh?: boolean): Promise<AccountInformation>;
  schoolNotices(id: string, refresh?: boolean): Promise<AccountInformation>;
  noticeDetail(id: string, noticeId: string, refresh?: boolean): Promise<string[]>;
  recordDetail(
    id: string,
    sportId: string,
    refresh?: boolean,
  ): Promise<RecordDetail>;
  importLibrary(
    file: string,
    label: string,
    scope: "private" | "public",
    owner?: string,
  ): Promise<Library>;
  importLibraryFromPhone(
    label: string,
    scope: "private" | "public",
    owner?: string,
  ): Promise<Library & { sourceHint: string }>;
  deleteLibrary(id: string): Promise<void>;
  exportBackup(
    filePath: string,
    passphrase: string,
    includeSessions?: boolean,
  ): Promise<ExportBackupResult>;
  importBackup(
    filePath: string,
    passphrase: string,
  ): Promise<ImportBackupResult>;
  prepareDefault(id: string, options?: PrepareOptions): Promise<PreviewDraft>;
  prepare(
    id: string,
    libraryId: string,
    options?: PrepareOptions,
  ): Promise<PreviewDraft>;
  start(id: string, draft: PreviewDraft): Promise<TaskView>;
  queuePrepared(
    id: string,
    draft: PreviewDraft,
    when: number,
  ): Promise<TaskView>;
  queuePlan(
    ids: string[],
    first: number,
    stagger: number,
    options?: PrepareOptions,
  ): Promise<TaskView[]>;
  resume(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  fastForwardDemo(id: string): Promise<void>;
  reconcileTask(id: string, refresh?: boolean): Promise<Task["audit"]>;
  stopBackground(): Promise<void>;
}
export interface AppClient {
  readonly state: AppState;
  readonly notices: readonly string[];
  readonly background: boolean;
  readonly connected: boolean;
  readonly commands: AppCommands;
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}
export const commandNames = [
  "listSchools",
  "addAccount",
  "configure",
  "inspectDevice",
  "acceptRegisteredDevice",
  "inspectPhoneCandidate",
  "adoptPhoneCandidate",
  "stagePhoneCandidate",
  "configureAppearance",
  "setColorTheme",
  "configureSettings",
  "configureSchool",
  "check",
  "checkSchool",
  "ensureCompatible",
  "login",
  "assertSession",
  "clearSession",
  "deleteAccount",
  "records",
  "loadCachedRecords",
  "information",
  "schoolInformation",
  "schoolNotices",
  "noticeDetail",
  "recordDetail",
  "importLibrary",
  "importLibraryFromPhone",
  "deleteLibrary",
  "exportBackup",
  "importBackup",
  "prepareDefault",
  "prepare",
  "start",
  "queuePrepared",
  "queuePlan",
  "resume",
  "pause",
  "archive",
  "fastForwardDemo",
  "reconcileTask",
  "stopBackground",
] as const satisfies readonly (keyof AppCommands)[];
type MissingCommands = Exclude<
  keyof AppCommands,
  (typeof commandNames)[number]
>;
const complete: MissingCommands extends never ? true : never = true;
void complete;
