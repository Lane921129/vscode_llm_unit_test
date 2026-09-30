import unittest
from bmi import calculate_bmi

class TestCalculateBmi(unittest.TestCase):
    def test_calculate_bmi(self):
        self.assertEqual(calculate_bmi(1, 1), (10000.0, '肥胖'))
        self.assertEqual(calculate_bmi(10, 200), (2.5, '體重過輕'))
        self.assertEqual(calculate_bmi(50, 150), (22.22, '健康體位'))
        self.assertEqual(calculate_bmi(100, 200), (25.0, '體重過重'))
        self.assertEqual(calculate_bmi(200, 100), (200.0, '肥胖'))

        with self.assertRaises(TypeError):
            calculate_bmi('a', 'a')
        with self.assertRaises(TypeError):
            calculate_bmi('abc', 'abc')
        with self.assertRaises(TypeError):
            calculate_bmi(1.2, 1.2)
        with self.assertRaises(TypeError):
            calculate_bmi(10.5, 1.2)
        with self.assertRaises(TypeError):
            calculate_bmi(1e2, 1.2)
        with self.assertRaises(TypeError):
            calculate_bmi(1e10, 1.2)
        with self.assertRaises(TypeError):
            calculate_bmi(1e-10, 1.2)
        with self.assertRaises(TypeError):
            calculate_bmi(1e+10, 1.2)
        with self.assertRaises(TypeError):
            calculate_bmi(True, 1.2)
        with self.assertRaises(TypeError):
            calculate_bmi(False, 1.2)
        with self.assertRaises(TypeError):
            calculate_bmi(None, 1.2)

        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(1, 0)
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(10, 0)
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(100, 0)
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(1000, 0)


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
        result = calculate_bmi(200, 100)
        self.assertEqual(result, (200.0, '肥胖'))

    def test_case_7(self):
        result = calculate_bmi(weight_kg=1.2, height_cm=1.2)
        self.assertEqual(result, (8333.33, '肥胖'))

    def test_case_8(self):
        result = calculate_bmi(weight_kg=10.5, height_cm=1.2)
        self.assertEqual(result, (72916.67, '肥胖'))

    def test_case_9(self):
        result = calculate_bmi(weight_kg=100, height_cm=1.2)
        self.assertEqual(result, (694444.44, '肥胖'))

    def test_case_10(self):
        result = calculate_bmi(weight_kg=10000000000, height_cm=1.2)
        self.assertEqual(result, (69444444444444.45, '肥胖'))

    def test_case_11(self):
        result = calculate_bmi(weight_kg=1.2, height_cm=10.5)
        self.assertEqual(result, (108.84, '肥胖'))

    def test_case_12(self):
        result = calculate_bmi(weight_kg=1.2, height_cm=100)
        self.assertEqual(result, (1.2, '體重過輕'))

    def test_case_13(self):
        result = calculate_bmi(weight_kg=1.2, height_cm=10000000000)
        self.assertEqual(result, (0.0, '體重過輕'))

    def test_case_14(self):
        with self.assertRaises(TypeError):
            calculate_bmi("", "")

    def test_case_15(self):
        with self.assertRaises(TypeError):
            calculate_bmi("a", "a")

    def test_case_16(self):
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(0, 0)

    def test_case_17(self):
        with self.assertRaises(TypeError):
            calculate_bmi(None, None)
