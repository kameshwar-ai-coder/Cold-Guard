import bisect
import math
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.ml.weather import _distance_km
from app.models.sensor_reading import SensorReading
from app.models.sensor_reading_context import SensorReadingContext
from app.models.shipment import Shipment
from app.models.weather_observation import WeatherObservation

FEATURE_COLUMNS = (
    "current_temperature",
    "previous_temperature",
    "temperature_change",
    "temperature_trend_c_per_minute",
    "humidity",
    "outside_temperature",
    "outside_humidity",
    "apparent_temperature",
    "precipitation",
    "precipitation_probability",
    "wind_speed",
    "weather_code",
    "latitude",
    "longitude",
    "hour",
    "safe_min",
    "safe_max",
)
MIN_TRAINING_SAMPLES = 25
MAX_LOCATION_DISTANCE_KM = 5
TREND_WINDOW_SIZE = 5
TREND_DEADBAND_C = 0.2
SENSOR_HISTORY_FEATURES = (
    "current_temperature",
    "previous_temperature",
    "temperature_change",
    "temperature_trend_c_per_minute",
    "temperature_trend_delta",
    "humidity",
    "hour",
)


def _value(source, key):
    if isinstance(source, dict):
        return source[key]
    return getattr(source, key)


def _trend(readings: list[SensorReading]) -> float | None:
    samples = sorted(readings, key=lambda item: item.recorded_at)[-TREND_WINDOW_SIZE:]
    if len(samples) < 3:
        return None
    times = [(reading.recorded_at - samples[0].recorded_at).total_seconds() / 60 for reading in samples]
    average_time = sum(times) / len(times)
    average_temperature = sum(reading.temperature for reading in samples) / len(samples)
    denominator = sum((value - average_time) ** 2 for value in times)
    if denominator <= 0:
        return None
    return sum(
        (time_value - average_time) * (reading.temperature - average_temperature)
        for time_value, reading in zip(times, samples)
    ) / denominator


def temperature_trend_delta(readings: list[SensorReading]) -> float | None:
    samples = sorted(readings, key=lambda item: item.recorded_at)[-TREND_WINDOW_SIZE:]
    if len(samples) < 3:
        return None
    return samples[-1].temperature - samples[0].temperature


def trend_direction(readings: list[SensorReading]) -> str:
    delta = temperature_trend_delta(readings)
    if delta is None:
        return "unknown"
    if delta > TREND_DEADBAND_C:
        return "rising"
    if delta < -TREND_DEADBAND_C:
        return "falling"
    return "stable"


def build_sensor_features(readings: list[SensorReading]) -> dict | None:
    ordered = sorted(readings, key=lambda item: item.recorded_at)[-TREND_WINDOW_SIZE:]
    if len(ordered) < 3:
        return None
    current = ordered[-1]
    previous = ordered[-2]
    slope = _trend(ordered)
    delta = temperature_trend_delta(ordered)
    if slope is None or delta is None:
        return None
    return {
        "current_temperature": current.temperature,
        "previous_temperature": previous.temperature,
        "temperature_change": current.temperature - previous.temperature,
        "temperature_trend_c_per_minute": slope,
        "temperature_trend_delta": delta,
        "humidity": current.humidity,
        "hour": current.recorded_at.hour,
    }


def build_features(
    readings: list[SensorReading],
    latitude: float,
    longitude: float,
    weather,
    safe_min: float,
    safe_max: float,
) -> dict | None:
    if len(readings) < 2:
        return None
    ordered = sorted(readings, key=lambda item: item.recorded_at)[-8:]
    current = ordered[-1]
    previous = ordered[-2]
    trend = _trend(ordered)
    if trend is None:
        return None
    values = {
        "current_temperature": current.temperature,
        "previous_temperature": previous.temperature,
        "temperature_change": current.temperature - previous.temperature,
        "temperature_trend_c_per_minute": trend,
        "humidity": current.humidity,
        "outside_temperature": _value(weather, "outside_temperature"),
        "outside_humidity": _value(weather, "outside_humidity"),
        "apparent_temperature": _value(weather, "apparent_temperature"),
        "precipitation": _value(weather, "precipitation"),
        "precipitation_probability": _value(weather, "precipitation_probability"),
        "wind_speed": _value(weather, "wind_speed"),
        "weather_code": _value(weather, "weather_code"),
        "latitude": latitude,
        "longitude": longitude,
        "hour": current.recorded_at.hour,
        "safe_min": safe_min,
        "safe_max": safe_max,
    }
    if not all(math.isfinite(float(value)) for value in values.values()):
        return None
    return values


