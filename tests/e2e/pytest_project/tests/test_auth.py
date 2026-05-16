"""Tests for the auth module."""

from src.auth import create_user_from_oauth, validate_user


class TestCreateUserFromOAuth:
    def test_github_login(self):
        """Should create user from GitHub OAuth payload."""
        payload = {"id": 12345, "login": "alice", "email": "alice@github.com"}
        user = create_user_from_oauth("github", payload)
        assert user.user_id == "12345"
        assert user.name == "alice"
        assert user.email == "alice@github.com"

    def test_google_login(self):
        """Should create user from Google OAuth payload."""
        payload = {"sub": "g-001", "name": "Bob", "email": "bob@gmail.com"}
        user = create_user_from_oauth("google", payload)
        assert user.user_id == "g-001"
        assert user.email == "bob@gmail.com"

    def test_gitlab_login(self):
        """BUG: GitLab is not in PROVIDER_FIELD_MAP → KeyError."""
        payload = {"id": 99, "username": "charlie", "email": "charlie@gitlab.com"}
        user = create_user_from_oauth("gitlab", payload)
        assert user.user_id == "99"

    def test_github_without_email(self):
        """BUG: Some GitHub users have private email → email is None."""
        payload = {"id": 555, "login": "ghost"}
        user = create_user_from_oauth("github", payload)
        # This passes, but validate_user will crash later
        assert user.email is None


class TestValidateUser:
    def test_validates_normal_user(self, admin_user):
        result = validate_user(admin_user)
        assert result["valid"] is True
        assert result["email"] == "alice@example.com"

    def test_validates_user_without_email(self, no_email_user):
        """BUG: validate_user calls normalized_email() which crashes on None email."""
        result = validate_user(no_email_user)
        assert result["valid"] is True
