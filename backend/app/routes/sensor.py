from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.models.sensor_reading import SensorReading
from app.models.sensor_reading_context import SensorReadingContext
from app.models.shipment import Shipment
from app.schemas.sensor import SensorData
from app.security import get_db

router = APIRouter(
    prefix="/api",
    tags=["Sensor Data"]
)


@router.post("/sensor-data")
def receive_sensor_data(
    data: SensorData,
    db: Session = Depends(get_db)
):
    if data.shipment_id is not None:
        shipment_exists = db.query(Shipment.id).filter(Shipment.id == data.shipment_id).first()
        if shipment_exists is None:
            raise HTTPException(status_code=404, detail="Shipment was not found")

    reading = SensorReading(
        device_id=data.device_id,
        temperature=data.temperature,
        humidity=data.humidity
    )

    db.add(reading)
    db.commit()
    db.refresh(reading)

    if data.shipment_id is not None:
        db.add(
            SensorReadingContext(
                reading_id=reading.id,
                shipment_id=data.shipment_id,
                latitude=data.latitude,
                longitude=data.longitude,
            )
        )
        db.commit()

    return {
        "message": "Sensor data received",
        "reading_id": reading.id,
        "device_id": reading.device_id,
        "temperature": reading.temperature,
        "humidity": reading.humidity
    }
@router.get("/sensor-data")
def get_sensor_data(db: Session = Depends(get_db)):
    readings = db.query(SensorReading).order_by(
        SensorReading.recorded_at.desc()
    ).limit(50).all()

    return readings