"""Shared test fixtures."""

import sys
import os
import pytest

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.models import User, Account


@pytest.fixture
def admin_user():
    return User(user_id="u1", name="Alice", email="alice@example.com", role="admin")


@pytest.fixture
def viewer_user():
    return User(user_id="u2", name="Bob", email="bob@example.com", role="viewer")


@pytest.fixture
def no_email_user():
    """User without an email (e.g., from an OAuth provider that doesn't share email)."""
    return User(user_id="u3", name="Charlie", email=None, role="member")


@pytest.fixture
def test_account(admin_user, viewer_user, no_email_user):
    return Account(
        account_id="acc1",
        owner=admin_user,
        members=[admin_user, viewer_user, no_email_user],
    )
