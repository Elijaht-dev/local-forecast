import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import "./chart";
import "./settings";
import { modelOptions } from "./model-options";
import { controls } from "./styles";
import {
  entityName, errorMessage, initialSettings, type Evaluation, type Forecast, type Hass, type Job, type LabList,
  type Model, type Preview, type Project, type Scores, type Settings,
} from "./types";

const statuses: Record<string, string> = {
  paused: "Paused", waiting: "Waiting for forecast", ready: "Published", stale: "Stale", expired: "Expired",
  error: "Needs attention", running: "Running",
};
const resultStates = new Set(["succeeded", "cancelled", "failed"]);

export class ForecastLab extends LitElement {
  static properties = {
    hass: {}, narrow: {}, listing: { state: true }, models: { state: true },
    selection: { state: true }, draft: { state: true }, engineId: { state: true },
    preview: { state: true }, forecast: { state: true }, evaluation: { state: true },
    accuracy: { state: true }, modelId: { state: true }, error: { state: true },
    busy: { state: true }, job: { state: true }, notice: { state: true }, loaded: { state: true },
    quarterHourAvailable: { state: true },
  };

  static styles = [controls, css`
    :host { display: block; min-height: 100%; background: var(--primary-background-color, #f4f7fa); }
    header { display: flex; align-items: center; min-height: 56px; gap: 14px; padding: 10px 20px; background: var(--lf-surface); border-bottom: 1px solid var(--lf-border); }
    h1 { font-size: 24px; letter-spacing: -0.02em; }
    .projects { display: flex; flex-wrap: wrap; align-items: start; gap: 10px 16px; padding: 12px 20px 14px; border-bottom: 1px solid var(--lf-border); }
    .projects local-forecast-picker { flex: 1 1 220px; max-width: 36rem; }
    .projects button { margin-top: 20px; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 9px; }
    main { padding: 16px 18px 28px; display: grid; gap: 20px; grid-template-columns: minmax(0, 2.13fr) minmax(295px, 1fr); align-items: start; }
    .workspace { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .project-title { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .project-title h2 { font-size: 25px; overflow-wrap: anywhere; }
    .status { color: var(--lf-muted); padding: 3px 8px; background: color-mix(in srgb, var(--lf-muted) 13%, var(--lf-surface)); border-radius: 14px; font-size: 12px; }
    .status.stale, .status.expired { color: var(--warning-color, #9d5d00); }
    .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
    .box { min-width: 0; padding: 14px 16px; }
    .chart .controls { display: flex; flex-wrap: wrap; align-items: end; gap: 10px 22px; margin: 8px 0 10px; }
    .chart select { min-width: 180px; }
    .label { color: var(--lf-muted); display: block; font-size: 12px; }
    .chart h3, .comparison h3 { font-size: 20px; }
    .chart .empty { display: grid; place-items: center; min-height: 185px; color: var(--lf-muted); text-align: center; padding: 15px; }
    .caption { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; color: var(--lf-muted); }
    .metrics { overflow-x: auto; margin-top: 10px; }
    table { width: 100%; border-spacing: 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--lf-border); }
    th { background: var(--secondary-background-color, #eef3f6); font-size: 12px; }
    tr.best td { background: color-mix(in srgb, var(--lf-accent) 12%, var(--lf-surface)); }
    .card-yaml { white-space: pre-wrap; padding: 8px; margin: 10px 0 0; background: var(--secondary-background-color, #edf2f6); overflow-wrap: anywhere; }
    .hint { margin: 8px 0; }
    .full { grid-column: 1 / -1; }
    .activity { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; }
    @media (max-width: 830px) {
      main { grid-template-columns: minmax(0, 1fr); padding: 12px; gap: 12px; }
      main.draft local-forecast-settings { order: -1; }
      header, .projects { padding-inline: 14px; }
      .project-title h2 { font-size: 22px; }
    }
    @media (max-width: 480px) {
      .projects { align-items: end; }
      .projects local-forecast-picker { flex-basis: 100%; max-width: none; }
      .projects button { margin-top: 0; }
    }
  `];

