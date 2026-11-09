import { LitElement, css, html, nothing } from "lit";
import { controls } from "./styles";
import { initialSettings, numericEntities, type Hass, type Input, type Model, type Named, type Settings } from "./types";

const inputLabels: Record<Input["kind"], string> = {
  history: "Recorded entity", weather: "HA weather forecast", solar: "Forecast.Solar", attribute: "Forecast array attribute",
};

export class ProjectSettings extends LitElement {
  static properties = {
    project: {}, hass: {}, models: {}, engines: {}, engineId: {}, solarEntries: {},
    busy: {}, saved: {}, quarterHourAvailable: {},
  };
  static styles = [controls, css`
    :host { display: block; }
    form { padding: 16px 18px; display: grid; gap: 13px; }
    h2 { margin-bottom: 2px; }
    .pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .input { padding: 10px; margin: 10px 0; border: 1px solid var(--lf-border); border-radius: 7px; display: grid; gap: 8px; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .small { min-height: 30px; font-size: 12px; }
    details { padding-top: 12px; border-top: 1px solid var(--lf-border); }
    .actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
    .save { width: 100%; margin-top: 3px; }
  `];

  project: Settings = initialSettings();
  hass?: Hass;
  models: Model[] = [];
  engines: Named[] = [];
  engineId = "";
  solarEntries: Named[] = [];
  busy = false;
  saved = false;
  quarterHourAvailable?: boolean;

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.emit("project-change", { ...this.project, [key]: value });
  }

  private updateInput(index: number, patch: Partial<Input>): void {
    this.updateSetting("inputs", this.project.inputs.map((item, i) => i === index ? { ...item, ...patch } : item));
  }

  private field(label: string, value: string, change: (value: string) => void, list?: string, required = false) {
    return html`<label>${label}<input .value=${value} list=${list ?? nothing} ?required=${required}
      @input=${(event: Event) => change((event.target as HTMLInputElement).value)}></label>`;
  }

  private options(label: string, value: string, choices: readonly (readonly [string, string])[], change: (value: string) => void) {
    return html`<label>${label}<select .value=${value} @change=${(event: Event) => change((event.target as HTMLSelectElement).value)}>
      ${choices.map(([id, name]) => html`<option value=${id} ?selected=${id === value}>${name}</option>`)}
    </select></label>`;
  }

  private count(label: string, key: "horizon_hours" | "history_days" | "refresh_minutes", min: number, max: number) {
    return html`<label>${label}<input type="number" min=${min} max=${max} required
      .value=${String(this.project[key])} @change=${(event: Event) =>
        this.updateSetting(key, (event.target as HTMLInputElement).valueAsNumber)}></label>`;
  }

  private inputRow(item: Input, index: number) {
    const patch = (values: Partial<Input>) => this.updateInput(index, values);
    const kindChoices = Object.entries(inputLabels);
    const label = item.kind === "solar" ? "Forecast.Solar entry" : item.kind === "weather" ? "Weather source" : "Entity";
    return html`<section class="input">
      <div class="head"><strong>Input ${index + 1}</strong>
        <button type="button" class="small" aria-label=${`Remove input ${index + 1}`}
          @click=${() => this.updateSetting("inputs", this.project.inputs.filter((_, i) => i !== index))}>Remove</button>
      </div>
      ${this.options("Source", item.kind, kindChoices, (kind) => patch({
        kind: kind as Input["kind"], entity: "", field: kind === "solar" ? "watts" : "temperature",
      }))}
      ${item.kind === "solar" ?
        this.options(label, item.entry_id, [["", "Select an entry"], ...this.solarEntries.map(e => [e.id, e.name] as const)],
          entry_id => patch({ entry_id })) :
        this.field(label, item.entity, entity => patch({ entity }), item.kind === "weather" ? "weather" : "inputs", true)}
      ${item.kind === "weather" ? this.options("Forecast field", item.field, [
        ["temperature", "Temperature"], ["cloud_coverage", "Cloud coverage"], ["humidity", "Humidity"],
        ["precipitation", "Precipitation"], ["precipitation_probability", "Precipitation probability"],
        ["wind_speed", "Wind speed"], ["pressure", "Pressure"], ["uv_index", "UV index"],
      ], field => patch({ field })) : nothing}
      ${item.kind === "solar" ? this.options("Forecast field", item.field, [["watts", "Power (W)"], ["wh_period", "Energy (Wh)"]],
        field => patch({ field })) : nothing}
      ${item.kind === "attribute" ? html`
        ${this.field("Array attribute", item.attribute, attribute => patch({ attribute }), undefined, true)}
        <div class="pair">
          ${this.field("Timestamp key", item.timestamp_key, timestamp_key => patch({ timestamp_key }), undefined, true)}
          ${this.field("Value key", item.value_key, value_key => patch({ value_key }), undefined, true)}
        </div>` : nothing}
      ${item.kind !== "history" ? html`
        ${this.field("Historical counterpart", item.history_entity, history_entity => patch({ history_entity }), "inputs")}
        <small>${item.kind === "weather" ? "Uses the recorded weather attribute if empty." : "Choose a recorded entity in matching units."}</small>
      ` : nothing}
    </section>`;
  }

  render() {
    const project = this.project;
    const entities = numericEntities(this.hass, true);
    const intervals: [string, string][] = [["60", "1 hour"]];
    if (this.quarterHourAvailable || project.step_minutes === 15) intervals.push(["15", "15 minutes"]);
    const models: [string, string][] = this.models.map(model => [model.id, model.label]);
    if (!models.some(([id]) => id === project.model)) models.unshift([project.model, project.model]);
    const addInput = () => this.updateSetting("inputs", [...project.inputs, {
      kind: "history", entity: "", history_entity: "", entry_id: "", attribute: "", field: "temperature",
      timestamp_key: "datetime", value_key: "value",
    }]);
    return html`<form class="box" @submit=${(event: Event) => { event.preventDefault(); this.emit("save-project"); }}>
      <h2>Project settings</h2>
      ${!this.saved && this.engines.length > 1 ? this.options("Engine", this.engineId,
        this.engines.map(e => [e.id, e.name]), id => this.emit("engine-change", id)) : nothing}
      ${this.field("Name", project.name, name => this.updateSetting("name", name), undefined, true)}
      ${this.field("Target entity", project.target, target => this.updateSetting("target", target), "targets", true)}
      ${this.options("Model", project.model, models, model => this.updateSetting("model", model))}
      <div class="pair">
        ${this.options("Interval", String(project.step_minutes), intervals,
          step => this.updateSetting("step_minutes", Number(step)))}
        ${this.count("Horizon (hours)", "horizon_hours", 1, 168)}
        ${this.count("History (days)", "history_days", 1, 90)}
        ${this.count("Refresh (minutes)", "refresh_minutes", 15, 1440)}
      </div>
      ${project.target && project.step_minutes === 60 && !this.quarterHourAvailable
        ? html`<small>${this.quarterHourAvailable === false
          ? "Recorder has too few 15-minute observations for this target."
          : "Preview history to check if 15-minute intervals are available."}</small>` : nothing}
      <details ?open=${project.inputs.length > 0 || project.solar}>
        <summary>Inputs and solar</summary>
        ${project.inputs.map((input, index) => this.inputRow(input, index))}
        <button type="button" class="small" ?disabled=${this.busy || project.inputs.length >= 8}
          @click=${addInput}>Add input</button>
        <div style="margin-top: 12px">
          ${this.options("Target type", project.mode, [
            ["auto", "Automatic"], ["measurement", "Measurement"], ["counter", "Cumulative counter"],
          ], mode => this.updateSetting("mode", mode as Settings["mode"]))}
        </div>
        <label class="check" style="margin-top: 12px"><input type="checkbox" .checked=${project.solar}
          @change=${(event: Event) => this.updateSetting("solar", (event.target as HTMLInputElement).checked)}>
          Solar forecast for the Energy dashboard
        </label>
      </details>
      <button class="save primary" type="submit" ?disabled=${this.busy || !this.engineId}>Save project</button>
      <div class="actions">
        <button type="button" ?disabled=${this.busy || !project.target} @click=${() => this.emit("preview-project")}>Preview history</button>
        ${this.saved ? html`<button type="button" ?disabled=${this.busy} @click=${() => this.emit("delete-project")}>Delete project</button>` : nothing}
      </div>
      <datalist id="targets">${numericEntities(this.hass).map(id => html`<option value=${id}></option>`)}</datalist>
      <datalist id="inputs">${entities.map(id => html`<option value=${id}></option>`)}</datalist>
      <datalist id="weather">${Object.keys(this.hass?.states ?? {}).filter(id => id.startsWith("weather.")).map(id => html`<option value=${id}></option>`)}</datalist>
    </form>`;
  }
}

customElements.define("local-forecast-settings", ProjectSettings);
