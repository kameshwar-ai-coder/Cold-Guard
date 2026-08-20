from fastapi import FastAPI
from sqlalchemy import text

from app.database import engine, Base
from app.models.device import Device
from app.models.sensor_reading import SensorReading
from app.routes.sensor import router as sensor_router

# Create database tables
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="ColdGuard",
    description="IoT-based medicine temperature monitoring system",
    version="1.0.0"
)
app.include_router(sensor_router)


@app.get("/")
def root():
    return {
        "message": "ColdGuard backend is running"
    }


@app.get("/health")
def health():
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))

        return {
            "status": "healthy",
            "database": "connected"
        }

    except Exception as e:
        return {
            "status": "unhealthy",
            "database": "connection failed",
            "error": str(e)
        }
    