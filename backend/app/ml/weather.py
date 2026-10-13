import json
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from sqlalchemy.orm import Session

from app.models.shipment import Shipment
from app.models.weather_observation import WeatherObservation

HORIZONS = (15, 30, 60)
CACHE_SECONDS = 900
FORECAST_TOLERANCE_MINUTES = 40
WEATHER_VARIABLES = (
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "precipitation",
    "precipitation_probability",
    "wind_speed_10m",
    "weather_code",
)
DEMO_ROUTE = (
    {"label": "Chennai", "latitude": 13.0827, "longitude": 80.2707},
    {"label": "Bengaluru", "latitude": 12.9716, "longitude": 77.5946},
    {"label": "Coimbatore", "latitude": 11.0168, "longitude": 76.9558},
)

_weather_cache: dict[tuple[float, float], tuple[float, datetime, dict]] = {}
_cache_lock = threading.Lock()


def as_utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _parse_forecast(payload: dict) -> list[dict]:
    hourly = payload.get("hourly")
    if not isinstance(hourly, dict):
        raise ValueError("Open-Meteo response did not include hourly forecasts")
    times = hourly.get("time")
    if not isinstance(times, list) or not times:
        raise ValueError("Open-Meteo response did not include forecast timestamps")

    fields = {
        "outside_temperature": "temperature_2m",
        "outside_humidity": "relative_humidity_2m",
        "apparent_temperature": "apparent_temperature",
        "precipitation": "precipitation",
        "precipitation_probability": "precipitation_probability",
        "wind_speed": "wind_speed_10m",
        "weather_code": "weather_code",
    }
    arrays = {name: hourly.get(source) for name, source in fields.items()}
    if any(not isinstance(values, list) or len(values) != len(times) for values in arrays.values()):
        raise ValueError("Open-Meteo response is missing required forecast variables")

    samples = []
    for index, time_text in enumerate(times):
        try:
            forecast_for = datetime.fromisoformat(time_text).replace(tzinfo=None)
            values = {name: float(items[index]) for name, items in arrays.items()}
        except (TypeError, ValueError, IndexError):
            continue
        if not all(math.isfinite(value) for value in values.values()):
            continue
        samples.append({"forecast_for": forecast_for, **values})

    return samples


def _select_horizons(samples: list[dict], requested_at: datetime) -> dict[int, dict]:
    result = {}
    for horizon in HORIZONS:
        target = requested_at + timedelta(minutes=horizon)
        if not samples:
            continue
        sample = min(samples, key=lambda item: abs(item["forecast_for"] - target))
        if abs(sample["forecast_for"] - target) <= timedelta(minutes=FORECAST_TOLERANCE_MINUTES):
            result[horizon] = sample
    if not result:
        raise ValueError("No forecast timestamp was close enough to the requested horizon")
    return result


def _fetch_point(latitude: float, longitude: float, now: datetime) -> tuple[datetime, dict, bool]:
    cache_key = (round(latitude, 3), round(longitude, 3))
    with _cache_lock:
        cached = _weather_cache.get(cache_key)
        if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
            return cached[1], _select_horizons(cached[2], now), False

    parameters = urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "hourly": ",".join(WEATHER_VARIABLES),
            "forecast_days": 2,
            "timezone": "UTC",
        }
    )
    request = Request(
        f"https://api.open-meteo.com/v1/forecast?{parameters}",
        headers={"User-Agent": "ColdGuard/1.0 (cold-chain forecast service)"},
    )
    with urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Open-Meteo returned an invalid response")
    fetched_at = as_utc_naive(now)
    samples = _parse_forecast(payload)
    forecasts = _select_horizons(samples, fetched_at)
    with _cache_lock:
        _weather_cache[cache_key] = (time.monotonic(), fetched_at, samples)
    return fetched_at, forecasts, True


