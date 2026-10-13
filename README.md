# ColdGuard

ColdGuard is a FastAPI backend for monitoring medicine storage conditions. It receives temperature and humidity readings from connected devices and stores them in PostgreSQL.

## Features

- Receive sensor readings through a REST API
- Persist readings with SQLAlchemy
- Check API and database health
- Explore interactive API documentation through FastAPI
- Register password-protected Transport and Pharmacy accounts
- Assign shipments to a Pharmacy account and share route details

## Requirements

- Python 3.10 or newer
- PostgreSQL

## Setup

1. Create and activate a virtual environment inside `backend`:

   ```powershell
   cd backend
   python -m venv venv
   .\venv\Scripts\Activate.ps1
   ```

2. Install the backend dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

3. Create `backend/.env` and set the PostgreSQL connection string:

   ```env
   DATABASE_URL=postgresql://<username>:<password>@localhost:5432/<database>
   ```

   Ensure the PostgreSQL server is running and the database already exists.

## Run the API

From the `backend` directory with the virtual environment activated:

```powershell
uvicorn app.main:app --reload
```

The API is available at `http://127.0.0.1:8000`.

Interactive documentation is available at:

- Swagger UI: `http://127.0.0.1:8000/docs`
- ReDoc: `http://127.0.0.1:8000/redoc`

## Run the Dashboard

In a second terminal from the project root:

```powershell
cd dashboard
python -m http.server 5500 --bind 127.0.0.1
```

Open `http://127.0.0.1:5500/`, choose **Create an account**, and register Transport and Pharmacy accounts. Passwords must be at least 8 characters. A Transport user can create a shipment and assign it to a registered Pharmacy user; only that Pharmacy account can view the assigned order.

Passwords are hashed in the backend database. Sign-in sessions expire after 14 days.

## API Endpoints

### `GET /`

Returns a basic running status message.

### `GET /health`

Checks whether the API can connect to the database.

### `POST /api/sensor-data`

Submit a sensor reading:

```json
{
  "device_id": "fridge-001",
  "temperature": 4.2,
  "humidity": 48.5
}
```

Example request:

```powershell
curl -Method POST http://127.0.0.1:8000/api/sensor-data `
  -Headers @{ "Content-Type" = "application/json" } `
  -Body '{"device_id":"fridge-001","temperature":4.2,"humidity":48.5}'
```

### Account and shipment endpoints

- `POST /api/auth/register` and `POST /api/auth/login` create accounts and issue sessions.
- `GET /api/auth/me` returns the signed-in account; `POST /api/auth/logout` revokes its session.
- `GET /api/pharmacy-users` lists Pharmacy accounts for authenticated Transport users.
- `GET /api/shipments` returns shipments created by Transport users or assigned to the signed-in Pharmacy user.
- `POST /api/shipments` creates a shipment for a selected Pharmacy account.
- `POST /api/shipments/{shipment_id}/complete` completes the oldest pending shipment; later shipments are rejected until earlier ones are complete.
- `GET /api/locations?q=<search>` returns cached location suggestions for authenticated Transport users.

### Weather-aware ML prediction

- `GET /api/ml/prediction?horizon_minutes=30` returns Open-Meteo external route forecasts and, when a trained model is available, the predicted future container temperature and predicted risk. Supported horizons are 15, 30, and 60 minutes. The endpoint requires an authenticated user.
- `POST /api/ml/train` trains and evaluates horizon-specific Random Forest regressors using a chronological 80/20 split. It requires an authenticated Transport user. Metrics are returned only when calculated from a real holdout set.
- Open-Meteo forecasts are cached in memory for 15 minutes and persisted in the `weather_observations` table. Startup creates the new weather/context tables without altering existing sensor or shipment tables.
- Existing sensor requests remain valid. To contribute labeled history to training, a sender must additionally provide the shipment and actual GPS coordinates for each reading:

   ```json
   {
      "device_id": "fridge-001",
      "temperature": 4.2,
      "humidity": 48.5,
      "shipment_id": "shipment-id",
      "latitude": 13.0827,
      "longitude": 80.2707
   }
   ```

   These fields are stored in the separate `sensor_reading_contexts` table. Old readings are never assigned invented shipment, GPS, or weather data; timestamp-aligned old readings can still train the sensor-history-only fallback.
- Weather-aware training uses only real, shipment-linked GPS readings with a matching forecast captured by the base reading time. If those examples are insufficient, training falls back to sensor-only features and real future container readings; those models do not learn weather or location effects.
- Each horizon needs at least 25 aligned observations and a chronological holdout before its Random Forest model and MAE/RMSE/R² evaluation are saved or reported. Negative holdout R² is exposed as a low-fit experimental warning.
- Train through the authenticated API (also available in Swagger UI at `/docs`):

   ```powershell
   $headers = @{ Authorization = "Bearer <session-token>" }
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/ml/train -Headers $headers
   ```

If paired weather/sensor history is insufficient, training reports that condition and prediction remains unavailable while the existing rule-based dashboard assessment continues to operate. No model artifact or performance metrics are created in advance.

## Project Structure

```text
backend/
└── app/
    ├── database.py          # SQLAlchemy engine and sessions
    ├── main.py              # FastAPI application
    ├── models/              # Database models
    ├── routes/              # API route handlers
    └── schemas/             # Request and response schemas
```

## Notes

Database tables are created automatically when the application starts. Keep `.env` out of version control and use environment-specific credentials for deployments.