import unittest
from unittest.mock import patch

from bmi import calculate_bmi

class TestCalculateBMI(unittest.TestCase):
    def test_calculate_bmi_with_valid_inputs(self):
        weight_kg = 1
        height_cm = 1
        expected_bmi = 10000.0
        expected_status = '肥胖'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_invalid_inputs(self):
        weight_kg = -1
        height_cm = -1
        expected_bmi = -10000.0
        expected_status = '體重過輕'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_inputs(self):
        weight_kg = 10
        height_cm = 200
        expected_bmi = 2.5
        expected_status = '體重過輕'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_inputs_2(self):
        weight_kg = 50
        height_cm = 150
        expected_bmi = 22.22
        expected_status = '健康體位'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_inputs_3(self):
        weight_kg = 100
        height_cm = 200
        expected_bmi = 25.0
        expected_status = '體重過重'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_zero_inputs(self):
        weight_kg = 0
        height_cm = 0
        expected_bmi = 0.0
        expected_status = '體重過輕'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_negative_inputs(self):
        weight_kg = -1
        height_cm = -1
        expected_bmi = -10000.0
        expected_status = '體重過輕'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_strings_inputs(self):
        weight_kg = 'a'
        height_cm = 'a'
        expected_bmi = 0.0
        expected_status = '體重過輕'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_invalid_inputs(self):
        weight_kg = -1
        height_cm = -1
        expected_bmi = -10000.0
        expected_status = '體重過輕'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_inputs(self):
        weight_kg = 10
        height_cm = 200
        expected_bmi = 2.5
        expected_status = '體重過輕'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_inputs_2(self):
        weight_kg = 50
        height_cm = 150
        expected_bmi = 22.22
        expected_status = '健康體位'
        bmi, status = calculate_bmi(weight_kg, height_cm)
        self.assertAlmostEqual(bmi, expected_bmi)
        self.assertEqual(status, expected_status)

    def test_calculate_bmi_with_different_inputs_3(self):
        weight_kg = 100
        height_cm = 200
        expected_bmi = 25.0
        expected_status = '體重過重'
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
        result = calculate_bmi(weight_kg=-1, height_cm=-1)
        self.assertEqual(result, (-10000.0, '體重過輕'))

    def test_case_7(self):
        result = calculate_bmi(weight_kg=0, height_cm=-1)
        self.assertEqual(result, (0.0, '體重過輕'))

    def test_case_8(self):
        result = calculate_bmi(weight_kg=1.5, height_cm=-1)
        self.assertEqual(result, (15000.0, '肥胖'))

    def test_case_9(self):
        result = calculate_bmi(weight_kg=-1, height_cm=1.5)
        self.assertEqual(result, (-4444.44, '體重過輕'))

    def test_case_10(self):
        result = calculate_bmi(0.00185, 1)
        self.assertEqual(result, (18.5, '健康體位'))

    def test_case_11(self):
        result = calculate_bmi(1, 23.249527748763857)
        self.assertEqual(result, (18.5, '健康體位'))

    def test_case_12(self):
        result = calculate_bmi(0.0024000000000000002, 1)
        self.assertEqual(result, (24.0, '體重過重'))

    def test_case_13(self):
        result = calculate_bmi(1, 20.41241452319315)
        self.assertEqual(result, (24.0, '體重過重'))

    def test_case_14(self):
        result = calculate_bmi(0.0027, 1)
        self.assertEqual(result, (27.0, '肥胖'))

    def test_case_15(self):
        with self.assertRaises(TypeError):
            calculate_bmi("", "")

    def test_case_16(self):
        with self.assertRaises(TypeError):
            calculate_bmi("a", "a")

    def test_case_17(self):
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(0, 0)

    def test_case_18(self):
        with self.assertRaises(TypeError):
            calculate_bmi(None, None)

    def test_case_19(self):
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(weight_kg=-1, height_cm=0)


if __name__ == '__main__':
    unittest.main()
