from pydantic import BaseModel, Field


class SensorData(BaseModel):
    device_id: str = Field(..., min_length=1)
    temperature: float
    humidity: float