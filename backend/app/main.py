from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500", "http://localhost:5500", "http://127.0.0.1:4173", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
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
    