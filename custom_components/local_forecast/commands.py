"""Home Assistant actions and authenticated Lab/card commands."""

import probatio as vol
from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.config_entries import SOURCE_IMPORT
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse, callback
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError, Unauthorized
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.service import async_register_admin_service

from .client import EngineError
from .const import DOMAIN, MODELS
from .dataset import MIN_QUARTER_HOUR_OBSERVATIONS, build_dataset, key_of, quarter_hour_available
from .project import display_project, validate_project
from .runtime import DomainData, Project

SERVICE_SCHEMA = vol.Schema({vol.Required("entity_id"): cv.entity_id})
INTERVAL_ERROR = (
    f"The target needs {MIN_QUARTER_HOUR_OBSERVATIONS} observed 15-minute intervals. "
    "Preview the history or choose hourly forecasts."
)


def state_of(hass: HomeAssistant) -> DomainData:
    return hass.data[DOMAIN]


def project_for_entity(hass: HomeAssistant, entity_id: str) -> Project:
    registry_entry = er.async_get(hass).async_get(entity_id)
    if registry_entry and registry_entry.platform == DOMAIN:
        if project := state_of(hass).projects.get(registry_entry.config_entry_id):
            return project
    raise ValueError("Select a Local Forecast sensor")


def require_read(user, project: Project, entity_id: str) -> None:
    if user is None or not all(
        user.permissions.check_entity(entity, POLICY_READ) for entity in (entity_id, project.target)
    ):
        raise Unauthorized


@callback
def async_register(hass: HomeAssistant) -> None:
    async def refresh(call: ServiceCall) -> None:
        try:
            project = project_for_entity(hass, call.data["entity_id"])
            if not project.enabled:
                raise ValueError("Enable publishing in Forecast Lab before refreshing this project")
            project.refresh()
        except ValueError as error:
            raise HomeAssistantError(str(error)) from error

    async def get_forecast(call: ServiceCall) -> dict:
        try:
            project = project_for_entity(hass, call.data["entity_id"])
        except ValueError as error:
            raise HomeAssistantError(str(error)) from error
        if call.context.user_id:
            user = await hass.auth.async_get_user(call.context.user_id)
            require_read(user, project, call.data["entity_id"])
        result = project.public_result()
        if not project.usable:
            result["forecast"] = None
        return result

    async_register_admin_service(hass, DOMAIN, "refresh", refresh, SERVICE_SCHEMA)
    hass.services.async_register(
        DOMAIN,
        "get_forecast",
        get_forecast,
        SERVICE_SCHEMA,
        SupportsResponse.ONLY,
    )
    websocket_api.async_register_command(hass, card_data)
    websocket_api.async_register_command(hass, lab)


@websocket_api.websocket_command(
    {
        "type": "local_forecast/card",
        vol.Required("entity_id"): cv.entity_id,
    }
)
@websocket_api.async_response
async def card_data(hass, connection, msg):
    try:
        project = project_for_entity(hass, msg["entity_id"])
        require_read(connection.user, project, msg["entity_id"])
    except ValueError as error:
        connection.send_error(msg["id"], "not_found", str(error))
        return
    result = project.public_result()
    result["name"] = project.settings["name"]
    result["error"] = None  # Administrative diagnostics stay in the Lab.
    result["warnings"] = []
    if not project.usable:
        result["forecast"] = None
    connection.send_result(msg["id"], result)


def describe(hass: HomeAssistant, project: Project) -> dict:
    return {
        "id": project.id,
        "engine_entry_id": project.entry.data["engine_entry_id"],
        "settings": display_project(hass, project.settings),
        "entity_id": er.async_get(hass).async_get_entity_id("sensor", DOMAIN, f"{project.id}_next"),
        **project.public_result(),
    }


def required(message: dict, key: str):
    if key not in message:
        raise ValueError(f"Missing {key}")
    return message[key]


def analysis_settings(hass: HomeAssistant, msg: dict) -> dict:
    return validate_project(hass, {**required(msg, "project"), "name": "Quick analysis"})


