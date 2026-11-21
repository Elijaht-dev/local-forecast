import { html, nothing } from "lit";
import type { Model } from "./types";

export function modelOptions(models: Model[], selected: string) {
  const group = (label: string, items: Model[]) => items.length ? html`
    <optgroup label=${label}>${items.map(model => html`
      <option value=${model.id} ?selected=${model.id === selected}>${model.label}</option>`)}</optgroup>` : nothing;
  return html`
    ${group("Installed models", models.filter(model => model.installed && !model.baseline))}
    ${group("Built-in baselines", models.filter(model => model.installed && model.baseline))}
    ${group("Available to install", models.filter(model => !model.installed))}
    ${selected && !models.some(model => model.id === selected) ? html`
      <optgroup label="Unavailable on this engine"><option selected disabled value=${selected}>${selected}</option></optgroup>` : nothing}`;
}
