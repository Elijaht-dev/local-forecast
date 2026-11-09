import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { type EChartsType, init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LitElement, css, html, type PropertyValues } from "lit";
import type { Point } from "./types";

use([LineChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

/** Shared by the Lab and the separately distributed card. */
export class ForecastChart extends LitElement {
  static properties = {
    actual: {}, points: {}, unit: {}, timezone: {}, cutoff: {}, modelLabel: {},
    showBand: { type: Boolean }, dark: { type: Boolean },
  };

  static styles = css`
    :host { display: block; min-width: 0; }
    div { height: var(--lf-chart-height, clamp(245px, 32vw, 315px)); width: 100%; }
  `;

  actual: Point[] = [];
  points: Point[] = [];
  unit = "";
  timezone = "UTC";
  cutoff?: number;
  modelLabel = "";
  showBand = true;
  dark = false;
  private plot?: EChartsType;
  private resize?: ResizeObserver;

  render() {
    return html`<div role="img" aria-label="Chart of actual and forecast values"></div>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.updateComplete.then(() => {
      if (this.isConnected && !this.plot) this.paint();
    });
  }

  disconnectedCallback(): void {
    this.resize?.disconnect();
    this.plot?.dispose();
    this.plot = undefined;
    super.disconnectedCallback();
  }

  protected updated(_changes: PropertyValues): void {
    this.paint();
  }

  private paint(): void {
    if (!this.isConnected) return;
    if (!this.plot) {
      const container = this.renderRoot.querySelector("div")!;
      this.plot = init(container);
      this.resize = new ResizeObserver(() => this.plot?.resize());
      this.resize.observe(container);
    }
    const style = getComputedStyle(this);
    const color = (key: string, fallback: string) => style.getPropertyValue(key).trim() || fallback;
    const accent = color("--lf-accent", color("--primary-color", "#0079a8"));
    const text = color("--primary-text-color", this.dark ? "#e1e8ed" : "#243039");
    const grid = color("--divider-color", this.dark ? "#46515a" : "#d9e2e9");
    const surface = color("--card-background-color", this.dark ? "#20272d" : "#fff");
    const measured = "Actual";
    const forecast = this.modelLabel ? `Forecast (${this.modelLabel})` : "Forecast";
    const band = this.showBand && this.points.some(point => point.p10 != null && point.p90 != null);
    const legend = [this.actual.length ? measured : null, this.points.length ? forecast : null, band ? "80% interval" : null]
      .filter((item): item is string => item !== null);
    const date = new Intl.DateTimeFormat(undefined, {
      timeZone: this.timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const series = [];
    if (band) {
      const bandPoints = (upper: boolean) => this.points.map(point => [
        point.start * 1000, point.p10 == null || point.p90 == null ? null :
          upper ? point.p90 - point.p10 : point.p10,
      ]);
      series.push({
        name: "Lower bound", type: "line", stack: "uncertainty", stackStrategy: "all",
        data: bandPoints(false), symbol: "none", lineStyle: { opacity: 0 },
        tooltip: { show: false }, silent: true, z: 1,
      }, {
        name: "80% interval", type: "line", stack: "uncertainty", stackStrategy: "all",
        data: bandPoints(true), symbol: "none", lineStyle: { opacity: 0 },
        areaStyle: { color: accent, opacity: 0.18 }, itemStyle: { color: accent },
        tooltip: { show: false }, silent: true, z: 1,
      });
    }
    if (this.actual.length) series.push({
      name: measured, type: "line", data: this.actual.map(p => [p.start * 1000, p.value]),
      symbol: "none", itemStyle: { color: text }, lineStyle: { width: 2.5 },
    });
    if (this.points.length) series.push({
      name: forecast, type: "line", data: this.points.map(p => [p.start * 1000, p.value]),
      symbol: "none", itemStyle: { color: accent }, lineStyle: { width: 2.5 },
      markLine: this.cutoff ? {
        silent: true, symbol: "none", lineStyle: { color: text, opacity: 0.6, type: "dashed" },
        label: { show: false },
        data: [{ xAxis: this.cutoff * 1000 }],
      } : undefined,
    });
    this.plot.setOption({
      animation: false,
      textStyle: { color: text, fontFamily: "inherit", fontSize: 12 },
      grid: { top: 16, right: 15, left: 10, bottom: 50, containLabel: true },
      legend: { bottom: 2, data: legend, textStyle: { color: text, fontSize: 12 } },
      tooltip: {
        trigger: "axis", renderMode: "richText", backgroundColor: surface, textStyle: { color: text },
        axisPointer: { label: { formatter: (event: {value: number}) => date.format(event.value) } },
      },
      xAxis: {
        type: "time", axisLabel: { color: text, hideOverlap: true, formatter: (value: number) => date.format(value) },
        splitLine: { show: true, lineStyle: { color: grid } },
      },
      yAxis: {
        type: "value", scale: true,
        axisLabel: { color: text, formatter: (value: number) => `${value.toLocaleString()}${this.unit ? " " + this.unit : ""}` },
        splitLine: { lineStyle: { color: grid } },
      },
      series,
    }, { notMerge: true });
  }
}

if (!customElements.get("local-forecast-chart")) customElements.define("local-forecast-chart", ForecastChart);
