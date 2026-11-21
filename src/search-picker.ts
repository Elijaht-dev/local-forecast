import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { controls } from "./styles";

export interface Choice {
  id: string;
  name: string;
  detail?: string;
}

const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
const limit = 40;

export class SearchPicker extends LitElement {
  static formAssociated = true;
  static properties = {
    label: {}, selection: { attribute: false }, disabled: { type: Boolean }, required: { type: Boolean },
    clearable: { type: Boolean }, query: { state: true }, active: { state: true },
  };

  static styles = [controls, css`
    :host { display: block; min-width: 0; }
    .field { position: relative; }
    .control { display: flex; align-items: center; position: relative; }
    .control input { padding-inline-end: 2.2rem; }
    .control button, .chevron { position: absolute; inset-inline-end: 2px; }
    .control button { width: 32px; min-height: 30px; border: 0; padding: 0; }
    .chevron { pointer-events: none; margin-inline-end: 6px; color: var(--lf-muted); }
    .menu { position: absolute; top: 100%; inset-inline: 0; z-index: 5; margin-top: 3px;
      border: 1px solid var(--lf-border); border-radius: 7px; background: var(--lf-surface);
      box-shadow: 0 4px 14px #0002; max-height: min(18rem, 45vh); overflow-y: auto; overscroll-behavior: contain; }
    [role=option], .message { padding: 7px 10px; overflow-wrap: anywhere; }
    [role=option] { cursor: pointer; }
    [role=option]:hover, .active { background: color-mix(in srgb, var(--lf-accent) 15%, var(--lf-surface)); }
    small { display: block; overflow-wrap: anywhere; }
  `];

  label = "";
  selection?: Choice;
  disabled = false;
  required = false;
  clearable = true;
  getChoices: () => Choice[] = () => [];
  private readonly internals = this.attachInternals();
  private choices: { choice: Choice; search: string }[] = [];
  private query: string | null = null;
  private active = 0;

  protected updated(changed: PropertyValues): void {
    if (changed.has("selection") || changed.has("required") || changed.has("label")) {
      const missing = this.required && !this.selection;
      this.internals.setValidity(missing ? { valueMissing: true } : {}, missing ? `Select ${this.label.toLowerCase()}` : "",
        this.renderRoot.querySelector("input")!);
    }
    if (this.disabled && this.query !== null) this.close();
  }

  private open(): void {
    if (this.disabled || this.query !== null) return;
    const order = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    this.choices = this.getChoices().sort((a, b) => order.compare(a.name, b.name) ||
      order.compare(a.detail ?? "", b.detail ?? "") || order.compare(a.id, b.id))
      .map(choice => ({ choice, search: normalize(`${choice.name} ${choice.detail ?? ""} ${choice.id}`) }));
    this.active = 0;
    this.query = "";
  }

  private close(): void {
    this.query = null;
    this.choices = [];
  }

  private matchingChoices(): Choice[] {
    const words = normalize(this.query ?? "").trim().split(/\s+/);
    const matches: Choice[] = [];
    for (const { choice, search } of this.choices) {
      if (words.every(word => search.includes(word))) matches.push(choice);
      if (matches.length > limit) break;
    }
    return matches;
  }

  private choose(id: string): void {
    this.close();
    this.dispatchEvent(new CustomEvent("selection-change", { detail: id, bubbles: true, composed: true }));
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "Escape" && this.query !== null) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (this.query === null) { this.open(); return; }
      const last = Math.min(limit, this.matchingChoices().length) - 1;
      this.active = Math.max(0, Math.min(last, this.active + (event.key === "ArrowDown" ? 1 : -1)));
      this.renderRoot.querySelector(`#option-${this.active}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && this.query !== null) {
      event.preventDefault();
      const choice = this.matchingChoices()[this.active];
      if (choice) this.choose(choice.id);
    }
  }

  render() {
    const open = this.query !== null && !this.disabled;
    const matches = open ? this.matchingChoices() : [];
    return html`<label for="search">${this.label}</label>
      <div class="field"><div class="control">
        <input id="search" role="combobox" aria-autocomplete="list" aria-expanded=${String(open)}
          aria-controls="choices" aria-required=${String(this.required)}
          aria-activedescendant=${open && matches.length ? `option-${this.active}` : nothing}
          autocomplete="off" placeholder=${open && this.selection ? this.selection.name : "Search…"}
          .value=${this.query ?? this.selection?.name ?? ""} ?disabled=${this.disabled}
          @focus=${this.open} @click=${this.open} @blur=${this.close} @keydown=${this.keydown}
          @input=${(event: Event) => {
            this.open(); this.query = (event.target as HTMLInputElement).value; this.active = 0;
            this.renderRoot.querySelector(".menu")?.scrollTo(0, 0);
          }}>
        ${this.selection && this.clearable ? html`<button type="button" aria-label=${`Clear ${this.label.toLowerCase()}`}
          ?disabled=${this.disabled} @click=${() => { this.choose(""); this.renderRoot.querySelector("input")?.focus(); }}>
          <ha-icon icon="mdi:close" aria-hidden="true"></ha-icon></button>`
          : html`<ha-icon class="chevron" icon="mdi:chevron-down" aria-hidden="true"></ha-icon>`}
      </div>
      <div class="menu" ?hidden=${!open} @mousedown=${(event: MouseEvent) => event.preventDefault()}>
        <div id="choices" role="listbox" aria-label=${this.label}>
          ${matches.slice(0, limit).map((choice, index) => html`<div role="option" id=${`option-${index}`}
            aria-selected=${String(choice.id === this.selection?.id)} class=${index === this.active ? "active" : ""}
            @click=${() => this.choose(choice.id)}>${choice.name}${choice.detail ? html`<small>${choice.detail}</small>` : nothing}</div>`)}
        </div>
        ${open && !matches.length ? html`<div class="message muted" role="status">No matches</div>` : nothing}
        ${matches.length > limit ? html`<div class="message muted">Refine your search to see more results.</div>` : nothing}
      </div></div>
      ${this.selection?.detail ? html`<small>${this.selection.detail}</small>` : nothing}`;
  }
}

customElements.define("local-forecast-picker", SearchPicker);
