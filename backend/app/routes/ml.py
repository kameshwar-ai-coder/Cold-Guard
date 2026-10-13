from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.ml.features import _trend, temperature_trend_delta, trend_direction
from app.ml.predictor import load_models, predict_temperature, risk_for_temperature
from app.ml.train import train_models
from app.ml.weather import get_route_forecasts, route_points
from app.models.sensor_reading import SensorReading
from app.models.sensor_reading_context import SensorReadingContext
from app.models.shipment import Shipment
from app.models.user import User
from app.security import get_current_user, get_db

router = APIRouter(prefix="/api/ml", tags=["ML temperature prediction"])


def require_transport(user: User) -> None:
    if user.role != "transport":
        raise HTTPException(status_code=403, detail="Only Transport users can train the model")


def _current_shipment(db: Session, user: User) -> Shipment | None:
    if user.role == "pharmacy":
        owner_filter = Shipment.pharmacy_user_id == user.id
    else:
        owner_filter = Shipment.created_by_user_id == user.id
    return (
        db.query(Shipment)
        .filter(owner_filter, Shipment.status == "pending")
        .order_by(Shipment.created_at.asc(), Shipment.id.asc())
        .first()
    )


@router.post("/train")
def train(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_transport(current_user)
    return train_models(db)


@router.get("/prediction")
def prediction(
    horizon_minutes: int = Query(default=30, ge=15, le=60),
    device_id: str | None = Query(default=None, max_length=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if horizon_minutes not in (15, 30, 60):
        raise HTTPException(status_code=422, detail="Prediction horizon must be 15, 30, or 60 minutes")

    shipment = _current_shipment(db, current_user)
    if shipment is None:
        return {
            "model_available": False,
            "prediction_available": False,
            "message": "No active shipment is available for prediction.",
            "route_weather": [],
        }

    readings_query = db.query(SensorReading)
    if device_id:
        readings_query = readings_query.filter(SensorReading.device_id == device_id)
    recent = readings_query.order_by(SensorReading.recorded_at.desc(), SensorReading.id.desc()).limit(8).all()
    recent.reverse()
    current = recent[-1] if recent else None
    context = (
        db.query(SensorReadingContext).filter(SensorReadingContext.reading_id == current.id).first()
        if current is not None
        else None
    )
    points = route_points(shipment)
    if context is not None:
        points.append(
            {
                "label": "Current sensor location",
                "latitude": context.latitude,
                "longitude": context.longitude,
            }
        )

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    route_weather = get_route_forecasts(db, shipment, points, now, horizon_minutes)
    weather_available = bool(route_weather) and all(point.get("forecast_available") for point in route_weather)
    if current is None:
        return {
            "model_available": False,
            "prediction_available": False,
            "shipment_id": shipment.id,
            "safe_min": shipment.temperature_min,
            "safe_max": shipment.temperature_max,
            "weather_available": weather_available,
            "route_weather": route_weather,
            "message": "ML prediction unavailable — waiting for a current sensor reading.",
        }

    bundle = load_models()
    model_entry = bundle.get("models", {}).get(horizon_minutes) if bundle else None
    model = model_entry is not None
    model_kind = (
        model_entry.get("model_kind", "weather_aware")
        if isinstance(model_entry, dict)
        else "weather_aware"
    )
    model_evaluation = bundle.get("evaluation", {}).get(str(horizon_minutes), {}) if bundle else {}
    slope = _trend(recent)
    trend_delta = temperature_trend_delta(recent)
    trend = trend_direction(recent)
    if trend == "unknown":
        trend = "insufficient_data"
    current_risk, current_risk_message = risk_for_temperature(
        current.temperature,
        shipment.temperature_min,
        shipment.temperature_max,
    )
    trend_estimate = (
        round(current.temperature + slope * horizon_minutes, 1)
        if model_kind == "sensor_history" and slope is not None
        else None
    )

    response = {
        "model_available": model,
        "prediction_available": False,
        "shipment_id": shipment.id,
        "device_id": current.device_id,
        "current_temperature": current.temperature,
        "current_humidity": current.humidity,
        "prediction_horizon_minutes": horizon_minutes,
        "safe_min": shipment.temperature_min,
        "safe_max": shipment.temperature_max,
        "temperature_trend": trend,
        "temperature_trend_delta": round(trend_delta, 3) if trend_delta is not None else None,
        "trend_estimate_temperature": trend_estimate,
        "standard_current_risk": current_risk.upper(),
        "standard_current_risk_message": current_risk_message,
        "weather_available": weather_available,
        "route_weather": route_weather,
    }
    if not model:
        response["reason"] = "No trained model is available for this horizon."
        response["message"] = "ML model not trained. Run POST /api/ml/train; legacy sensor history can train a sensor-history model without invented GPS or weather."
        return response
    if len(recent) < 2 or slope is None:
        response["reason"] = "At least three recent timestamped readings are required."
        response["message"] = "ML prediction unavailable — at least three timestamped readings are required."
        return response
    if model_kind == "weather_aware" and not weather_available:
        response["reason"] = "Weather-aware model requires a valid forecast."
        response["message"] = "Weather forecast unavailable for this weather-aware model. Standard current risk remains active."
        return response

    predictions = []
    for point in route_weather:
        temperature = predict_temperature(
            bundle,
            horizon_minutes,
            recent,
            point,
            shipment.temperature_min,
            shipment.temperature_max,
        )
        if temperature is None:
            continue
        risk, risk_message = risk_for_temperature(temperature, shipment.temperature_min, shipment.temperature_max)
        predictions.append(
            {
                "location_label": point["label"],
                "predicted_temperature": temperature,
                "risk": risk.upper(),
                "risk_message": risk_message,
            }
        )

    if len(predictions) != len(route_weather):
        response["reason"] = "Model prediction could not be calculated for every route point."
        response["message"] = "ML prediction unavailable — current readings do not contain all required model features."
        return response

    severity = {"SAFE": 0, "WARNING": 1, "CRITICAL": 2}
    highest_risk = max(predictions, key=lambda item: severity[item["risk"]])
    response.update(
        {
            "prediction_available": True,
            "model_kind": model_kind,
            "reason": None,
            "predicted_temperature": highest_risk["predicted_temperature"],
            "risk": highest_risk["risk"],
            "ml_risk": highest_risk["risk"],
            "current_risk": current_risk.upper(),
            "model_evaluation": {
                "mae": model_evaluation.get("mae"),
                "rmse": model_evaluation.get("rmse"),
                "r2": model_evaluation.get("r2"),
                "test_samples": model_evaluation.get("test_samples"),
            },
            "prediction_source": (
                "Historical sensor temperature, humidity, and trend; historical weather was unavailable during training."
                if model_kind == "sensor_history"
                else "Historical sensor and weather observations."
            ),
            "message": (
                highest_risk["risk_message"]
                if model_evaluation.get("r2") is None or model_evaluation["r2"] >= 0
                else highest_risk["risk_message"]
                + " Warning: this model scored below a mean-only baseline on chronological holdout data; treat the ML estimate as experimental."
            ),
            "route_predictions": predictions,
        }
    )
    return response