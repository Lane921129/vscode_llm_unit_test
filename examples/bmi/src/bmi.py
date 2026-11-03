"""Pure BMI functions: kilograms and centimetres; no input, files or GUI on import."""
import math


def positive_number(value: float) -> float:
    """Return a finite positive int/float as float; reject bool and other types."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("value must be an int or float")
    try:
        number = float(value)
    except OverflowError:
        raise ValueError("value is outside the supported numeric range") from None
    if not math.isfinite(number) or number <= 0:
        raise ValueError("value must be finite and greater than zero")
    return number


def calculate_bmi(weight_kg: float, height_cm: float) -> float:
    """Return unrounded BMI. Both inputs must be finite positive numbers."""
    weight = positive_number(weight_kg)
    height_m = positive_number(height_cm) / 100
    square = height_m * height_m
    if not math.isfinite(square) or square == 0:
        raise ValueError("height is outside the supported numeric range")
    result = weight / square
    if not math.isfinite(result) or result <= 0:
        raise ValueError("BMI is outside the supported numeric range")
    return result


def classify_bmi(bmi: float) -> str:
    """Example specification: boundaries are 18.5, 24 and 27; use unrounded BMI."""
    value = positive_number(bmi)
    if value < 18.5:
        return "體重過輕"
    if value < 24:
        return "健康體位"
    if value < 27:
        return "體重過重"
    return "肥胖"


def bmi_report(weight_kg: float, height_cm: float) -> dict:
    """Classify the unrounded result; round only the displayed BMI to two decimals."""
    value = calculate_bmi(weight_kg, height_cm)
    return {"bmi": round(value, 2), "category": classify_bmi(value)}
