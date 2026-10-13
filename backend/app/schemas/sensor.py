from pydantic import BaseModel, Field, model_validator


class SensorData(BaseModel):
    device_id: str = Field(..., min_length=1)
    temperature: float
    humidity: float
    shipment_id: str | None = Field(default=None, min_length=1, max_length=32)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)

    @model_validator(mode="after")
    def validate_location_context(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("Latitude and longitude must be provided together")
        if (self.shipment_id is None) != (self.latitude is None):
            raise ValueError("Shipment ID and GPS coordinates must be provided together")
        return self