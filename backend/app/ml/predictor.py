import threading
from pathlib import Path

from app.ml.features import FEATURE_COLUMNS, SENSOR_HISTORY_FEATURES, build_features, build_sensor_features
from app.ml.train import MODEL_PATH

_model_lock = threading.Lock()
_cached_model_path: Path | None = None
_cached_model_mtime_ns: int | None = None
_cached_bundle: dict | None = None


def load_models() -> dict | None:
    global _cached_model_path, _cached_model_mtime_ns, _cached_bundle
    model_path = Path(MODEL_PATH)
    try:
        modification_time = model_path.stat().st_mtime_ns
    except OSError:
        _cached_model_path = None
        _cached_model_mtime_ns = None
        _cached_bundle = None
        return None

    if model_path == _cached_model_path and modification_time == _cached_model_mtime_ns:
        return _cached_bundle

    try:
        import joblib

        with _model_lock:
            bundle = joblib.load(model_path)
        if not isinstance(bundle, dict) or not isinstance(bundle.get("models"), dict):
            return None
        _cached_model_path = model_path
        _cached_model_mtime_ns = modification_time
        _cached_bundle = bundle
        return bundle
    except (ImportError, OSError, ValueError, EOFError, AttributeError, TypeError):
        return None


def predict_temperature(
    bundle: dict,
    horizon_minutes: int,
    readings,
    point: dict,
    safe_min: float,
    safe_max: float,
) -> float | None:
    model_entry = bundle.get("models", {}).get(horizon_minutes)
    if model_entry is None:
        return None
    if isinstance(model_entry, dict):
        model = model_entry.get("estimator")
        model_kind = model_entry.get("model_kind", "weather_aware")
        columns = model_entry.get("features", list(FEATURE_COLUMNS))
    else:
        model = model_entry
        model_kind = "weather_aware"
        columns = bundle.get("features", list(FEATURE_COLUMNS))
    if model is None:
        return None

    if model_kind == "sensor_history":
        features = build_sensor_features(readings)
        columns = columns or list(SENSOR_HISTORY_FEATURES)
    else:
        features = build_features(
            readings,
            point["latitude"],
            point["longitude"],
            point,
            safe_min,
            safe_max,
        )
    if features is None:
        return None
    prediction = float(model.predict([[features[column] for column in columns]])[0])
    return prediction if prediction == prediction and abs(prediction) != float("inf") else None


def risk_for_temperature(temperature: float, safe_min: float, safe_max: float) -> tuple[str, str]:
    if temperature < safe_min or temperature > safe_max:
        return "critical", "Predicted temperature is outside the required medicine range."
    margin = max(0.3, min(0.5, (safe_max - safe_min) * 0.1))
    if temperature <= safe_min + margin or temperature >= safe_max - margin:
        return "warning", "Predicted temperature is approaching a required range limit."
    return "safe", "Predicted temperature remains within the required medicine range."