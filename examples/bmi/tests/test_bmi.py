import unittest
from src.bmi import positive_number, calculate_bmi, classify_bmi, bmi_report


class BmiTests(unittest.TestCase):
    def test_positive_number(self):
        self.assertEqual(positive_number(5), 5.0)

    def test_known_bmi(self):
        self.assertEqual(calculate_bmi(80, 200), 20.0)
        self.assertAlmostEqual(calculate_bmi(60, 170), 20.7612456747)

    def test_category_boundaries(self):
        for value, category in [(18.49, "體重過輕"), (18.5, "健康體位"), (23.99, "健康體位"),
                                (24, "體重過重"), (26.99, "體重過重"), (27, "肥胖")]:
            with self.subTest(value=value):
                self.assertEqual(classify_bmi(value), category)

    def test_invalid_numeric_values(self):
        for value in [0, -1, float("nan"), float("inf"), -float("inf")]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    positive_number(value)
                with self.assertRaises(ValueError):
                    calculate_bmi(value, 170)
                with self.assertRaises(ValueError):
                    calculate_bmi(60, value)
                with self.assertRaises(ValueError):
                    classify_bmi(value)

    def test_invalid_types(self):
        for value in [True, False, "60", None, [], {}]:
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    positive_number(value)
                with self.assertRaises(TypeError):
                    calculate_bmi(value, 170)

    def test_extreme_values(self):
        for weight, height in [(1, 1e308), (1, 1e-300), (1e308, 1e-100), (1e-300, 1e100)]:
            with self.subTest(weight=weight, height=height):
                with self.assertRaises(ValueError):
                    calculate_bmi(weight, height)
        with self.assertRaises(ValueError):
            positive_number(10 ** 400)

    def test_report(self):
        self.assertEqual(bmi_report(80, 200), {"bmi": 20.0, "category": "健康體位"})

    def test_classification_precedes_display_rounding(self):
        self.assertEqual(bmi_report(95.996, 200), {"bmi": 24.0, "category": "健康體位"})


if __name__ == "__main__":
    unittest.main()
