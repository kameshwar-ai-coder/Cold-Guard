# ColdGuard

ColdGuard is a FastAPI backend for monitoring medicine storage conditions. It receives temperature and humidity readings from connected devices and stores them in PostgreSQL.

## Features

- Receive sensor readings through a REST API
- Persist readings with SQLAlchemy
- Check API and database health
- Explore interactive API documentation through FastAPI

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
   pip install fastapi uvicorn sqlalchemy psycopg2-binary python-dotenv
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