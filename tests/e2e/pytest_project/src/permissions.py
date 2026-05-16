"""Permission checking."""

from .models import Account, User

ROLE_HIERARCHY = {
    "admin": 3,
    "editor": 2,
    "viewer": 1,
}


def can_edit(user: User) -> bool:
    """Check if user can edit. Bug: role not in hierarchy returns wrong result."""
    level = ROLE_HIERARCHY.get(user.role, 0)
    return level >= 2


def get_account_permissions(account: Account, user_id: str) -> dict:
    """Get permissions for a user in an account.

    Bug: find_member returns None for unknown users, then we access .role on None.
    """
    member = account.find_member(user_id)
    return {
        "user_id": user_id,
        "role": member.role,  # AttributeError if member is None
        "can_edit": can_edit(member),
    }
