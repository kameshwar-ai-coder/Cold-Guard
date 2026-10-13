import unittest
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from pydantic import ValidationError

from app.database import Base
from app.ml.features import build_training_rows, temperature_trend_delta, trend_direction
from app.ml.predictor import load_models, predict_temperature, risk_for_temperature
from app.ml.train import train_models
from app.ml.weather import _select_horizons
from app.schemas.sensor import SensorData
from app.models.device import Device
from app.models.sensor_reading import SensorReading
from app.models.sensor_reading_context import SensorReadingContext
from app.models.shipment import Shipment
from app.models.user import User, UserSession
from app.models.weather_observation import WeatherObservation


class PredictionRiskTests(unittest.TestCase):
    def test_recent_five_readings_drive_rising_falling_and_stable(self):
        started_at = datetime(2026, 1, 1)

        def readings(temperatures):
            return [
                SimpleNamespace(recorded_at=started_at + timedelta(minutes=index), temperature=value)
                for index, value in enumerate(temperatures)
            ]

        rising = readings([5.0, 5.3, 5.7, 6.1, 6.5])
        falling = readings([6.5, 6.1, 5.8, 5.4, 5.0])
        stable = readings([5.2, 5.3, 5.2, 5.3, 5.2])
        self.assertEqual(trend_direction(rising), "rising")
        self.assertEqual(trend_direction(falling), "falling")
        self.assertEqual(trend_direction(stable), "stable")
        self.assertAlmostEqual(temperature_trend_delta(rising), 1.5)

    def test_sensor_context_is_optional_but_must_be_complete(self):
        reading = SensorData(device_id="fridge-001", temperature=4.2, humidity=48.5)
        self.assertIsNone(reading.shipment_id)
        with self.assertRaises(ValidationError):
            SensorData(
                device_id="fridge-001",
                temperature=4.2,
                humidity=48.5,
                shipment_id="shipment-1",
            )

    def test_predicted_temperature_risk_boundaries(self):
        self.assertEqual(risk_for_temperature(5.6, 2, 8)[0], "safe")
        self.assertEqual(risk_for_temperature(7.7, 2, 8)[0], "warning")
        self.assertEqual(risk_for_temperature(8.6, 2, 8)[0], "critical")

    def test_cached_hourly_forecast_is_reselected_for_current_horizon(self):
        samples = [
            {"forecast_for": datetime(2025, 1, 1, 12), "outside_temperature": 30},
            {"forecast_for": datetime(2025, 1, 1, 13), "outside_temperature": 31},
        ]
        first = _select_horizons(samples, datetime(2025, 1, 1, 12, 9))[15]
        later = _select_horizons(samples, datetime(2025, 1, 1, 12, 19))[15]
        self.assertNotEqual(first["forecast_for"], later["forecast_for"])


class TrainingDataTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.session = sessionmaker(bind=self.engine)()

    def tearDown(self):
        self.session.close()
        self.engine.dispose()

    def test_empty_database_reports_insufficient_data_without_metrics(self):
        result = train_models(self.session)
        self.assertEqual(result["status"], "insufficient_data")
        self.assertEqual(set(result["horizons"]), {"15", "30", "60"})
        self.assertTrue(all("mae" not in item for item in result["horizons"].values()))

    def test_sensor_history_model_trains_and_predicts_without_weather_context(self):
        started_at = datetime(2026, 1, 1)
        self.session.add_all(
            [
                SensorReading(
                    device_id="legacy-device",
                    temperature=4 + index * 0.01 + (index % 12) * 0.015,
                    humidity=45 + index % 5,
                    recorded_at=started_at + timedelta(minutes=index),
                )
                for index in range(150)
            ]
        )
        self.session.commit()

        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "sensor-model.joblib"
            with (
                patch("app.ml.train.MODEL_PATH", model_path),
                patch("app.ml.predictor.MODEL_PATH", model_path),
            ):
                result = train_models(self.session)
                bundle = load_models()
                readings = (
                    self.session.query(SensorReading)
                    .order_by(SensorReading.recorded_at.desc())
                    .limit(8)
                    .all()
                )
                readings.reverse()
                predicted = predict_temperature(bundle, 30, readings, {}, 2, 8)

        self.assertEqual(result["status"], "success")
        self.assertTrue(all(result["horizons"][str(horizon)]["data_source"] == "sensor_history" for horizon in (15, 30, 60)))
        self.assertIsNotNone(predicted)

    def test_training_uses_timestamp_aligned_samples_and_saves_models(self):
        transport = User(name="Transport", email="transport@example.test", password_hash="test", role="transport")
        pharmacy = User(name="Pharmacy", email="pharmacy@example.test", password_hash="test", role="pharmacy")
        self.session.add_all([transport, pharmacy])
        self.session.flush()
        shipment = Shipment(
            id="test-shipment",
            origin_label="Chennai",
            origin_latitude=13.0827,
            origin_longitude=80.2707,
            destination_label="Coimbatore",
            destination_latitude=11.0168,
            destination_longitude=76.9558,
            temperature_min=2,
            temperature_max=8,
            created_by_user_id=transport.id,
            pharmacy_user_id=pharmacy.id,
        )
        self.session.add(shipment)
        self.session.flush()

        started_at = datetime(2025, 1, 1)
        for index in range(100):
            recorded_at = started_at + timedelta(minutes=index)
            reading = SensorReading(
                device_id="test-device",
                temperature=4 + index * 0.005,
                humidity=55,
                recorded_at=recorded_at,
            )
            self.session.add(reading)
            self.session.flush()
            self.session.add(
                SensorReadingContext(
                    reading_id=reading.id,
                    shipment_id=shipment.id,
                    latitude=13.0827,
                    longitude=80.2707,
                )
            )
            for horizon in (15, 30, 60):
                self.session.add(
                    WeatherObservation(
                        shipment_id=shipment.id,
                        location_label="Test location",
                        latitude=13.0827,
                        longitude=80.2707,
                        fetched_at=recorded_at - timedelta(seconds=1),
                        forecast_for=recorded_at + timedelta(minutes=horizon),
                        prediction_horizon_minutes=horizon,
                        outside_temperature=32 + index * 0.01,
                        outside_humidity=60,
                        apparent_temperature=34,
                        precipitation=0,
                        precipitation_probability=0,
                        wind_speed=8,
                        weather_code=0,
                    )
                )
        self.session.commit()

        self.assertGreaterEqual(len(build_training_rows(self.session, 30)), 25)
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "model.joblib"
            with (
                patch("app.ml.train.MODEL_PATH", model_path),
                patch("app.ml.predictor.MODEL_PATH", model_path),
            ):
                result = train_models(self.session)
                self.assertTrue(model_path.is_file())
                bundle = load_models()
                readings = (
                    self.session.query(SensorReading)
                    .order_by(SensorReading.recorded_at.desc())
                    .limit(8)
                    .all()
                )
                readings.reverse()
                predicted = predict_temperature(
                    bundle,
                    30,
                    readings,
                    {
                        "latitude": 13.0827,
                        "longitude": 80.2707,
                        "outside_temperature": 33,
                        "outside_humidity": 60,
                        "apparent_temperature": 35,
                        "precipitation": 0,
                        "precipitation_probability": 0,
                        "wind_speed": 8,
                        "weather_code": 0,
                    },
                    2,
                    8,
                )

        self.assertEqual(result["status"], "success")
        self.assertTrue(all(result["horizons"][str(horizon)]["status"] == "success" for horizon in (15, 30, 60)))
        self.assertTrue(all("mae" in result["horizons"][str(horizon)] for horizon in (15, 30, 60)))
        self.assertIsNotNone(predicted)
        self.assertIn(risk_for_temperature(predicted, 2, 8)[0], {"safe", "warning", "critical"})


if __name__ == "__main__":
    unittest.main()