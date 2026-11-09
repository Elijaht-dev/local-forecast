"""Gather selected HA inputs for live forecasts and historical evaluations."""

from asyncio import gather, timeout
from hashlib import sha256
from json import dumps
from time import time

from homeassistant.components.recorder import get_instance
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util
from homeassistant.util.unit_conversion import EnergyConverter, PowerConverter

from .history import Source, number, read_history, utc
from .project import convert, resolve

QUARTER_HOUR = 900
MIN_QUARTER_HOUR_OBSERVATIONS = 32


def key_of(*values) -> str:
    return sha256(dumps(values, sort_keys=True).encode()).hexdigest()[:24]


def config_key(config: dict) -> str:
    return key_of(
        {
            key: value
            for key, value in config.items()
            if key not in {"name", "enabled", "refresh_minutes"}
        }
    )


def source_for(
    hass: HomeAssistant,
    entity: str,
    mode: str = "auto",
    solar: bool = False,
    *,
    binary: bool = False,
) -> Source:
    if (state := hass.states.get(entity)) is None:
        raise ValueError(f"{entity} is unavailable")
    unit = state.attributes.get("unit_of_measurement")
    state_class = state.attributes.get("state_class")
    energy = solar and unit in EnergyConverter.VALID_UNITS
    if mode == "measurement" or (solar and unit in PowerConverter.VALID_UNITS):
        mode = "measurement"
    elif state_class == "total_increasing" or (energy and state_class != "total"):
        mode = "increasing"
    elif state_class == "total" or mode == "counter":
        mode = "counter"
    else:
        mode = "measurement"
    if solar:
        if energy and mode == "measurement":
            raise ValueError(
                "Use a cumulative energy meter or a power measurement as the solar target"
            )
        if not energy and unit not in PowerConverter.VALID_UNITS:
            raise ValueError("The solar target must report power or energy")
        unit = "Wh" if energy else "W"
    return Source(entity, unit, mode, binary=binary)


def history_source(hass: HomeAssistant, item: dict) -> Source | None:
    if item["history_entity"] or item["kind"] == "history":
        return source_for(
            hass, resolve(hass, item["history_entity"] or item["entity"]), binary=True
        )
    if item["kind"] == "weather":
        entity = resolve(hass, item["entity"])
        field = item["field"]
        unit_attr = {
            "temperature": "temperature_unit",
            "pressure": "pressure_unit",
            "wind_speed": "wind_speed_unit",
            "precipitation": "precipitation_unit",
        }.get(field, "")
        state = hass.states.get(entity)
        unit = state.attributes.get(unit_attr) if state and unit_attr else None
        return Source(entity, unit, attribute=field, unit_attribute=unit_attr)
    return None


def history_cutoff(step: int, commit_interval: int) -> int:
    return (int(time()) - max(commit_interval + 1, 10)) // step * step


async def quarter_hour_available(hass: HomeAssistant, config: dict) -> bool:
    recorder = get_instance(hass)
    end = history_cutoff(QUARTER_HOUR, recorder.commit_interval)
    days = min(recorder.keep_days, config["history_days"])
    target = source_for(hass, resolve(hass, config["target"]), config["mode"], config["solar"])
    observed = await recorder.async_add_executor_job(
        read_history, hass, [target], end - days * 86400, end, QUARTER_HOUR, days
    )
    return sum(value is not None for value in observed[target]) >= MIN_QUARTER_HOUR_OBSERVATIONS


def forecast_stamp(value) -> int | None:
    if (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and number(value) is not None
    ):
        return int(value)
    if isinstance(value, str):
        try:
            stamp = dt_util.parse_datetime(value)
        except ValueError:
            return None
        if stamp and stamp.tzinfo:
            return int(stamp.timestamp())
    return None


