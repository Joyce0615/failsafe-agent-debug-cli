"""A small calculator with a bug, used for debug stepping demo."""


def divide_items(items, divisor):
    """Divide each item by divisor. Bug: no zero check."""
    results = []
    for item in items:
        results.append(item / divisor)
    return results


def average(values):
    """Compute average. Bug: empty list causes ZeroDivisionError."""
    total = sum(values)
    count = len(values)
    return total / count


def process_data(data):
    """Process a data dict. Bug: missing key."""
    name = data["name"]
    scores = data["scores"]
    avg = average(scores)
    return {"name": name, "average": avg, "grade": "A" if avg >= 90 else "B"}
