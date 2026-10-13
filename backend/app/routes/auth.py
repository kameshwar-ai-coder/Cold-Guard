import hashlib

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.user import User, UserSession
from app.schemas.auth import AccountCreate, AccountLogin
from app.security import bearer_scheme, get_current_user, get_db, hash_password, issue_session, verify_password

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


def account_response(user: User, token: str) -> dict:
    return {
        "token": token,
        "user": {"id": user.id, "name": user.name, "email": user.email, "role": user.role},
    }


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(data: AccountCreate, db: Session = Depends(get_db)):
    user = User(
        name=data.name,
        email=data.email,
        password_hash=hash_password(data.password),
        role=data.role,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="An account with this email already exists") from error
    db.refresh(user)
    return account_response(user, issue_session(db, user))


@router.post("/login")
def login(data: AccountLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect")
    return account_response(user, issue_session(db, user))


@router.get("/me")
def current_account(user: User = Depends(get_current_user)):
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if credentials is not None:
        token_hash = hashlib.sha256(credentials.credentials.encode("utf-8")).hexdigest()
        db.query(UserSession).filter(
            UserSession.token_hash == token_hash,
            UserSession.user_id == user.id,
        ).delete(synchronize_session=False)
        db.commit()