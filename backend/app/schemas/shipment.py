from pydantic import BaseModel, Field, model_validator


class ShipmentCreate(BaseModel):
    origin_label: str = Field(min_length=1, max_length=300)
    origin_latitude: float = Field(ge=-90, le=90)
    origin_longitude: float = Field(ge=-180, le=180)
    destination_label: str = Field(min_length=1, max_length=300)
    destination_latitude: float = Field(ge=-90, le=90)
    destination_longitude: float = Field(ge=-180, le=180)
    temperature_min: float = Field(ge=-40, le=50)
    temperature_max: float = Field(ge=-40, le=50)
    pharmacy_user_id: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_temperature_range(self):
        if self.temperature_min > self.temperature_max:
            raise ValueError("Minimum temperature cannot exceed maximum temperature")
        return self