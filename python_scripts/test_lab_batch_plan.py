import unittest
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lab_batch_plan import resolve_lab_batch


class LabBatchPlanTests(unittest.TestCase):
    def test_resolves_exactly_one_fixture_for_each_planned_category(self):
        plan = resolve_lab_batch()
        self.assertEqual(plan['batch_name'], 'five-category-lab-batch')
        self.assertEqual(len(plan['categories']), 5)
        self.assertEqual(
            [item['id'] for item in plan['fixtures']],
            [
                'tier1-boundary',
                'tier1-class-method',
                'tier3-database-context',
                'tier4-async-context',
                'tier3-http-client',
            ],
        )


if __name__ == '__main__':
    unittest.main()
