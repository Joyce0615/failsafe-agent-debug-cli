"""User and account models."""


class User:
    def __init__(self, user_id: str, name: str, email: str | None = None, role: str = "viewer"):
        self.user_id = user_id
        self.name = name
        self.email = email
        self.role = role

    def display_name(self) -> str:
        return f"{self.name} ({self.role})"

    def normalized_email(self) -> str:
        """Returns lowercase email. Bug: no null check."""
        return self.email.lower()


class Account:
    def __init__(self, account_id: str, owner: User, members: list[User] | None = None):
        self.account_id = account_id
        self.owner = owner
        self.members = members or []

    def find_member(self, user_id: str) -> User:
        """Find member by ID. Bug: returns None if not found, but type says User."""
        for member in self.members:
            if member.user_id == user_id:
                return member
        return None  # type: ignore

    def member_emails(self) -> list[str]:
        """Collect all member emails. Bug: calls normalized_email which crashes on None."""
        return [m.normalized_email() for m in self.members]
