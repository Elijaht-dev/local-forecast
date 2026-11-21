export interface Hass {
  states: Record<string, { state: string; attributes: Record<string, unknown> }>;
  callWS<T>(command: Record<string, unknown>): Promise<T>;
  language?: string;
  themes?: { darkMode?: boolean };
}

export interface Input {
  kind: "history" | "weather" | "solar" | "attribute";
  entity: string;
  history_entity: string;
  entry_id: string;
  attribute: string;
  field: string;
  timestamp_key: string;
  value_key: string;
}

export interface Settings {
  name: string;
  target: string;
  model: string;
  step_minutes: number;
  horizon_hours: number;
  history_days: number;
  refresh_minutes: number;
  mode: "auto" | "measurement" | "counter";
  solar: boolean;
  enabled: boolean;
  inputs: Input[];
}

export const initialSettings = (): Settings => ({
  name: "", target: "", model: "timestral-5m", step_minutes: 60, horizon_hours: 48,
  history_days: 28, refresh_minutes: 60, mode: "auto", solar: false, enabled: false, inputs: [],
});

export interface Point {
  start: number;
  value: number | null;
  p10?: number | null;
  p90?: number | null;
}

interface Coverage {
  available: number;
  requested: number;
}

export interface Preview {
  actual: Point[];
  unit: string;
  timezone: string;
  step_minutes: number;
  cutoff: number;
  coverage: Coverage;
  inputs: { name: string; kind: Input["kind"]; history: number; future: number }[];
  warnings: string[];
  quarter_hour_available?: boolean;
}

export interface Forecast extends Omit<Preview, "inputs" | "warnings" | "quarter_hour_available"> {
  model: string;
  revision: string;
  issued_at: number;
  points: Point[];
}

export interface Model {
  id: string;
  label: string;
  installed: boolean;
  baseline: boolean;
  repo?: string;
  license?: string;
  download_mb?: number;
}

export interface Project {
  id: string;
  engine_entry_id: string;
  entity_id: string | null;
  settings: Settings;
  status: string;
  forecast: Forecast | null;
  error: string | null;
  warnings: string[];
}

export interface Named { id: string; name: string }

export interface LabList {
  engines: Named[];
  projects: Project[];
  solar_entries: Named[];
}

export interface Scores {
  count: number;
  mae: number | null;
  wape: number | null;
  coverage: number | null;
}

export interface Evaluation {
  unit: string;
  folds: number;
  archived_input_folds: number;
  common_count: number;
  variants: (Scores & {
    model: string; use_inputs: boolean; runtime_seconds: number; peak_rss_mb: number; error: string | null;
  })[];
}

export interface Job<T> {
  id?: string;
  state: string;
  result?: T;
  error?: string;
  message?: string;
  preview?: Preview;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}

export function entityName(hass: Hass | undefined, id: string): string {
  const name = hass?.states[id]?.attributes.friendly_name;
  return typeof name === "string" && name.trim() ? name : id;
}

export function entityChoice(hass: Hass | undefined, id: string) {
  const name = entityName(hass, id);
  return { id, name, detail: name === id ? undefined : id };
}

export function entityChoices(hass: Hass | undefined, kind: "target" | "history" | "weather" | "attribute") {
  return Object.entries(hass?.states ?? {}).filter(([id, { state, attributes }]) => {
    if (attributes.forecast_status !== undefined) return false;
    if (kind === "weather") return id.startsWith("weather.");
    if (kind === "attribute") return true;
    const binary = id.startsWith("binary_sensor.");
    if (kind === "target" && binary) return false;
    if (state === "unknown" || state === "unavailable") return id.startsWith("sensor.") || binary;
    return (state.trim() !== "" && Number.isFinite(Number(state))) ||
      (kind === "history" && (state === "on" || state === "off"));
  }).map(([id]) => entityChoice(hass, id));
}