async def future_values(
    hass: HomeAssistant, item: dict, source: Source | None, cutoff: int, step: int, horizon: int
) -> tuple[list[float | None], int]:
    entity = resolve(hass, item["entity"])
    kind = item["kind"]
    repeat = 3600 // step if kind in {"solar", "weather"} else 1
    async with timeout(15):
        if kind == "weather":
            response = await hass.services.async_call(
                "weather",
                "get_forecasts",
                {"type": "hourly"},
                target={"entity_id": entity},
                blocking=True,
                return_response=True,
            )
            rows = response.get(entity, {}).get("forecast", [])
            provider = hass.states.get(entity)
            unit_attr = {
                "temperature": "temperature_unit",
                "pressure": "pressure_unit",
                "wind_speed": "wind_speed_unit",
                "precipitation": "precipitation_unit",
            }.get(item["field"], "")
            unit = provider.attributes.get(unit_attr) if provider and unit_attr else None
            values = (
                (row.get("datetime"), row.get(item["field"]))
                for row in rows
                if isinstance(row, dict)
            )
        elif kind == "solar":
            field = "wh_period" if item["field"] == "wh_period" else "watts"
            response = await hass.services.async_call(
                "forecast_solar",
                "get_forecast",
                {
                    "config_entry": item["entry_id"],
                    "resolution": "hourly",
                    "start": utc(cutoff // 3600 * 3600).isoformat(),
                    "end": utc(cutoff + step * horizon).isoformat(),
                },
                blocking=True,
                return_response=True,
            )
            unit = "Wh" if field == "wh_period" else "W"
            values = (
                (stamp, value / repeat if field == "wh_period" else value)
                for stamp, val in response.get(field, {}).items()
                if (value := number(val)) is not None
            )
        else:
            state = hass.states.get(entity)
            rows = (
                state.attributes.get(item["attribute"], [])
                if state and state.state != "unavailable"
                else []
            )
            if not isinstance(rows, (tuple, list)):
                raise ValueError("The selected attribute does not contain an array")
            unit = source.unit if source else None
            values = (
                (row.get(item["timestamp_key"]), row.get(item["value_key"]))
                for row in rows[:3000]
                if isinstance(row, dict)
            )
        aligned = [None] * horizon
        for stamp, raw in values:
            if (timestamp := forecast_stamp(stamp)) is None or (value := number(raw)) is None:
                continue
            if source and unit is not None and source.unit != unit:
                if (value := convert(value, unit, source.unit)) is None:
                    continue
            # Timestamps denote interval starts; hourly forecasts are held within that hour.
            index = (timestamp - cutoff) // step
            for offset in range(max(index, 0), min(index + repeat, horizon)):
                aligned[offset] = value
    return aligned, int(time())


async def build_dataset(
    hass: HomeAssistant, project_id: str, config: dict, *, with_future: bool = True
) -> tuple[dict, dict]:
    recorder = get_instance(hass)
    step = config["step_minutes"] * 60
    cutoff = history_cutoff(step, recorder.commit_interval)
    start = cutoff - config["history_days"] * 86400
    horizon = config["horizon_hours"] * 3600 // step
    target = source_for(hass, resolve(hass, config["target"]), config["mode"], config["solar"])
    warnings = []
    input_sources = []
    for item in config["inputs"]:
        try:
            source = history_source(hass, item)
        except ValueError as error:
            warnings.append(str(error))
            source = None
        input_sources.append(source)
    observed = await recorder.async_add_executor_job(
        read_history,
        hass,
        [target, *(source for source in input_sources if source)],
        start,
        cutoff,
        step,
        recorder.keep_days,
    )
    targets = observed[target]
    forecasts = [
        future_values(hass, item, source, cutoff, step, horizon)
        for item, source in zip(config["inputs"], input_sources, strict=True)
        if with_future and item["kind"] != "history"
    ]
    results = iter(await gather(*forecasts, return_exceptions=True))
    covariates, coverage = [], []
    for item, source in zip(config["inputs"], input_sources, strict=True):
        label = resolve(hass, item["history_entity"] or item["entity"]) or "Forecast.Solar"
        past = observed[source] if source else [None] * len(targets)
        future = receipt = None
        if with_future and item["kind"] != "history":
            result = next(results)
            if isinstance(result, (ValueError, HomeAssistantError, TimeoutError)):
                warnings.append(f"{label}: future values are unavailable")
            elif isinstance(result, BaseException):
                raise result
            else:
                future, receipt = result
        if not any(value is not None for value in past):
            warnings.append(f"{label}: no recorded historical values for this input")
        coverage.append(
            {
                "name": label,
                "kind": item["kind"],
                "history": sum(value is not None for value in past),
                "future": sum(value is not None for value in (future or [])),
            }
        )
        covariates.append(
            {
                "key": key_of(item, source.unit if source else None),
                "history": past,
                "future": future,
                "received_at": receipt,
            }
        )
    identity = key_of(
        config["target"], target.unit, target.mode, config["solar"], config["step_minutes"]
    )
    dataset = {
        "project_id": project_id,
        "series_key": identity,
        "config_key": config_key(config),
        "unit": target.unit or "",
        "timezone": hass.config.time_zone,
        "step_minutes": config["step_minutes"],
        "cutoff": cutoff,
        "horizon": horizon,
        "target": targets,
        "covariates": covariates,
        "solar": {
            "kind": "energy" if target.counter else "power",
            "latitude": hass.config.latitude,
            "longitude": hass.config.longitude,
        }
        if config["solar"]
        else None,
    }
    preview = {
        "actual": [
            {"start": start + index * step, "value": targets[index]}
            for index in range(max(0, len(targets) - 172800 // step), len(targets))
        ],
        "unit": target.unit or "",
        "step_minutes": config["step_minutes"],
        "timezone": hass.config.time_zone,
        "cutoff": cutoff,
        "coverage": {
            "available": sum(value is not None for value in targets),
            "requested": len(targets),
        },
        "inputs": coverage,
        "warnings": warnings,
    }
    return dataset, preview
