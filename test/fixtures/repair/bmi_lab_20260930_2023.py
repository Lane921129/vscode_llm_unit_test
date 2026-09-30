import unittest
from unittest.mock import patch

from bmi import calculate_bmi

class TestCalculateBMI(unittest.TestCase):
    def test_calculate_bmi_with_valid_inputs(self):
        weight_kg = 50
        height_cm = 160
        expected_bmi = 22.22
        expected_status = "健康體位"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_invalid_inputs(self):
        weight_kg = -1
        height_cm = -1
        expected_bmi = -1
        expected_status = "體重過輕"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_values(self):
        weight_kg = 100
        height_cm = 200
        expected_bmi = 25.0
        expected_status = "體重過重"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_zero_division(self):
        weight_kg = 0
        height_cm = 0
        expected_bmi = 0
        expected_status = "體重過輕"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_input_types(self):
        weight_kg = "50"
        height_cm = "160"
        expected_bmi = 22.22
        expected_status = "健康體位"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_output_types(self):
        weight_kg = 50
        height_cm = 160
        expected_bmi = 22.22
        expected_status = "健康體位"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertEqual(type(bmi), float)
        self.assertEqual(type(status), str)
        self.assertEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_zero_weight(self):
        weight_kg = 0
        height_cm = 160
        expected_bmi = 0.0
        expected_status = "體重過輕"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_negative_weight(self):
        weight_kg = -10
        height_cm = 160
        expected_bmi = -0.1
        expected_status = "體重過輕"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_zero_height(self):
        weight_kg = 50
        height_cm = 0
        expected_bmi = 0.0
        expected_status = "體重過輕"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_negative_height(self):
        weight_kg = 50
        height_cm = -10
        expected_bmi = -0.1
        expected_status = "體重過輕"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_height_units(self):
        weight_kg = 50
        height_cm = 16000
        expected_bmi = 22.22
        expected_status = "健康體位"

        bmi, status = calculate_bmi(weight_kg, height_cm)

        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)


# Verified behavior-observation tests (not model-authored)
class TestVerifiedTrace_calculate_bmi(unittest.TestCase):
    def test_case_1(self):
        result = calculate_bmi(1, 1)
        self.assertEqual(result, (10000.0, '肥胖'))

    def test_case_2(self):
        result = calculate_bmi(-1, -1)
        self.assertEqual(result, (-10000.0, '體重過輕'))

    def test_case_3(self):
        result = calculate_bmi(10, 200)
        self.assertEqual(result, (2.5, '體重過輕'))

    def test_case_4(self):
        result = calculate_bmi(50, 150)
        self.assertEqual(result, (22.22, '健康體位'))

    def test_case_5(self):
        result = calculate_bmi(100, 200)
        self.assertEqual(result, (25.0, '體重過重'))

    def test_case_6(self):
        with self.assertRaises(TypeError):
            calculate_bmi("", "")

    def test_case_7(self):
        with self.assertRaises(TypeError):
            calculate_bmi("a", "a")

    def test_case_8(self):
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(0, 0)

    def test_case_9(self):
        with self.assertRaises(TypeError):
            calculate_bmi(None, None)


if __name__ == '__main__':
    unittest.main()
