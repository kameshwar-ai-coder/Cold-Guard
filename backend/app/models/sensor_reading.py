from sqlalchemy import Column, Integer, String, Float, DateTime
from sqlalchemy.sql import func

from app.database import Base


class SensorReading(Base):
    __tablename__ = "sensor_readings"

    id = Column(Integer, primary_key=True, index=True)

    device_id = Column(
        String,
        nullable=False,
        index=True
    )

    temperature = Column(
        Float,
        nullable=False
    )

    humidity = Column(
        Float,
        nullable=False
    )

    recorded_at = Column(
        DateTime,
        server_default=func.now(),
        nullable=False
    )