import unittest
from bmi import calculate_bmi

class TestCalculateBmi(unittest.TestCase):
    def setUp(self):
        self.weight_kg = 50
        self.height_cm = 160

    def test_calculate_bmi(self):
        bmi, status = calculate_bmi(self.weight_kg, self.height_cm)
        self.assertAlmostEqual(bmi, 25.62, delta=0.01)
        self.assertEqual(status, "健康體位")

    def test_calculate_bmi_underweight(self):
        self.weight_kg = 45
        bmi, status = calculate_bmi(self.weight_kg, self.height_cm)
        self.assertAlmostEqual(bmi, 21.22, delta=0.01)
        self.assertEqual(status, "體重過輕")

    def test_calculate_bmi_overweight(self):
        self.weight_kg = 60
        bmi, status = calculate_bmi(self.weight_kg, self.height_cm)
        self.assertAlmostEqual(bmi, 28.96, delta=0.01)
        self.assertEqual(status, "體重過重")

    def test_calculate_bmi_obese(self):
        self.weight_kg = 80
        bmi, status = calculate_bmi(self.weight_kg, self.height_cm)
        self.assertAlmostEqual(bmi, 32.72, delta=0.01)
        self.assertEqual(status, "肥胖")