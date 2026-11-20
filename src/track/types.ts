export type GcjCoord = [number, number];

export type TrackPoint = {
  id: number;
  latGcj02: number | null;
  lngGcj02: number | null;
  timestampMs: number | null;
  accuracyM: number | null;
  distanceDeltaM: number | null;
  distanceTotalM: number | null;
  speedKmh: number | null;
  stepDelta: number | null;
  stepTotal: number | null;
  validFlag: number | null;
  usable: boolean;
};

export type RunRecord = {
  id: number;
  sportId: string;
  routeId: string | null;
  routeName: string | null;
  startDate: string | null;
  endDate: string | null;
  distanceKm: number | null;
  durationSec: number | null;
  totalSteps: number | null;
  avgSpeedKmh: number | null;
  avgPace: string | null;
  stepMinute: number | null;
  statusEvidence: Record<string, number | string | null>;
  points: TrackPoint[];
  paceSplits: Array<Record<string, unknown>>;
  minuteSpeeds: Array<Record<string, unknown>>;
};

export type RouteConfig = {
  routeId: string;
  name: string | null;
  boundaryGcj02: GcjCoord[];
  polylineGcj02: GcjCoord[];
  minSpeedKmh: number | null;
  maxSpeedKmh: number | null;
  minDurationSec: number | null;
  maxDurationSec: number | null;
  targetDistanceKm: number | null;
  checkpointCount: number | null;
  minDistanceOfRunway: number | null;
  tips: string | null;
  unresolvedRules: string[];
};

export type Dataset = {
  schemaVersion: number;
  coordinateSystem: string;
  generatedAt: string;
  source: {
    database: string;
    databaseSha256: string;
    selectionSql: string;
    runCount: number;
  };
  runs: RunRecord[];
  routes: RouteConfig[];
};

export type FitMetrics = {
  selectedPointCount: number;
  residualMedianM: number;
  residualP95M: number;
  inBoundaryRatio: number | null;
  estimatedTurns: number;
  direction: "clockwise" | "counterclockwise" | "mixed";
};

export type RouteTemplate = {
  id: string;
  source: "manual" | "fitted";
  selectedRunIds: number[];
  routeId: string | null;
  closed: boolean;
  coordinatesGcj02: GcjCoord[];
  lengthM: number;
  direction: "clockwise" | "counterclockwise" | "mixed";
  fitMetrics: FitMetrics;
  synthetic: true;
};

export type SyntheticPoint = {
  latGcj02: number;
  lngGcj02: number;
  /** Milliseconds since the generated activity began. */
  offsetMs?: number;
  /** Absolute epoch milliseconds when timeline.mode is "absolute"; otherwise the relative offset. */
  timestampMs: number;
  accuracyM: number;
  distanceDeltaM: number;
  distanceTotalM: number;
  speedKmh: number;
  stepDelta: number;
  stepTotal: number;
  validFlag: 1;
};

export type SyntheticTimeline = {
  mode: "relative" | "absolute";
  timezone: "Asia/Shanghai";
  startTimestampMs: number | null;
  endTimestampMs: number | null;
  startTimeLocal: string | null;
  endTimeLocal: string | null;
  durationSec: number;
};

export type SyntheticTrack = {
  schemaVersion: 1 | 2;
  synthetic: true;
  seed: number;
  templateId: string;
  generatedAt: string;
  coordinateSystem: "GCJ-02";
  /** Missing only on legacy schemaVersion 1 records kept in localStorage. */
  timeline?: SyntheticTimeline;
  target: { distanceM: number; durationSec: number; steps: number };
  summary: {
    distanceM: number;
    durationSec: number;
    steps: number;
    avgSpeedKmh: number;
    paceSecPerKm: number;
    stepMinute: number;
    lapCount: number;
    speedStdKmh: number;
    lapGeometrySpreadM: number;
  };
  points: SyntheticPoint[];
  series: {
    minuteSpeeds: Array<{ minute: number; speedKmh: number }>;
    paceSplits: Array<{ km: number; durationSec: number; paceSecPerKm: number }>;
  };
  provenance: {
    selectedRunIds: number[];
    source: "local-only";
    parameters: {
      requestedDistanceM: number;
      distanceJitterM: number;
      sampleIntervalMs: number;
      cadenceSpm: number;
      speedVariationPct: number;
      lapVariationPct: number;
      lateralNoiseM: number;
    };
  };
};

export type ValidationReport = {
  passed: boolean;
  hardFailures: string[];
  warnings: string[];
  geometryScore: number;
  physicalScore: number;
  statisticalScore: number;
  metrics: Record<string, number | string | null>;
  comparedRunIds: number[];
};
