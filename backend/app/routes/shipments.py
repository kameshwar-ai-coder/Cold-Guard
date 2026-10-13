import asyncio
import json
import time
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from datetime import timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.models.shipment import Shipment
from app.models.user import User
from app.schemas.shipment import ShipmentCreate
from app.security import get_current_user, get_db

router = APIRouter(prefix="/api", tags=["Shipments"])
location_cache: dict[str, tuple[float, list[dict]]] = {}
location_cache_seconds = 300
last_location_request = 0.0
location_request_lock = asyncio.Lock()


def require_role(user: User, role: str) -> None:
    if user.role != role:
        raise HTTPException(status_code=403, detail="You do not have access to this action")


def shipment_response(shipment: Shipment, pharmacy_user_name: str) -> dict:
    created_at = shipment.created_at
    if created_at is not None and created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    return {
        "id": shipment.id,
        "origin": {
            "label": shipment.origin_label,
            "coordinates": [shipment.origin_latitude, shipment.origin_longitude],
        },
        "destination": {
            "label": shipment.destination_label,
            "coordinates": [shipment.destination_latitude, shipment.destination_longitude],
        },
        "location": shipment.destination_label,
        "min": shipment.temperature_min,
        "max": shipment.temperature_max,
        "status": shipment.status,
        "created_at": created_at.isoformat() if created_at else None,
        "pharmacy_user_id": shipment.pharmacy_user_id,
        "pharmacy_user_name": pharmacy_user_name,
    }


def fetch_nominatim(query: str) -> list[dict]:
    parameters = urlencode({"q": query, "format": "jsonv2", "limit": 5, "addressdetails": 1})
    request = Request(
        f"https://nominatim.openstreetmap.org/search?{parameters}",
        headers={"User-Agent": "ColdGuard/1.0 (cold-chain shipment dashboard)"},
    )
    with urlopen(request, timeout=6) as response:
        places = json.loads(response.read().decode("utf-8"))

    results = []
    seen_labels = set()
    for place in places:
        label = place.get("display_name")
        latitude = float(place["lat"])
        longitude = float(place["lon"])
        if not label or label in seen_labels:
            continue
        seen_labels.add(label)
        results.append({"label": label, "coordinates": [latitude, longitude]})
    return results


@router.get("/locations")
async def search_locations(
    q: str = Query(min_length=2, max_length=200),
    current_user: User = Depends(get_current_user),
):
    require_role(current_user, "transport")
    global last_location_request
    query = q.strip()
    cache_key = query.casefold()
    cached = location_cache.get(cache_key)
    now = time.monotonic()
    if cached and now - cached[0] < location_cache_seconds:
        return {"results": cached[1]}

    async with location_request_lock:
        cached = location_cache.get(cache_key)
        now = time.monotonic()
        if cached and now - cached[0] < location_cache_seconds:
            return {"results": cached[1]}
        wait_seconds = max(0, 1 - (now - last_location_request))
        if wait_seconds:
            await asyncio.sleep(wait_seconds)
        last_location_request = time.monotonic()
        try:
            results = await asyncio.to_thread(fetch_nominatim, query)
        except (URLError, TimeoutError, json.JSONDecodeError, KeyError, ValueError) as error:
            raise HTTPException(status_code=502, detail="Location search is temporarily unavailable") from error
        location_cache[cache_key] = (time.monotonic(), results)
        return {"results": results}


@router.get("/pharmacy-users")
def pharmacy_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_role(current_user, "transport")
    users = db.query(User).filter(User.role == "pharmacy").order_by(User.name).all()
    return [{"id": user.id, "name": user.name, "email": user.email} for user in users]


@router.get("/shipments")
def list_shipments(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role == "pharmacy":
        query = db.query(Shipment).filter(Shipment.pharmacy_user_id == current_user.id)
    else:
        query = db.query(Shipment).filter(Shipment.created_by_user_id == current_user.id)
    shipments = (
        query.join(User, Shipment.pharmacy_user_id == User.id)
        .add_columns(User.name)
        .order_by(Shipment.created_at.asc(), Shipment.id.asc())
        .all()
    )
    return [shipment_response(shipment, pharmacy_user_name) for shipment, pharmacy_user_name in shipments]


@router.post("/shipments", status_code=status.HTTP_201_CREATED)
def create_shipment(
    data: ShipmentCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_role(current_user, "transport")
    pharmacy_user = (
        db.query(User)
        .filter(User.id == data.pharmacy_user_id, User.role == "pharmacy")
        .first()
    )
    if pharmacy_user is None:
        raise HTTPException(status_code=404, detail="Pharmacy account was not found")

    shipment = Shipment(
        id=uuid4().hex,
        origin_label=data.origin_label.strip(),
        origin_latitude=data.origin_latitude,
        origin_longitude=data.origin_longitude,
        destination_label=data.destination_label.strip(),
        destination_latitude=data.destination_latitude,
        destination_longitude=data.destination_longitude,
        temperature_min=data.temperature_min,
        temperature_max=data.temperature_max,
        created_by_user_id=current_user.id,
        pharmacy_user_id=pharmacy_user.id,
    )
    db.add(shipment)
    db.commit()
    db.refresh(shipment)
    return shipment_response(shipment, pharmacy_user.name)


@router.post("/shipments/{shipment_id}/complete")
def complete_shipment(
    shipment_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role == "pharmacy":
        queue_filter = Shipment.pharmacy_user_id == current_user.id
    elif current_user.role == "transport":
        queue_filter = Shipment.created_by_user_id == current_user.id
    else:
        raise HTTPException(status_code=403, detail="You do not have access to this action")

    next_shipment = (
        db.query(Shipment)
        .filter(queue_filter, Shipment.status == "pending")
        .order_by(Shipment.created_at.asc(), Shipment.id.asc())
        .with_for_update()
        .first()
    )
    if next_shipment is None:
        raise HTTPException(status_code=404, detail="No pending shipments were found")
    if next_shipment.id != shipment_id:
        raise HTTPException(status_code=409, detail="Complete shipments in first-in, first-out order")

    next_shipment.status = "delivered"
    pharmacy_user = db.query(User).filter(User.id == next_shipment.pharmacy_user_id).first()
    db.commit()
    db.refresh(next_shipment)
    return shipment_response(next_shipment, pharmacy_user.name if pharmacy_user else "")