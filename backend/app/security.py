import hashlib
import hmac
import secrets
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.user import User, UserSession

PASSWORD_HASH_ITERATIONS = 600_000
SESSION_LIFETIME = timedelta(days=14)
bearer_scheme = HTTPBearer(auto_error=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_HASH_ITERATIONS
    )
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded_hash: str) -> bool:
    try:
        salt_hex, digest_hex = encoded_hash.split("$", maxsplit=1)
        salt = bytes.fromhex(salt_hex)
        expected_digest = bytes.fromhex(digest_hex)
    except ValueError:
        return False

    actual_digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_HASH_ITERATIONS
    )
    return hmac.compare_digest(actual_digest, expected_digest)


def issue_session(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    db.add(
        UserSession(
            token_hash=token_hash,
            user_id=user.id,
            expires_at=datetime.now(timezone.utc) + SESSION_LIFETIME,
        )
    )
    db.commit()
    return token


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Sign in to continue")

    token_hash = hashlib.sha256(credentials.credentials.encode("utf-8")).hexdigest()
    session = (
        db.query(UserSession)
        .filter(
            UserSession.token_hash == token_hash,
            UserSession.expires_at > datetime.now(timezone.utc),
        )
        .first()
    )
    if session is None:
        raise HTTPException(status_code=401, detail="Session expired; sign in again")

    user = db.query(User).filter(User.id == session.user_id).first()
    if user is None:
        raise HTTPException(status_code=401, detail="Account no longer exists")
    return user