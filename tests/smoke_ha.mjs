/**
 * Exercise a disposable HA container using the public HA HTTP/WebSocket APIs.
 * Run only with tests/fixtures/configuration.yaml and a running test engine.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const base = new URL(process.env.LF_TEST_HA_URL ?? "http://127.0.0.1:18123/");
const stateDir = process.env.LF_TEST_STATE_DIR ?? ".lf-e2e";
const username = "forecast_qa";
const password = randomBytes(24).toString("base64url");
const engineUrl = process.env.LF_TEST_ENGINE_URL ?? "http://local-forecast-engine-qa:8099";
const engineToken = process.env.LF_TOKEN;
const authFile = join(stateDir, "ha-auth.json");
const clientId = base.href;

assert(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Use a loopback-only test instance");
assert(engineToken, "Set LF_TOKEN for the disposable test engine");

async function rest(path, {method = "GET", body, access, form} = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(access ? {Authorization: `Bearer ${access}`} : {}),
      ...(body ? {"Content-Type": form ? "application/x-www-form-urlencoded" : "application/json"} : {}),
    },
    body: form ? new URLSearchParams(body) : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    let error = "";
    if (!path.includes("/auth") && !path.includes("config_entries/flow")) error = await response.text();
    throw new Error(`${method} ${path}: ${response.status} ${error}`);
  }
  return response.status === 204 ? null : response.json();
}

async function auth() {
  let saved;
  try { saved = JSON.parse(await readFile(authFile, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (saved) {
    const data = await rest("/auth/token", {
      method: "POST", form: true,
      body: {grant_type: "refresh_token", refresh_token: saved.refresh_token, client_id: clientId},
    });
    return data.access_token;
  }
  const steps = await rest("/api/onboarding");
  assert(steps.some(step => step.step === "user" && !step.done), "Expected a fresh HA test instance");
  const {auth_code} = await rest("/api/onboarding/users", {
    method: "POST", body: {name: "Forecast QA", username, password, client_id: clientId, language: "en"},
  });
  const data = await rest("/auth/token", {
    method: "POST", form: true,
    body: {grant_type: "authorization_code", code: auth_code, client_id: clientId},
  });
  await mkdir(stateDir, {recursive: true});
  await writeFile(authFile, JSON.stringify(data), {mode: 0o600});
  for (const step of ["core_config", "analytics", "integration"]) {
    await rest("/api/onboarding/" + step, {
      method: "POST", access: data.access_token, body: {client_id: clientId, redirect_uri: clientId},
    });
  }
  return data.access_token;
}

async function socket(access) {
  const url = new URL("/api/websocket", base);
  url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    ws.addEventListener("error", reject, {once: true});
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.type === "auth_required") ws.send(JSON.stringify({type: "auth", access_token: access}));
      if (message.type === "auth_ok") resolve();
      if (message.type === "auth_invalid") reject(new Error("HA refused the QA login"));
      if (message.type !== "result") return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.success) entry.resolve(message.result);
      else entry.reject(new Error(`${entry.type}: ${message.error?.message}`));
    });
  });
  return {
    send(type, fields = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)); }, 45000);
        pending.set(id, {resolve, reject, timer, type});
        ws.send(JSON.stringify({id, type, ...fields}));
      });
    },
    close() { ws.close(); },
  };
}

async function seed(send, access) {
  const cutoff = Math.floor(Date.now() / 3600000) * 3600000;
  const days = 28;
  const pv = [];
  const outdoor = [];
  for (let index = 0; index < days * 24; index += 1) {
    const hour = new Date(cutoff - (days * 24 - index) * 3600000);
    const cloud = 0.65 + 0.3 * Math.sin(index / 71);
    pv.push({start: hour.toISOString(), mean: 4800 * cloud * Math.max(0, Math.sin((hour.getUTCHours() - 7) / 10 * Math.PI)) * (hour.getUTCHours() <= 17 ? 1 : 0)});
    outdoor.push({start: hour.toISOString(), mean: 15 + 8 * Math.sin((hour.getUTCHours() - 7) / 24 * Math.PI * 2)});
  }
  for (const [entity, unit, unitClass, values] of [
    ["sensor.qa_solar_power", "W", "power", pv],
    ["sensor.qa_hourly_only", "W", "power", pv],
    ["sensor.qa_outdoor_temperature", "°C", "temperature", outdoor],
  ]) {
    await send("recorder/import_statistics", {
      metadata: {statistic_id: entity, source: "recorder", unit_of_measurement: unit, unit_class: unitClass,
        mean_type: 1, has_sum: false, name: null},
      stats: values.map(row => ({...row, min: row.mean, max: row.mean})),
    });
  }
  await rest("/api/states/sensor.qa_weather_outlook", {
    access, method: "POST", body: {state: "available", attributes: {
      outlook: Array.from({length: 48}, (_, index) => ({
        datetime: new Date(cutoff + index * 3600000).toISOString(), value: outdoor[index].mean,
      })),
    }},
  });
}

async function publish(lab, id) {
  await lab("enable", {project_id: id, enabled: true});
  let saved;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    saved = await lab("project", {project_id: id});
    if (saved.status === "ready" && saved.entity_id) break;
    assert(!saved.error, saved.error);
    await sleep(1000);
  }
  assert.equal(saved.status, "ready");
  assert.equal(saved.forecast.points.length, 48);
  return saved;
}

async function previewHistory(lab, project) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const preview = await lab("preview", {project});
    if (preview.coverage.available >= 620 && preview.inputs.every(input => input.history > 0)) return preview;
    await sleep(600);
  }
  throw new Error(`Expected imported hourly statistics for ${project.target}`);
}

const access = await auth();
const config = await rest("/api/config", {access});
assert.equal(config.location_name, "Local Forecast QA", "Refusing to seed a non-test HA instance");
const {send, close} = await socket(access);

try {
  let listing;
  const lab = (operation, extra = {}) => send("local_forecast/lab", {operation, ...extra});
  const entries = await send("config_entries/get", {domain: "local_forecast"});
  if (entries.length === 0) {
    const flow = await rest("/api/config/config_entries/flow", {access, method: "POST", body: {handler: "local_forecast"}});
    assert.equal(flow.type, "form", JSON.stringify(flow));
    const paired = await rest("/api/config/config_entries/flow/" + flow.flow_id, {
      access, method: "POST", body: {url: engineUrl, token: engineToken},
    });
    assert.equal(paired.type, "create_entry", `Engine pairing did not complete: ${paired.reason ?? "no reason"}`);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { listing = await lab("list"); } catch (error) {
      if (!error.message.includes("Unknown command")) throw error;
    }
    if (listing?.engines.length) break;
    await sleep(500);
  }
  const engine = listing?.engines[0]?.id;
  assert(engine, "The engine config entry must load");
  const panel = (await send("get_panels"))["forecast-lab"];
  assert(panel?.require_admin, "Forecast Lab must be registered in the admin sidebar");
  const moduleUrl = panel.config._panel_custom.module_url;
  assert.equal(new URL(moduleUrl, base).origin, base.origin);
  const moduleResponse = await fetch(new URL(moduleUrl, base));
  assert.equal(moduleResponse.status, 200, "The installed release must serve the panel module");
  assert((await moduleResponse.text()).includes("local-forecast-lab"));
  await seed(send, access);
  const settings = {
    name: "Solar production", target: "sensor.qa_solar_power", model: "timestral-5m",
    step_minutes: 60, horizon_hours: 48, history_days: 28, refresh_minutes: 60, mode: "auto",
    solar: true, enabled: false,
    inputs: [{kind: "attribute", entity: "sensor.qa_weather_outlook", attribute: "outlook", history_entity: "sensor.qa_outdoor_temperature"}],
  };
  const current = listing.projects.find(project => project.settings.name === settings.name);
  const {id} = current ?? await lab("save", {project: settings, engine_entry_id: engine});
  const project = (operation, extra = {}) => lab(operation, {project_id: id, ...extra});
  const preview = await previewHistory(lab, settings);
  assert(preview.inputs[0].future > 0 && preview.inputs[0].history > 0, "Expected aligned HA covariates");
  const hourlyOnly = {...settings, name: "Hourly-only probe", target: "sensor.qa_hourly_only", solar: false, inputs: []};
  const hourlyPreview = await previewHistory(lab, hourlyOnly);
  assert.equal(hourlyPreview.quarter_hour_available, false, "Hourly statistics cannot supply 15-minute history");
  await assert.rejects(lab("save", {project: {...hourlyOnly, step_minutes: 15}, engine_entry_id: engine}),
    /observed 15-minute intervals/);
  const saved = await publish(lab, id);
  assert(saved.forecast.points.some(point => point.p90 > point.p10), "Expected model quantiles");
  const registry = await send("config/entity_registry/list");
  const statusSensor = registry.find(entry => entry.platform === "local_forecast" && entry.unique_id === `${id}_status`);
  assert(statusSensor, "Expected a registered diagnostic status sensor");
  const status = await rest(`/api/states/${statusSensor.entity_id}`, {access});
  assert.equal(status.state, "ready");
  const card = await send("local_forecast/card", {entity_id: saved.entity_id});
  assert.equal(card.forecast.id, saved.forecast.id);
  if (process.env.LF_TEST_CARD === "1") {
    const resourceUrl = "/local/local-forecast-card.js";
    const resources = await send("lovelace/resources");
    if (!resources.some(resource => resource.url === resourceUrl)) {
      await send("lovelace/resources/create", {res_type: "module", url: resourceUrl});
    }
    const path = "forecast-qa";
    const dashboards = await send("lovelace/dashboards/list");
    if (!dashboards.some(dashboard => dashboard.url_path === path)) {
      await send("lovelace/dashboards/create", {url_path: path, title: "Forecast Card QA", show_in_sidebar: true});
    }
    await send("lovelace/config/save", {url_path: path, config: {views: [{
      title: "Forecast Card QA", path: "forecast-card-qa", cards: [
        {type: "custom:local-forecast-card", entity: saved.entity_id, horizon_hours: 48},
      ],
    }]}});
  }
  const response = await rest("/api/services/local_forecast/get_forecast?return_response", {
    method: "POST", access, body: {entity_id: saved.entity_id},
  });
  assert.equal(response.service_response.forecast.id, saved.forecast.id);
  const info = await send("energy/info");
  assert(info.solar_forecast_domains.includes("local_forecast"));
  const baselineSettings = {...settings, name: "Solar baseline", model: "previous-week", inputs: []};
  const baseline = listing.projects.find(project => project.settings.name === baselineSettings.name)
    ?? await lab("save", {project: baselineSettings, engine_entry_id: engine});
  assert.notEqual(baseline.id, id);
  await publish(lab, baseline.id);
  await send("energy/save_prefs", {energy_sources: [{
    type: "solar", stat_energy_from: "sensor.qa_solar_energy", config_entry_solar_forecast: [id, baseline.id],
  }], device_consumption: []});
  const solar = await send("energy/solar_forecast");
  assert(Object.values(solar[id].wh_hours).some(value => value > 0));
  assert(Object.values(solar[baseline.id].wh_hours).some(value => value > 0));
  assert.notDeepEqual(solar[id].wh_hours, solar[baseline.id].wh_hours);

  await rest("/api/services/local_forecast/refresh", {
    method: "POST", access, body: {entity_id: saved.entity_id},
  });
  let refreshed = saved;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    refreshed = await project("project");
    if (refreshed.forecast?.id && refreshed.forecast.id !== saved.forecast.id) break;
    assert(!refreshed.error, refreshed.error);
    await sleep(1000);
  }
  assert.notEqual(refreshed.forecast?.id, saved.forecast.id, "Refresh must issue a new forecast");

  const backtest = await project("backtest", {variants: [
    {model: "timestral-5m"}, {model: "previous-week"},
  ], folds: 2});
  let job = backtest;
  for (let attempt = 0; attempt < 60 && !["succeeded", "failed", "cancelled"].includes(job.state); attempt += 1) {
    await sleep(1000);
    job = await project("job", {job_id: backtest.id});
  }
  assert.equal(job.state, "succeeded", job.error);
  assert(job.result.common_count > 0 && job.result.archived_input_folds === 0);
  assert.deepEqual(await project("evaluation"), job.result, "Backtests should remain readable after the job finishes");
  console.log(`HA workflow passed: ${preview.coverage.available} historical intervals, ${saved.forecast.points.length} predictions, ${Object.keys(solar[id].wh_hours).length} native solar hours, ${job.result.common_count} paired backtest observations`);
} finally {
  close();
}
