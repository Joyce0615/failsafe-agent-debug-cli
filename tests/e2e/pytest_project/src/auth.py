"""Authentication service."""

from .models import User


# Bug: this dict is missing required fields for some providers
PROVIDER_FIELD_MAP = {
    "github": ["id", "login", "email"],
    "google": ["sub", "name", "email"],
    # "gitlab" is missing — will cause KeyError
}


def create_user_from_oauth(provider: str, payload: dict) -> User:
    """Create a user from an OAuth provider payload.

    Bug 1: KeyError when provider is not in PROVIDER_FIELD_MAP.
    Bug 2: payload may not have 'email' field for some providers.
    """
    fields = PROVIDER_FIELD_MAP[provider]  # KeyError if provider unknown

    user_id = str(payload[fields[0]])
    name = str(payload.get(fields[1], "Unknown"))
    email = payload.get(fields[2])  # May be None

    return User(user_id=user_id, name=name, email=email, role="member")


def validate_user(user: User) -> dict:
    """Validate a user object. Bug: crashes when email is None."""
    normalized = user.normalized_email()  # crashes if email is None
    return {
        "valid": True,
        "user_id": user.user_id,
        "email": normalized,
    }