def route_points(shipment: Shipment | None) -> list[dict]:
    if shipment is None:
        return [dict(point) for point in DEMO_ROUTE]

    origin = (shipment.origin_latitude, shipment.origin_longitude)
    destination = (shipment.destination_latitude, shipment.destination_longitude)
    chennai = (13.0827, 80.2707)
    coimbatore = (11.0168, 76.9558)
    if _distance_km(*origin, *chennai) <= 35 and _distance_km(*destination, *coimbatore) <= 35:
        return [dict(point) for point in DEMO_ROUTE]

    return [
        {"label": shipment.origin_label, "latitude": origin[0], "longitude": origin[1]},
        {
            "label": "Route midpoint",
            "latitude": (origin[0] + destination[0]) / 2,
            "longitude": (origin[1] + destination[1]) / 2,
        },
        {"label": shipment.destination_label, "latitude": destination[0], "longitude": destination[1]},
    ]


def _distance_km(latitude_a: float, longitude_a: float, latitude_b: float, longitude_b: float) -> float:
    latitude_delta = math.radians(latitude_b - latitude_a)
    longitude_delta = math.radians(longitude_b - longitude_a)
    distance = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(math.radians(latitude_a))
        * math.cos(math.radians(latitude_b))
        * math.sin(longitude_delta / 2) ** 2
    )
    return 6371 * 2 * math.atan2(math.sqrt(distance), math.sqrt(1 - distance))


def _weather_condition(code: float) -> str:
    weather_code = int(code)
    if weather_code == 0:
        return "Clear"
    if weather_code in (1, 2, 3):
        return "Partly cloudy"
    if weather_code in (45, 48):
        return "Fog"
    if 51 <= weather_code <= 67 or 80 <= weather_code <= 82:
        return "Rain"
    if 71 <= weather_code <= 77 or weather_code in (85, 86):
        return "Snow"
    if 95 <= weather_code <= 99:
        return "Thunderstorm"
    return "Unknown"


def get_route_forecasts(
    db: Session,
    shipment: Shipment,
    points: list[dict],
    now: datetime,
    horizon_minutes: int,
) -> list[dict]:
    unique_points = []
    seen = set()
    for point in points:
        key = (round(point["latitude"], 3), round(point["longitude"], 3))
        if key not in seen:
            seen.add(key)
            unique_points.append(point)

    def fetch(point: dict):
        try:
            fetched_at, forecasts, is_fresh = _fetch_point(point["latitude"], point["longitude"], now)
            return point, fetched_at, forecasts, is_fresh, None
        except (URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as error:
            return point, None, {}, False, str(error)

    with ThreadPoolExecutor(max_workers=min(4, len(unique_points) or 1)) as executor:
        fetched_points = list(executor.map(fetch, unique_points))

    result = []
    pending_records = []
    for point, fetched_at, forecasts, is_fresh, error in fetched_points:
        selected = forecasts.get(horizon_minutes)
        if selected:
            if is_fresh:
                pending_records.extend(
                WeatherObservation(
                    shipment_id=shipment.id,
                    location_label=point["label"],
                    latitude=point["latitude"],
                    longitude=point["longitude"],
                    fetched_at=as_utc_naive(fetched_at),
                    forecast_for=sample["forecast_for"],
                    prediction_horizon_minutes=horizon,
                    outside_temperature=sample["outside_temperature"],
                    outside_humidity=sample["outside_humidity"],
                    apparent_temperature=sample["apparent_temperature"],
                    precipitation=sample["precipitation"],
                    precipitation_probability=sample["precipitation_probability"],
                    wind_speed=sample["wind_speed"],
                    weather_code=sample["weather_code"],
                )
                for horizon, sample in forecasts.items()
                )
            result.append(
                {
                    **point,
                    **selected,
                    "weather_condition": _weather_condition(selected["weather_code"]),
                    "fetched_at": fetched_at.isoformat() + "Z",
                    "forecast_available": True,
                }
            )
        else:
            result.append({**point, "forecast_available": False, "error": error or "Forecast unavailable"})

    if pending_records:
        try:
            db.add_all(pending_records)
            db.commit()
        except Exception:
            db.rollback()

    return result