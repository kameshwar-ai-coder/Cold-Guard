from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.sensor_reading import SensorReading
from app.schemas.sensor import SensorData

router = APIRouter(
    prefix="/api",
    tags=["Sensor Data"]
)


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()


@router.post("/sensor-data")
def receive_sensor_data(
    data: SensorData,
    db: Session = Depends(get_db)
):
    reading = SensorReading(
        device_id=data.device_id,
        temperature=data.temperature,
        humidity=data.humidity
    )

    db.add(reading)
    db.commit()
    db.refresh(reading)

    return {
        "message": "Sensor data received",
        "reading_id": reading.id,
        "device_id": reading.device_id,
        "temperature": reading.temperature,
        "humidity": reading.humidity
    }