  hass?: Hass;
  narrow = false;
  private listing: LabList = { projects: [], engines: [], solar_entries: [] };
  private models: Model[] = [];
  private selection?: Project;
  private draft = initialSettings();
  private engineId = "";
  private preview?: Preview;
  private forecast?: Forecast;
  private evaluation?: Evaluation;
  private accuracy?: Scores;
  private modelId = "timestral-5m";
  private error = "";
  private busy = "";
  private job?: Job<unknown>;
  private notice = "";
  private loaded = false;
  private quarterHourAvailable?: boolean;
  private timer?: ReturnType<typeof setInterval>;
  private duplicateProjectNames = new Set<string>();

  connectedCallback(): void {
    super.connectedCallback();
    this.timer = setInterval(() => { void this.updateProject(); }, 12000);
  }

  disconnectedCallback(): void {
    clearInterval(this.timer);
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("hass") && this.hass && !this.loaded && !this.busy) void this.load();
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("listing")) {
      const seen = new Set<string>();
      this.duplicateProjectNames.clear();
      for (const { settings: { name } } of this.listing.projects) {
        if (seen.has(name)) this.duplicateProjectNames.add(name);
        seen.add(name);
      }
    }
  }

  private projectChoice(project: Project) {
    const { name, target } = project.settings;
    const detail = new Set([entityName(this.hass, target), target]);
    if (this.listing.engines.length > 1) {
      detail.add(this.listing.engines.find(engine => engine.id === project.engine_entry_id)?.name ?? project.engine_entry_id);
    }
    if (this.duplicateProjectNames.has(name)) detail.add(project.entity_id ?? project.id);
    return { id: project.id, name, detail: [...detail].join(" · ") };
  }

  private get workspaceKey(): string {
    return `local-forecast:workspace:${this.hass?.user?.id ?? ""}`;
  }

  private call<T>(operation: string, extra: Record<string, unknown> = {},
    projectId: string | null = this.selection?.id ?? null): Promise<T> {
    return this.hass!.callWS<T>({
      type: "local_forecast/lab", operation,
      ...(projectId ? { project_id: projectId } : {}),
      ...(this.engineId ? { engine_entry_id: this.engineId } : {}),
      ...extra,
    });
  }

  private async perform(label: string, operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.error = "";
    this.notice = "";
    this.busy = label;
    try {
      await operation();
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.busy = "";
      this.job = undefined;
    }
  }

  private async load(): Promise<void> {
    this.loaded = true;
    await this.perform("Loading projects", async () => {
      this.listing = await this.call<LabList>("list");
      let previous: string | null = null;
      try { previous = sessionStorage.getItem(this.workspaceKey); } catch { /* Storage is optional. */ }
      const project = previous === null ? this.listing.projects[0] : this.listing.projects.find(item => item.id === previous);
      await this.select(project);
    });
  }

  private async loadModels(preferInstalled = false): Promise<void> {
    this.models = this.engineId ? await this.call<Model[]>("models") : [];
    if (preferInstalled && !this.models.some(model => model.id === this.draft.model && model.installed)) {
      const ready = this.models.find(model => model.installed && !model.baseline)
        ?? this.models.find(model => model.installed);
      if (ready) this.changeDraft({ ...this.draft, model: ready.id });
    }
  }

  private async select(project?: Project): Promise<void> {
    this.selection = project;
    this.draft = project ? structuredClone(project.settings) : initialSettings();
    this.modelId = this.draft.model;
    this.engineId = project?.engine_entry_id ?? this.listing.engines[0]?.id ?? "";
    this.preview = this.forecast = this.evaluation = this.accuracy = undefined;
    this.quarterHourAvailable = undefined;
    await Promise.all([
      this.loadModels(!project),
      ...(project ? [this.loadAccuracy(), this.call<Evaluation | null>("evaluation").then(result => {
        this.evaluation = result ?? undefined;
      })] : []),
    ]);
    try { sessionStorage.setItem(this.workspaceKey, project?.id ?? "quick"); } catch { /* Storage is optional. */ }
  }

  private async loadAccuracy(): Promise<void> {
    this.accuracy = await this.call<Scores>("accuracy");
  }

  private async updateProject(): Promise<void> {
    const id = this.selection?.id;
    if (!id || this.busy || !this.isConnected) return;
    try {
      const current = await this.call<Project>("project");
      if (this.selection?.id === id) this.selection = current;
    } catch (error) {
      if (this.selection?.id === id) this.error = errorMessage(error);
    }
  }

  private get dirty(): boolean {
    return this.selection != null && JSON.stringify(this.draft) !== JSON.stringify(this.selection.settings);
  }

  private save(): Promise<void> {
    return this.perform("Saving project", async () => {
      const { id } = await this.call<{ id: string }>("save", { project: this.draft });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        this.listing = await this.call<LabList>("list");
        const saved = this.listing.projects.find(project => project.id === id);
        if (saved) {
          await this.select(saved);
          this.notice = "Project saved.";
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 350));
      }
      throw new Error("Project saved. Reload the Lab to finish loading it.");
    });
  }

  private previewHistory(): Promise<void> {
    return this.perform("Reading history", async () => {
      const settings = this.draft;
      const preview = await this.call<Preview>("preview", { project: settings });
      if (settings !== this.draft) return;
      this.preview = preview;
      this.quarterHourAvailable = preview.quarter_hour_available;
      this.forecast = undefined;
    });
  }

  private changeDraft(next: Settings): void {
    if ((["target", "mode", "solar", "history_days"] as const).some(key => this.draft[key] !== next[key])) {
      this.quarterHourAvailable = undefined;
      next = { ...next, step_minutes: 60 };
    }
    if ((["target", "mode", "solar", "history_days", "step_minutes", "inputs", "horizon_hours"] as const)
      .some(key => this.draft[key] !== next[key])) {
      this.preview = this.forecast = this.evaluation = undefined;
    }
    if (this.draft.model !== next.model) this.modelId = next.model;
    this.draft = next;
  }

  private analyze<T>(operation: "run" | "backtest", options: Record<string, unknown>): Promise<Job<T>> {
    return this.selection && !this.dirty ? this.call(operation, options)
      : this.call(operation, { ...options, project: this.draft }, null);
  }

  private async waitFor<T>(initial: Job<T>): Promise<T> {
    let job = initial;
    while (!resultStates.has(job.state)) {
      if (!job.id || !this.isConnected) throw new Error("The job is still running on the engine");
      this.job = job;
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = await this.call<Job<T>>("job", { job_id: job.id });
    }
    if (job.state !== "succeeded" || !job.result) throw new Error(job.error || `Job ${job.state}`);
    return job.result;
  }

  private run(): Promise<void> {
    return this.perform("Running forecast", async () => {
      const job = await this.analyze<Forecast>("run", { model: this.modelId });
      this.preview = job.preview;
      this.forecast = await this.waitFor(job);
    });
  }

  private compare(): Promise<void> {
    return this.perform("Comparing models", async () => {
      const variants = this.models.filter(model => model.installed).flatMap(model => {
        const withInputs = { model: model.id, use_inputs: true };
        return this.draft.inputs.length && model.id === this.modelId && !model.baseline
          ? [withInputs, { model: model.id, use_inputs: false }]
          : [withInputs];
      });
      const job = await this.analyze<Evaluation>("backtest", { variants });
      this.evaluation = await this.waitFor(job);
      if (this.selection && !this.dirty) await this.loadAccuracy();
    });
  }

  private install(model: string): Promise<void> {
    return this.perform("Installing model", async () => {
      await this.waitFor(await this.call<Job<{ installed: boolean }>>("install", { model }));
      await this.loadModels();
      this.notice = `${this.modelLabel(model)} is installed.`;
    });
  }

  private publish(): Promise<void> {
    return this.perform(this.selection?.settings.enabled ? "Pausing forecast" : "Publishing forecast", async () => {
      this.selection = await this.call<Project>("enable", { enabled: !this.selection!.settings.enabled });
      this.draft = structuredClone(this.selection.settings);
      this.listing = await this.call<LabList>("list");
      this.notice = this.selection.settings.enabled ? "Scheduled publishing is enabled." : "Scheduled publishing is paused.";
    });
  }

  private removeProject(): Promise<void> {
    if (!confirm(`Delete forecast project “${this.selection?.settings.name}”?`)) return Promise.resolve();
    return this.perform("Deleting project", async () => {
      await this.call("delete");
      this.listing = await this.call<LabList>("list");
      await this.select(this.listing.projects[0]);
    });
  }

  private modelLabel(id: string): string {
    return this.models.find(model => model.id === id)?.label ?? id;
  }

  private get yaml(): string {
    const entity = this.selection?.entity_id ?? "";
    if (customElements.get("local-forecast-card")) {
      return `type: custom:local-forecast-card\nentity: ${entity}\nhorizon_hours: ${this.draft.horizon_hours}\nshow_uncertainty: true`;
    }
    return `type: tile\nentity: ${entity}`;
  }

  private copy(): Promise<void> {
    return this.perform("Copying card configuration", async () => {
      if (!navigator.clipboard) {
        this.notice = "Select and copy the YAML below.";
        return;
      }
      await navigator.clipboard.writeText(this.yaml);
      this.notice = "Card configuration copied.";
    });
  }

  private chart() {
    const model = this.models.find(item => item.id === this.modelId);
    const forecast = this.forecast ?? (this.preview || this.dirty ? undefined : this.selection?.forecast ?? undefined);
    const data = forecast ?? this.preview;
    const coverage = data?.coverage;
    const unit = data?.unit || "";
    const ratio = coverage ? Math.round(100 * coverage.available / coverage.requested) : 0;
    return html`<section class="box chart">
      <h3>Forecast</h3>
      <div class="controls">
        <label>Forecast model<select aria-label="Preview model" ?disabled=${!!this.busy} .value=${this.modelId} @change=${(event: Event) => {
          this.modelId = (event.target as HTMLSelectElement).value;
          if (!this.selection) this.changeDraft({ ...this.draft, model: this.modelId });
        }}>
          ${modelOptions(this.models, this.modelId)}
        </select></label>
        <div><span class="label">Data coverage</span>
          ${coverage ? `${coverage.available} / ${coverage.requested} intervals (${ratio}%)` : "Awaiting history"}
        </div>
        ${model && !model.installed ? html`<button ?disabled=${!!this.busy} @click=${() => this.install(model.id)}>
          Install model · ${model.download_mb} MB
        </button>` : nothing}
      </div>
      ${model?.repo && !model.installed ? html`<p class="hint muted">Download ${model.label} from
        <a href=${`https://huggingface.co/${model.repo}`} target="_blank" rel="noopener">Hugging Face</a> · ${model.license}
      </p>` : nothing}
      <p class="caption"><span>Actual and predicted ${this.draft.name ? this.draft.name.toLocaleLowerCase() : "values"}</span>
        ${forecast ? html`<span>Forecast starts ${new Date(forecast.cutoff * 1000).toLocaleString(undefined,
          { timeZone: forecast.timezone, dateStyle: "short", timeStyle: "short" })}</span>` : nothing}
      </p>
      ${data && coverage?.available ? html`<local-forecast-chart
        .actual=${data.actual} .points=${forecast?.points ?? []} .unit=${unit}
        .timezone=${data.timezone} .cutoff=${forecast?.cutoff}
        .modelLabel=${forecast ? this.modelLabel(forecast.model) : ""}
        .dark=${!!this.hass?.themes?.darkMode}></local-forecast-chart>` :
        html`<div class="empty">${data ? "No recorded data in this window. Try a different interval or entity." :
          "Choose a target entity, then preview its history or run a forecast."}</div>`}
      ${this.preview?.inputs.length ? html`<details><summary>Input coverage</summary>
        <ul>${this.preview.inputs.map(input => html`<li>${input.name}: ${input.history} historical and ${input.future} future intervals</li>`)}</ul>
      </details>` : nothing}
      ${[...new Set([...(this.preview?.warnings ?? []), ...(this.selection?.warnings ?? [])])].map(warning =>
        html`<p class="hint muted">${warning}</p>`)}
    </section>`;
  }

  private comparison() {
    const results = this.evaluation;
    const rows = results ? [...results.variants].sort((a, b) => (a.mae ?? Infinity) - (b.mae ?? Infinity)) : [];
    const amount = (value: number | null, suffix: string) =>
      value === null ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
    const percentage = (value: number | null) => amount(value === null ? null : 100 * value, "%");
    return html`<section class="box comparison">
      <h3>Model comparison</h3>
      ${results ? html`<p class="hint muted">${results.folds} historical cutoffs ·
        ${results.common_count ? `${results.common_count} shared observations` : "No shared observations across every model"} ·
        ${results.archived_input_folds ? `Archived future inputs in ${results.archived_input_folds} cutoffs` : "Historical inputs only"}</p>
        <div class="metrics"><table>
          <thead><tr><th>Model</th><th>MAE</th><th>WAPE</th><th>80% coverage</th><th>Runtime</th><th>Worker RSS</th></tr></thead>
          <tbody>${rows.map((row, index) => html`<tr class=${index === 0 && results.common_count > 0 ? "best" : ""}>
            <td>${this.modelLabel(row.model)}${row.use_inputs ? "" : " · target only"}
              ${row.error ? html`<small class="error"> · ${row.error}</small>` : nothing}</td>
            <td>${amount(row.mae, results.unit ? " " + results.unit : "")}</td>
            <td>${percentage(row.wape)}</td><td>${percentage(row.coverage)}</td>
            <td>${amount(row.runtime_seconds, " s")}</td><td>${amount(row.peak_rss_mb, " MiB")}</td>
          </tr>`)}</tbody>
        </table></div>` : html`<p class="hint muted">Compare installed models and seasonal baselines using the selected entity’s recorded history.</p>`}
      ${this.accuracy?.count ? html`<p class="hint">Published forecasts · ${this.accuracy.count} scored intervals ·
        MAE ${amount(this.accuracy.mae, this.selection?.forecast?.unit ? " " + this.selection.forecast.unit : "")}</p>` : nothing}
    </section>`;
  }

  render() {
    const selected = this.selection;
    const disabled = !!this.busy;
    const installed = this.models.some(model => model.id === this.modelId && model.installed);
    return html`
      <header><ha-menu-button .hass=${this.hass} .narrow=${this.narrow}></ha-menu-button><h1>Forecast Lab</h1></header>
      ${this.listing.projects.length ? html`<nav class="projects" aria-label="Forecast workspace">
        <local-forecast-picker label="Saved project" .selection=${selected ? this.projectChoice(selected) : undefined}
          .getChoices=${() => this.listing.projects.map(project => this.projectChoice(project))}
          .clearable=${false} .disabled=${disabled} @selection-change=${(event: CustomEvent<string>) => {
            const project = this.listing.projects.find(item => item.id === event.detail);
            if (project && project.id !== selected?.id) void this.perform("Opening project", () => this.select(project));
          }}></local-forecast-picker>
        <button ?disabled=${disabled || !selected} @click=${() => this.perform("Opening quick analysis", () => this.select())}>
          <ha-icon icon="mdi:flask-outline"></ha-icon>Quick analysis
        </button>
      </nav>` : nothing}
      <main class=${selected ? "" : "draft"}>
        ${!this.listing.engines.length ? html`<div class="box full">
          <h2>Connect a forecasting engine</h2>
          <p class="hint">Add the Local Forecast integration in <a href="/config/integrations/dashboard">Devices &amp; services</a> and pair your local engine.</p>
          <button ?disabled=${disabled} @click=${() => this.load()}>Reload projects</button>
          ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        </div>` : html`<div class="workspace">
          <div class="toolbar">
            <div class="project-title"><h2>${selected?.settings.name ?? "Quick analysis"}</h2>
              ${selected ? html`<span class=${`status ${selected.status}`}>${statuses[selected.status] ?? selected.status}</span>` : nothing}
            </div>
            <div class="buttons">
              <button class="primary" ?disabled=${disabled || !this.draft.target || !installed} @click=${this.run}>
                <ha-icon icon="mdi:play"></ha-icon>Run forecast
              </button>
              <button ?disabled=${disabled || !this.draft.target || !this.models.some(model => model.installed)} @click=${this.compare}>
                <ha-icon icon="mdi:scale-balance"></ha-icon>Compare models
              </button>
            </div>
          </div>
          ${!selected ? html`<p class="muted">Try a forecast or compare models here. Save a project to keep these settings and schedule updates.</p>`
            : this.dirty ? html`<p class="muted">Runs use your edited settings. Save the project to apply them to scheduled forecasts.</p>` : nothing}
          ${this.error || selected?.error ? html`<p class="notice error" role="alert">${this.error || selected?.error}</p>` : nothing}
          ${this.busy ? html`<div class="notice activity"><span role="status">${this.job?.message || this.busy}…</span>
            ${this.job?.id ? html`<button @click=${async () => {
              try { await this.call("cancel", { job_id: this.job?.id }); }
              catch (error) { this.error = errorMessage(error); }
            }}>Cancel</button>` : nothing}
          </div>` : nothing}
          ${this.notice ? html`<p class="notice" role="status">${this.notice}</p>` : nothing}
          ${this.chart()}
          ${this.comparison()}
          ${selected ? html`<section class="box toolbar"><div>
            <h3>Scheduled publishing</h3>
            <p class="muted">${selected.settings.enabled ? `Updates every ${selected.settings.refresh_minutes} minutes.` : "Enable updates to use sensors and the Energy dashboard."}</p>
          </div><button ?disabled=${disabled || this.dirty} @click=${this.publish}>${selected.settings.enabled ? "Pause" : "Publish forecast"}</button></section>` : nothing}
          ${selected?.entity_id ? html`<section class="box">
            <details><summary>Dashboard card</summary><p class="hint">Add this YAML to a dashboard to show your published forecast sensor.</p>
              <button @click=${this.copy} ?disabled=${disabled}>Copy card YAML</button><pre class="card-yaml">${this.yaml}</pre>
            </details>
          </section>` : nothing}
        </div>
        <local-forecast-settings .hass=${this.hass} .project=${this.draft}
          .models=${this.models} .engines=${this.listing.engines} .engineId=${this.engineId}
          .solarEntries=${this.listing.solar_entries} .busy=${disabled} .saved=${!!selected}
          .quarterHourAvailable=${this.quarterHourAvailable}
          @project-change=${(event: CustomEvent<Settings>) => this.changeDraft(event.detail)}
          @engine-change=${(event: CustomEvent<string>) => this.perform("Connecting to engine", async () => {
            this.engineId = event.detail;
            this.preview = this.forecast = this.evaluation = undefined;
            await this.loadModels(true);
          })}
          @save-project=${this.save} @preview-project=${this.previewHistory} @delete-project=${this.removeProject}></local-forecast-settings>`}
      </main>
    `;
  }
}

if (!customElements.get("local-forecast-lab")) customElements.define("local-forecast-lab", ForecastLab);
