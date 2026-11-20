import type { PreviewDraft } from "../app/contracts.js";
import type { MinimapPoint } from "../render/minimap.js";
import type { Prepared, RecordScope } from "../core/model.js";
import type { WorkoutRecord } from "../protocol/records.js";
import type { TaskCheck } from "./task-view.js";
export interface View<P = PreviewDraft> {
  screen:
    | "home"
    | "menu"
    | "account"
    | "manage"
    | "tasks"
    | "executions"
    | "libraries"
    | "settings"
    | "records"
    | "information"
    | "history"
    | "appearance"
    | "fonts"
    | "school"
    | "notices"
    | "oneshot";
  selected: number;
  accountId?: string;
  notice: string;
  busy?: boolean;
  processing?: boolean;
  marked?: string[];
  motion?: number;
  title?: string;
  infoTab?: number;
  history?: WorkoutRecord[];
  historyScope?: RecordScope;
  lines?: string[];
  historyFetchedAt?: number;
  detailRecord?: WorkoutRecord;
  detailMinimap?: MinimapPoint[];
  noticeId?: string;
  taskChecks?: Record<string, TaskCheck>;
  preview?: P;
  advanced?: boolean;
  background?: boolean;
  connected?: boolean;
  motionLocked?: boolean;
  fontQuery?: string;
  appearanceReturnTo?: "home" | "settings";
  returnTo?:
    | "home"
    | "account"
    | "history"
    | "notices"
    | "tasks"
    | "executions"
    | "settings";
  form?: {
    title: string;
    label: string;
    value: string;
    secret?: boolean;
    hint?: string;
  };
}

export type RenderView = View<Prepared | PreviewDraft>;
