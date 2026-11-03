"""Optional CLI. Importing this module never requests input or starts a UI."""
import argparse
from src.bmi import bmi_report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="BMI 計算範例：公斤、公分")
    parser.add_argument("weight", type=float, help="體重（公斤）")
    parser.add_argument("height", type=float, help="身高（公分）")
    args = parser.parse_args()
    try:
        report = bmi_report(args.weight, args.height)
    except (TypeError, ValueError) as error:
        parser.error(str(error))
    print(f"BMI: {report['bmi']:.2f}，分類: {report['category']}")
