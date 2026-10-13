from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer, String

from app.database import Base


class WeatherObservation(Base):
    __tablename__ = "weather_observations"

    id = Column(Integer, primary_key=True, index=True)
    shipment_id = Column(
        String(32),
        ForeignKey("shipments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    location_label = Column(String(300), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    fetched_at = Column(DateTime, nullable=False, index=True)
    forecast_for = Column(DateTime, nullable=False, index=True)
    prediction_horizon_minutes = Column(Integer, nullable=False)
    outside_temperature = Column(Float, nullable=False)
    outside_humidity = Column(Float, nullable=False)
    apparent_temperature = Column(Float, nullable=False)
    precipitation = Column(Float, nullable=False)
    precipitation_probability = Column(Float, nullable=False)
    wind_speed = Column(Float, nullable=False)
    weather_code = Column(Float, nullable=False)