def build_training_rows(db: Session, horizon_minutes: int) -> list[dict]:
    readings = (
        db.query(SensorReading)
        .order_by(SensorReading.device_id, SensorReading.recorded_at, SensorReading.id)
        .all()
    )
    contexts = {
        context.reading_id: context
        for context in db.query(SensorReadingContext).all()
    }
    shipments = {shipment.id: shipment for shipment in db.query(Shipment).all()}
    weather = (
        db.query(WeatherObservation)
        .filter(WeatherObservation.prediction_horizon_minutes == horizon_minutes)
        .order_by(WeatherObservation.fetched_at.desc())
        .all()
    )

    timelines: dict[tuple[str, str], list[SensorReading]] = {}
    for reading in readings:
        context = contexts.get(reading.id)
        if context is not None:
            timelines.setdefault((reading.device_id, context.shipment_id), []).append(reading)

    rows = []
    for (device_id, shipment_id), timeline in timelines.items():
        shipment = shipments.get(shipment_id)
        if shipment is None:
            continue
        timestamps = [reading.recorded_at for reading in timeline]
        shipment_weather = [item for item in weather if item.shipment_id == shipment_id]
        for index, current in enumerate(timeline[:-1]):
            if index < 1:
                continue
            context = contexts[current.id]
            expected_target = current.recorded_at + timedelta(minutes=horizon_minutes)
            target_index = bisect.bisect_left(timestamps, expected_target)
            candidates = [value for value in (target_index - 1, target_index) if value > index and value < len(timeline)]
            if not candidates:
                continue
            target_index = min(candidates, key=lambda value: abs(timestamps[value] - expected_target))
            target_tolerance = timedelta(minutes=max(3, horizon_minutes * 0.2))
            if abs(timestamps[target_index] - expected_target) > target_tolerance:
                continue

            target_context = contexts.get(timeline[target_index].id)
            previous_context = contexts.get(timeline[index - 1].id)
            if (
                target_context is None
                or previous_context is None
                or target_context.shipment_id != shipment_id
                or previous_context.shipment_id != shipment_id
            ):
                continue

            expected_forecast = current.recorded_at + timedelta(minutes=horizon_minutes)
            weather_candidates = []
            for observation in shipment_weather:
                if observation.fetched_at > current.recorded_at:
                    continue
                if abs(observation.forecast_for - expected_forecast) > timedelta(minutes=40):
                    continue
                distance = _distance_km(
                    context.latitude,
                    context.longitude,
                    observation.latitude,
                    observation.longitude,
                )
                if distance <= MAX_LOCATION_DISTANCE_KM:
                    weather_candidates.append((distance, observation))
            if not weather_candidates:
                continue
            weather_candidates.sort(key=lambda item: (item[0], -item[1].fetched_at.timestamp()))
            weather_observation = weather_candidates[0][1]
            features = build_features(
                timeline[max(0, index - 7) : index + 1],
                context.latitude,
                context.longitude,
                weather_observation,
                shipment.temperature_min,
                shipment.temperature_max,
            )
            if features is None:
                continue
            rows.append(
                {
                    "features": features,
                    "target": timeline[target_index].temperature,
                    "target_at": timeline[target_index].recorded_at,
                    "shipment_id": shipment_id,
                    "device_id": device_id,
                    "safe_min": shipment.temperature_min,
                    "safe_max": shipment.temperature_max,
                }
            )
    return sorted(rows, key=lambda row: row["target_at"])


def build_sensor_training_rows(db: Session, horizon_minutes: int) -> list[dict]:
    readings = (
        db.query(SensorReading)
        .order_by(SensorReading.device_id, SensorReading.recorded_at, SensorReading.id)
        .all()
    )
    timelines: dict[str, list[SensorReading]] = {}
    for reading in readings:
        timelines.setdefault(reading.device_id, []).append(reading)

    tolerance = timedelta(minutes=max(2, min(5, horizon_minutes * 0.1)))
    rows = []
    for device_id, timeline in timelines.items():
        timestamps = [reading.recorded_at for reading in timeline]
        for index, current in enumerate(timeline[:-1]):
            expected_target = current.recorded_at + timedelta(minutes=horizon_minutes)
            target_index = bisect.bisect_left(timestamps, expected_target)
            candidates = [
                candidate
                for candidate in (target_index - 1, target_index)
                if candidate > index and candidate < len(timeline)
            ]
            if not candidates:
                continue
            target_index = min(candidates, key=lambda candidate: abs(timestamps[candidate] - expected_target))
            if abs(timestamps[target_index] - expected_target) > tolerance:
                continue
            features = build_sensor_features(timeline[max(0, index - TREND_WINDOW_SIZE + 1) : index + 1])
            if features is None:
                continue
            rows.append(
                {
                    "features": features,
                    "target": timeline[target_index].temperature,
                    "target_at": timeline[target_index].recorded_at,
                    "device_id": device_id,
                    "source": "sensor_history",
                }
            )
    return sorted(rows, key=lambda row: row["target_at"])