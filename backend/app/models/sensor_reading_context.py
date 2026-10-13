from sqlalchemy import Column, Float, ForeignKey, String

from app.database import Base


class SensorReadingContext(Base):
    __tablename__ = "sensor_reading_contexts"

    reading_id = Column(
        ForeignKey("sensor_readings.id", ondelete="CASCADE"),
        primary_key=True,
    )
    shipment_id = Column(
        String(32),
        ForeignKey("shipments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)