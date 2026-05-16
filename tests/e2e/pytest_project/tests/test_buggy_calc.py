"""Tests for buggy_calc — used for debug stepping demo."""

from src.buggy_calc import divide_items, average, process_data


def test_divide_items_normal():
    assert divide_items([10, 20, 30], 2) == [5.0, 10.0, 15.0]


def test_divide_items_by_zero():
    """BUG: ZeroDivisionError"""
    assert divide_items([10, 20], 0) == []


def test_average_normal():
    assert average([80, 90, 100]) == 90.0


def test_average_empty():
    """BUG: ZeroDivisionError on empty list"""
    assert average([]) == 0


def test_process_data_complete():
    data = {"name": "Alice", "scores": [85, 92, 78]}
    result = process_data(data)
    assert result["name"] == "Alice"
    assert result["grade"] == "B"


def test_process_data_missing_scores():
    """BUG: KeyError on missing 'scores' key"""
    data = {"name": "Bob"}
    result = process_data(data)
    assert result["average"] == 0
