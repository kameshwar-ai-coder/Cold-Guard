from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.sql import func

from app.database import Base


class Shipment(Base):
    __tablename__ = "shipments"

    id = Column(String(32), primary_key=True)
    origin_label = Column(String(300), nullable=False)
    origin_latitude = Column(Float, nullable=False)
    origin_longitude = Column(Float, nullable=False)
    destination_label = Column(String(300), nullable=False)
    destination_latitude = Column(Float, nullable=False)
    destination_longitude = Column(Float, nullable=False)
    temperature_min = Column(Float, nullable=False)
    temperature_max = Column(Float, nullable=False)
    status = Column(String(20), nullable=False, default="pending", index=True)
    created_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    pharmacy_user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)