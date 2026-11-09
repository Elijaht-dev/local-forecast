"""Present a published solar forecast relative to the current local day."""

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo


def current_solar(forecast: dict, now: int) -> dict:
    step = forecast["step_minutes"] * 60
    factor = step / 3600 if forecast["unit"] == "W" else 1
    periods = [
        (point["start"], point["value"] * factor)
        for point in forecast["points"]
        if point["value"] is not None and point["start"] + step > now
    ]
    zone = ZoneInfo(forecast["timezone"])
    today = datetime.fromtimestamp(now, zone).date()
    tomorrow = int(datetime.combine(today + timedelta(days=1), time.min, zone).timestamp())
    after = int(datetime.combine(today + timedelta(days=2), time.min, zone).timestamp())

    def sum_period(start: int, end: int) -> dict:
        total, coverage = 0.0, 0
        for stamp, wh in periods:
            duration = max(0, min(stamp + step, end) - max(stamp, start))
            total += wh * duration / step
            coverage += duration
        return {"wh": round(total, 3) if coverage else None, "complete": coverage == end - start}

    peak = max(periods, key=lambda period: period[1], default=None)
    return {
        "wh_hours": forecast["solar"]["wh_hours"],
        "today_remaining": sum_period(now, tomorrow),
        "tomorrow": sum_period(tomorrow, after),
        "peak": {"start": peak[0], "watts": round(peak[1] * 3600 / step, 3)} if peak else None,
    }
