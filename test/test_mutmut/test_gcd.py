import unittest
from gcd import gcd
class Test(unittest.TestCase):
    def test_g(self): self.assertEqual(gcd(2,2), 3)
