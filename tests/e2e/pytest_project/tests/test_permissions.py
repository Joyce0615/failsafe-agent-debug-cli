"""Tests for permissions."""

from src.permissions import can_edit, get_account_permissions


class TestCanEdit:
    def test_admin_can_edit(self, admin_user):
        assert can_edit(admin_user) is True

    def test_viewer_cannot_edit(self, viewer_user):
        assert can_edit(viewer_user) is False

    def test_editor_can_edit(self):
        from src.models import User
        editor = User(user_id="u4", name="Dana", role="editor")
        assert can_edit(editor) is True

    def test_unknown_role(self):
        """Edge case: role not in hierarchy should not be able to edit."""
        from src.models import User
        user = User(user_id="u5", name="Eve", role="superadmin")
        # BUG: 'superadmin' gets level 0 but the test expects it should edit
        assert can_edit(user) is True


class TestGetAccountPermissions:
    def test_known_member(self, test_account):
        perms = get_account_permissions(test_account, "u1")
        assert perms["role"] == "admin"
        assert perms["can_edit"] is True

    def test_unknown_member(self, test_account):
        """BUG: find_member returns None → AttributeError on .role."""
        perms = get_account_permissions(test_account, "nonexistent")
        assert perms["role"] is None