async def lab_operation(hass: HomeAssistant, msg: dict, user_id: str):
    state = state_of(hass)
    op = msg["operation"]
    project_id = msg.get("project_id")
    project = state.projects.get(project_id)
    if op == "list":
        return {
            "engines": [
                {"id": entry.entry_id, "name": entry.title}
                for entry in hass.config_entries.async_entries(DOMAIN)
                if entry.entry_id in state.engines
            ],
            "projects": [describe(hass, project) for project in state.projects.values()],
            "solar_entries": [
                {"id": entry.entry_id, "name": entry.title}
                for entry in hass.config_entries.async_entries("forecast_solar")
            ],
        }
    if op == "project":
        if not project:
            raise ValueError("Project is not loaded")
        return describe(hass, project)
    if op == "save":
        config = validate_project(hass, required(msg, "project"))
        if config["step_minutes"] == 15 and not await quarter_hour_available(hass, config):
            raise ValueError(INTERVAL_ERROR)
        if project_id:
            if not project:
                raise ValueError("Project is not loaded")
            hass.config_entries.async_update_entry(
                project.entry,
                title=config["name"],
                data={**project.entry.data, "project": config},
            )
            if not await hass.config_entries.async_reload(project_id):
                raise ValueError(
                    "Project settings were saved, but Home Assistant could not reload the project"
                )
            return {"id": project_id}
        engine_id = required(msg, "engine_entry_id")
        if engine_id not in state.engines:
            raise ValueError("Pair an engine in Settings → Devices & services")
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": SOURCE_IMPORT},
            data={"project": config, "engine_entry_id": engine_id},
        )
        if result["type"] != FlowResultType.CREATE_ENTRY:
            raise ValueError("Home Assistant could not create the project")
        return {"id": result["result"].entry_id}
    if op == "delete":
        if not project:
            raise ValueError("Project is not loaded")
        await hass.config_entries.async_remove(project.id)
        return None
    if op == "enable":
        if not project:
            raise ValueError("Project is not loaded")
        enabled = required(msg, "enabled")
        config = {**project.settings, "enabled": enabled}
        hass.config_entries.async_update_entry(
            project.entry, data={**project.entry.data, "project": config}
        )
        project.settings = config
        if enabled:
            project.refresh()
        elif project.task and not project.task.done():
            project.task.cancel()
        project.notify()
        return describe(hass, project)
    if op == "preview":
        config = analysis_settings(hass, msg)
        _, preview = await build_dataset(hass, project_id or "preview", config)
        supported = (
            preview["coverage"]["available"] >= MIN_QUARTER_HOUR_OBSERVATIONS
            if config["step_minutes"] == 15
            else await quarter_hour_available(hass, config)
        )
        return {**preview, "quarter_hour_available": supported}
    engine_id = project.entry.data["engine_entry_id"] if project else msg.get("engine_entry_id")
    engine = state.engines.get(engine_id)
    if engine is None:
        raise ValueError("The paired engine is not loaded")
    if op == "models":
        return await engine.request("GET", "/models")
    if op == "install":
        return await engine.request("POST", f"/models/{required(msg, 'model')}/install")
    if op in {"job", "cancel"}:
        return await engine.request(
            "DELETE" if op == "cancel" else "GET", f"/jobs/{required(msg, 'job_id')}"
        )
    if project is None and (project_id or op in {"accuracy", "evaluation"}):
        raise ValueError("Project is not loaded")
    if op == "accuracy":
        return await engine.request("GET", f"/projects/{project.id}/accuracy")
    if op == "evaluation":
        result = await engine.request("GET", f"/projects/{project.id}/backtest")
        return result if result and result.get("config_key") == project.key else None
    if project is None:
        config = analysis_settings(hass, msg)
        # Reuse this administrator's recorded samples across quick runs on the same target.
        dataset_id = "quick-" + key_of(engine_id, user_id, config["target"])
    else:
        config = project.settings
        dataset_id = project.id
    use_inputs = msg.get("use_inputs", True)
    dataset, preview = await build_dataset(
        hass,
        dataset_id,
        config,
        with_future=op == "run" and use_inputs,
    )
    if project is None and config["step_minutes"] == 15 and (
        preview["coverage"]["available"] < MIN_QUARTER_HOUR_OBSERVATIONS
    ):
        raise ValueError(INTERVAL_ERROR)
    if op == "run":
        return {
            **await engine.request(
                "POST",
                "/forecasts",
                {
                    "dataset": dataset,
                    "model": msg.get("model", config["model"]),
                    "use_inputs": use_inputs,
                    "publish": False,
                },
            ),
            "preview": preview,
        }
    return await engine.request(
        "POST",
        "/backtests",
        {
            "dataset": dataset,
            "variants": required(msg, "variants"),
            "folds": msg.get("folds", 5),
        },
    )


@websocket_api.websocket_command(
    {
        "type": "local_forecast/lab",
        vol.Required("operation"): vol.In(
            (
                "list",
                "project",
                "save",
                "delete",
                "enable",
                "preview",
                "models",
                "install",
                "job",
                "cancel",
                "accuracy",
                "evaluation",
                "run",
                "backtest",
            )
        ),
        vol.Optional("project_id"): vol.Match(r"^[A-Za-z0-9_-]{1,80}$"),
        vol.Optional("engine_entry_id"): vol.Match(r"^[A-Za-z0-9_-]{1,80}$"),
        vol.Optional("project"): dict,
        vol.Optional("enabled"): bool,
        vol.Optional("model"): vol.In(MODELS),
        vol.Optional("job_id"): vol.Match(r"^[a-f0-9]{32}$"),
        vol.Optional("use_inputs"): bool,
        vol.Optional("folds"): vol.All(int, vol.Range(min=1, max=10)),
        vol.Optional("variants"): vol.All(
            [
                {
                    vol.Required("model"): vol.In(MODELS),
                    vol.Optional("use_inputs", default=True): bool,
                },
            ],
            vol.Length(min=1, max=10),
        ),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def lab(hass, connection, msg):
    try:
        result = await lab_operation(hass, msg, connection.user.id)
    except (EngineError, HomeAssistantError, ValueError, vol.Invalid) as error:
        connection.send_error(msg["id"], "local_forecast_error", str(error))
        return
    connection.send_result(msg["id"], result)
