"""Project settings and stable references to HA entities."""

from copy import deepcopy

import probatio as vol
from homeassistant.core import HomeAssistant, valid_entity_id
from homeassistant.helpers import entity_registry as er
from homeassistant.util.unit_conversion import EnergyConverter, PowerConverter, TemperatureConverter

from .const import DEFAULT_PROJECT, DOMAIN, MODELS, WEATHER_FIELDS


def entity_ref(hass: HomeAssistant, value: str, *, required: bool = True) -> str:
    if not value and not required:
        return ""
    registry_entry = er.async_get(hass).async_get(value)
    if registry_entry:
        if registry_entry.platform == DOMAIN:
            raise ValueError("Select a measured entity instead of a Local Forecast output")
        return registry_entry.id
    if not valid_entity_id(value) or hass.states.get(value) is None:
        raise ValueError(f"Entity {value!r} was not found")
    return value


def resolve(hass: HomeAssistant, ref: str) -> str:
    if not ref:
        return ""
    item = er.async_get(hass).async_get(ref)
    return item.entity_id if item else ref


INPUT = vol.Schema(
    {
        vol.Required("kind"): vol.In(("history", "weather", "solar", "attribute")),
        vol.Optional("entity", default=""): str,
        vol.Optional("entry_id", default=""): str,
        vol.Optional("attribute", default=""): str,
        vol.Optional("field", default="temperature"): str,
        vol.Optional("history_entity", default=""): str,
        vol.Optional("timestamp_key", default="datetime"): str,
        vol.Optional("value_key", default="value"): str,
    }
)
PROJECT = vol.Schema(
    {
        vol.Required("name"): vol.All(str, vol.Length(min=1, max=80)),
        vol.Required("target"): str,
        vol.Required("model"): vol.In(MODELS),
        vol.Required("step_minutes"): vol.In((15, 60)),
        vol.Required("horizon_hours"): vol.All(int, vol.Range(min=1, max=168)),
        vol.Required("history_days"): vol.All(int, vol.Range(min=1, max=90)),
        vol.Required("refresh_minutes"): vol.All(int, vol.Range(min=15, max=1440)),
        vol.Required("mode"): vol.In(("auto", "measurement", "counter")),
        vol.Required("solar"): bool,
        vol.Required("enabled"): bool,
        vol.Required("inputs"): vol.All([INPUT], vol.Length(max=8)),
    }
)


def validate_project(hass: HomeAssistant, raw: dict) -> dict:
    data = PROJECT({**deepcopy(DEFAULT_PROJECT), **raw})
    data["name"] = data["name"].strip()
    if not data["name"]:
        raise ValueError("Enter a project name")
    data["target"] = entity_ref(hass, data["target"])
    target = hass.states.get(resolve(hass, data["target"]))
    if target is None or target.domain == "binary_sensor":
        raise ValueError("Select a numeric target entity")
    if target.state not in {"unknown", "unavailable"}:
        try:
            float(target.state)
        except ValueError as error:
            raise ValueError("Select a numeric target entity") from error
    if data["solar"]:
        unit = target.attributes.get("unit_of_measurement")
        if unit not in EnergyConverter.VALID_UNITS and unit not in PowerConverter.VALID_UNITS:
            raise ValueError("Solar targets need a supported power or energy unit")
    for item in data["inputs"]:
        kind = item["kind"]
        if kind != "solar":
            item["entity"] = entity_ref(hass, item["entity"])
        if item["history_entity"]:
            item["history_entity"] = entity_ref(hass, item["history_entity"])
        if kind == "weather" and (
            not resolve(hass, item["entity"]).startswith("weather.")
            or item["field"] not in WEATHER_FIELDS
        ):
            raise ValueError("Select a weather entity and a supported hourly field")
        if kind == "solar":
            entry = hass.config_entries.async_get_entry(item["entry_id"])
            if not entry or entry.domain != "forecast_solar":
                raise ValueError("Select an existing Forecast.Solar entry")
        if kind == "attribute" and not all(
            item[key] for key in ("attribute", "timestamp_key", "value_key")
        ):
            raise ValueError("Provide the array attribute and the timestamp/value keys")
    if len({tuple(item.items()) for item in data["inputs"]}) != len(data["inputs"]):
        raise ValueError("Remove the duplicate inputs")
    return data


def display_project(hass: HomeAssistant, data: dict) -> dict:
    result = deepcopy(data)
    result["target"] = resolve(hass, data["target"])
    for item in result["inputs"]:
        item["entity"] = resolve(hass, item["entity"])
        item["history_entity"] = resolve(hass, item["history_entity"])
    return result


def convert(value: float, source: str | None, target: str | None) -> float | None:
    if source == target:
        return value
    for converter in (PowerConverter, EnergyConverter, TemperatureConverter):
        if source in converter.VALID_UNITS and target in converter.VALID_UNITS:
            return converter.convert(value, source, target)
    return None
