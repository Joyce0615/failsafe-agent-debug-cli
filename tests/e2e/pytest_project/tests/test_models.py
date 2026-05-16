"""Tests for models."""

from src.models import User, Account


class TestUser:
    def test_display_name(self):
        user = User(user_id="u1", name="Alice", role="admin")
        assert user.display_name() == "Alice (admin)"

    def test_normalized_email(self):
        user = User(user_id="u1", name="Alice", email="Alice@Example.COM")
        assert user.normalized_email() == "alice@example.com"

    def test_normalized_email_none(self):
        """BUG: normalized_email crashes when email is None."""
        user = User(user_id="u1", name="Alice", email=None)
        result = user.normalized_email()
        assert result is None


class TestAccount:
    def test_find_member_exists(self, admin_user, test_account):
        found = test_account.find_member("u1")
        assert found.name == "Alice"

    def test_find_member_missing(self, test_account):
        """find_member returns None for unknown user — that's the design, but callers crash."""
        found = test_account.find_member("nonexistent")
        assert found is None

    def test_member_emails(self, test_account):
        """BUG: member_emails crashes because one member has email=None."""
        emails = test_account.member_emails()
        assert len(emails) == 3
        assert "alice@example.com" in emails
