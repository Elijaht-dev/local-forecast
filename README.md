# Local Forecast for Home Assistant

Forecast recorded numeric entities on your own hardware. **Forecast Lab** lets you inspect recorded data, add explanatory inputs, compare models with seasonal baselines, and publish forecasts for dashboards and automations.

![Forecast Lab with a recorded test series and model comparison](docs/forecast-lab.jpg)

## Install the public beta

Use Home Assistant 2026.11 or newer and an administrator account. The integration provides Forecast Lab and reads the history of the entities you select. The engine runs the models on your hardware.

1. **Start the engine.** On Home Assistant OS, open **Settings → Apps → App store → Repositories** and add `https://github.com/Elijaht-dev/local-forecast-engine#ha-beta`, including the branch suffix. Install **Local Forecast Engine** and start it. Supervisor builds the app on the first install. For Home Assistant Container, build the engine with Docker Compose, put it on a network shared with Home Assistant, and use its service name when pairing. [Standalone Docker setup](https://github.com/Elijaht-dev/local-forecast-engine/blob/v0.1.0/README.md#standalone-docker)
2. **Install the integration.** In **Settings → Marketplace**, add `https://github.com/Elijaht-dev/local-forecast` as a custom integration repository, enable **Pre-release**, and select the beta. For a manual install, extract the contents of the release asset `local_forecast.zip` directly into `config/custom_components/local_forecast/`. Restart Home Assistant. [Beta releases and ZIP downloads](https://github.com/Elijaht-dev/local-forecast/releases)
3. **Pair the engine.** Open **Settings → Devices & services** and accept the discovered **Local Forecast** integration. For a Docker engine, add **Local Forecast** manually. Enter its URL (for example, `http://local-forecast:8099` on a shared Docker network) and the token printed by `docker compose exec local-forecast cat /data/api-token`.
4. **Run your first forecast.** Open **Forecast Lab → Quick analysis**, choose a recorded numeric entity, select **Persistence** and click **Run forecast**. You can also preview its history or compare installed models. To keep the settings, enter a name and click **Save as project**. **Publish forecast** then enables scheduled updates for the project's Home Assistant sensors. To try a neural model, choose **Timestral-5M** in the forecast, install it and run again.

On Raspberry Pi 4, use the built-in baselines with engine v0.1.0. Its PyTorch build cannot run the neural models on that processor. [Engine compatibility notes](https://github.com/Elijaht-dev/local-forecast-engine/releases/tag/v0.1.0)

## Data and models

The default forecast is hourly for 48 hours, refreshed every hour, from up to 28 days of history. Preview the target's history to enable 15-minute forecasts when Recorder has at least 32 usable 15-minute observations in the selected window. Eligible sensors can use hourly recorder statistics for older periods. Historical gaps stay missing. A cumulative meter forecasts the energy, water, or other increment per interval.

Use a recorded numeric entity or binary state as an input. For inputs with future values, choose HA hourly weather, an existing Forecast.Solar configuration, or a numeric timestamp/value array in an entity attribute. Choose a historical counterpart for Forecast.Solar or attribute arrays. For weather, the matching recorded attribute is used when available. Use the preview to see which inputs have usable coverage.

Models run in the paired engine and use only selected input series. The engine archives predictions at issue time and compares them with later observations. Historical tests reuse archived forecasts where available and label historical-only tests. Compare models over the same observed intervals and choose the model to publish in project settings.

## Solar

Choose a recorded PV power sensor or cumulative production meter and enable **Solar forecast for the Energy dashboard**. In **Settings → Dashboards → Energy**, select the Local Forecast project as the forecast for your measured solar production source. Each published solar project has its own config entry. The forecast provides hourly Wh, remaining energy today, energy tomorrow, and the upcoming peak. A daily sensor is unavailable when coverage for the requested day is incomplete.

## Actions

```yaml
action: local_forecast.get_forecast
data:
  entity_id: sensor.solar_production_next_interval
response_variable: forecast
```

The response contains the forecast status, issue time, cutoff, interval, unit, and points. `local_forecast.refresh` accepts the same sensor and queues a new run for a published project. Forecast arrays are read through the action and card API.

## Build and test

```sh
npm ci
npm run build
python scripts/package.py
docker run --rm --entrypoint python -e PYTHONPATH=/repo -v "$PWD:/repo:ro" \
  ghcr.io/home-assistant/home-assistant:2026.11.0 -m unittest discover -v -s /repo/tests
```

`tests/smoke_ha.mjs` checks a disposable HA instance configured with `tests/fixtures/configuration.yaml`. Expose HA on loopback port 18123 and run the engine on the same Docker network. Set `LF_TOKEN` and, if needed, `LF_TEST_ENGINE_URL`. Install Timestral-5M on the test engine first. With Node 24, run `node tests/smoke_ha.mjs`. The test imports synthetic recorder data, checks interval eligibility, runs and refreshes the real model, verifies its sensors and actions, selects two solar projects through the Energy API, and compares forecasts against held-out history.

The integration is MIT licensed. The engine links to each model's upstream license.
