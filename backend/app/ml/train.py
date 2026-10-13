import math
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from app.ml.features import (
    FEATURE_COLUMNS,
    MIN_TRAINING_SAMPLES,
    SENSOR_HISTORY_FEATURES,
    build_sensor_training_rows,
    build_training_rows,
)

MODEL_PATH = Path(__file__).with_name("model.joblib")
TEST_FRACTION = 0.2


def train_models(db: Session) -> dict:
    try:
        import joblib
        from sklearn.ensemble import RandomForestRegressor
        from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    except ImportError as error:
        return {"status": "unavailable", "message": f"ML dependencies are unavailable: {error}"}

    models = {}
    horizon_results = {}
    for horizon in (15, 30, 60):
        weather_rows = build_training_rows(db, horizon)
        if len(weather_rows) >= MIN_TRAINING_SAMPLES:
            rows = weather_rows
            feature_columns = FEATURE_COLUMNS
            model_kind = "weather_aware"
        else:
            rows = build_sensor_training_rows(db, horizon)
            feature_columns = SENSOR_HISTORY_FEATURES
            model_kind = "sensor_history"
        sample_count = len(rows)
        if sample_count < MIN_TRAINING_SAMPLES:
            horizon_results[str(horizon)] = {
                "status": "insufficient_data",
                "training_samples": sample_count,
                "data_source": model_kind,
                "minimum_training_samples": MIN_TRAINING_SAMPLES,
                "message": "Insufficient data for model evaluation.",
            }
            continue

        split_index = math.floor(sample_count * (1 - TEST_FRACTION))
        train_rows = rows[:split_index]
        test_rows = rows[split_index:]
        if len(train_rows) < 2 or len(test_rows) < 2:
            horizon_results[str(horizon)] = {
                "status": "insufficient_data",
                "training_samples": sample_count,
                "data_source": model_kind,
                "minimum_training_samples": MIN_TRAINING_SAMPLES,
                "message": "Insufficient chronological holdout data for model evaluation.",
            }
            continue

        model = RandomForestRegressor(
            n_estimators=200,
            min_samples_leaf=2,
            random_state=42,
            n_jobs=-1,
        )
        train_x = [[row["features"][column] for column in feature_columns] for row in train_rows]
        train_y = [row["target"] for row in train_rows]
        test_x = [[row["features"][column] for column in feature_columns] for row in test_rows]
        test_y = [row["target"] for row in test_rows]
        model.fit(train_x, train_y)
        predictions = model.predict(test_x)
        scores = {
            "mae": float(mean_absolute_error(test_y, predictions)),
            "rmse": float(math.sqrt(mean_squared_error(test_y, predictions))),
            "r2": float(r2_score(test_y, predictions)),
        }
        horizon_results[str(horizon)] = {
            "status": "success",
            "training_samples": len(train_rows),
            "test_samples": len(test_rows),
            "total_samples": sample_count,
            "data_source": model_kind,
            "features": list(feature_columns),
            **scores,
        }
        models[horizon] = {
            "estimator": model,
            "model_kind": model_kind,
            "features": list(feature_columns),
        }

    if not models:
        return {
            "status": "insufficient_data",
            "message": "Insufficient historical data for ML prediction. Insufficient data for model evaluation.",
            "minimum_training_samples": MIN_TRAINING_SAMPLES,
            "horizons": horizon_results,
        }

    joblib.dump(
        {
            "models": models,
            "evaluation": {
                horizon: result
                for horizon, result in horizon_results.items()
                if result.get("status") == "success"
            },
            "trained_at": datetime.now(timezone.utc).isoformat(),
        },
        MODEL_PATH,
    )
    return {
        "status": "success",
        "horizons": horizon_results,
        "model_saved": True,
    }