"""Read recorder history and normalize it onto an interval grid."""

from dataclasses import dataclass
from datetime import UTC, datetime
from math import isfinite

from homeassistant.components.recorder import history, statistics
from homeassistant.core import HomeAssistant, State

from .project import convert

Number = float | None


def number(value, *, binary: bool = False) -> Number:
    if binary and value in ("on", "off"):
        return float(value == "on")
    try:
        result = float(value)
    except TypeError, ValueError, OverflowError:
        return None
    return result if isfinite(result) else None


def utc(stamp: float) -> datetime:
    return datetime.fromtimestamp(stamp, UTC)


@dataclass(frozen=True)
class Source:
    entity_id: str
    unit: str | None
    mode: str = "measurement"
    attribute: str = ""
    unit_attribute: str = "unit_of_measurement"
    binary: bool = False

    @property
    def counter(self) -> bool:
        return self.mode != "measurement"

    def read(self, state: State) -> Number:
        value = number(
            state.attributes.get(self.attribute) if self.attribute else state.state,
            binary=self.binary,
        )
        if value is None:
            return None
        if self.attribute and state.state in {"unavailable", "unknown"}:
            return None
        unit = state.attributes.get(self.unit_attribute) if self.unit_attribute else None
        return convert(value, unit, self.unit)


def raw_buckets(
    states: list[State], source: Source, start: int, end: int, step: int
) -> list[Number]:
    count = (end - start) // step
    sums, coverage = [0.0] * count, [0.0] * count
    samples = [
        (state.last_updated.timestamp(), source.read(state), state.attributes.get("last_reset"))
        for state in states
    ]
    for index, (stamp, value, reset) in enumerate(samples):
        if value is None or stamp >= end:
            continue
        next_stamp = samples[index + 1][0] if index + 1 < len(samples) else end
        if source.counter and index and stamp >= start:
            previous_stamp, previous, previous_reset = samples[index - 1]
            if previous is not None and previous_stamp <= stamp:
                if reset is not None and previous_reset != reset:
                    delta = 0.0
                elif source.mode == "increasing" and value < previous:
                    delta = max(value, 0.0)
                else:
                    delta = value - previous
                sums[int(stamp - start) // step] += delta
        position = max(stamp, start)
        stop = min(next_stamp, end)
        while position < stop:
            slot = int(position - start) // step
            until = min(stop, start + (slot + 1) * step)
            duration = until - position
            coverage[slot] += duration
            if not source.counter:
                sums[slot] += value * duration
            position = until
    return [
        (amount if source.counter else amount / step) if seconds >= step - 0.0001 else None
        for amount, seconds in zip(sums, coverage, strict=True)
    ]


def stat_buckets(
    rows: list[dict], source: Source, unit: str | None, period: int, start: int, end: int, step: int
) -> list[Number]:
    values: dict[int, float] = {}
    previous = None
    for row in rows:
        stamp = int(row["start"])
        if source.counter:
            value = number(row.get("change")) if previous == stamp - period else None
            previous = stamp if row.get("sum") is not None else None
        else:
            value = number(row.get("mean"))
        if value is not None and (converted := convert(value, unit, source.unit)) is not None:
            values[stamp] = converted
    result = []
    for slot in range(start, end, step):
        cells = [values.get(stamp) for stamp in range(slot, slot + step, period)]
        if any(cell is None for cell in cells):
            result.append(None)
        else:
            result.append(sum(cells) if source.counter else sum(cells) / len(cells))
    return result


def read_history(
    hass: HomeAssistant, sources: list[Source], start: int, end: int, step: int, keep_days: int
) -> dict[Source, list[Number]]:
    """Called on the recorder executor. Query detailed history in day-sized chunks."""
    result = {source: [None] * ((end - start) // step) for source in sources}
    if not result:
        return result
    ids = {source.entity_id for source in result if not source.attribute}
    meta = statistics.get_metadata(hass, statistic_ids=ids) if ids else {}
    raw_start = max(start, end - keep_days * 86400)

    def add_statistics(period_name, period_seconds: int, begin: int) -> None:
        eligible = {
            source.entity_id
            for source, values in result.items()
            if not source.attribute
            and source.entity_id in meta
            and any(value is None for value in values[(begin - start) // step :])
        }
        if not eligible:
            return
        rows = statistics.statistics_during_period(
            hass,
            utc(begin - period_seconds),
            utc(end),
            eligible,
            period_name,
            None,
            {"mean", "sum", "change"},
        )
        offset = (begin - start) // step
        for source, values in result.items():
            if source.attribute or source.entity_id not in rows:
                continue
            info = meta[source.entity_id][1]
            unit = statistics.get_display_unit(
                hass, source.entity_id, info["unit_class"], info["unit_of_measurement"]
            )
            for index, value in enumerate(
                stat_buckets(
                    rows[source.entity_id], source, unit, period_seconds, begin, end, step
                ),
                start=offset,
            ):
                if values[index] is None and value is not None:
                    values[index] = value

    if step == 3600:
        add_statistics("hour", 3600, start)
    add_statistics("5minute", 300, raw_start)
    for begin in range(raw_start, end, 86400):
        stop = min(end, begin + 86400)
        lo, hi = (begin - start) // step, (stop - start) // step
        missing = [source for source, values in result.items() if None in values[lo:hi]]
        if not missing:
            continue
        histories = history.get_significant_states(
            hass,
            utc(begin - 1),
            utc(stop),
            list({source.entity_id for source in missing}),
            significant_changes_only=False,
        )
        for source in missing:
            values = result[source]
            raw = raw_buckets(histories.get(source.entity_id, []), source, begin, stop, step)
            for index, value in enumerate(raw, start=lo):
                if values[index] is None:
                    values[index] = value
    return result
