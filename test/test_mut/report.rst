Mutatest diagnostic summary
===========================
 - Source location: D:\read\專題\vscode_llm_unit_test\test_mut\gcd.py
 - Test commands: ['python', '-m', 'unittest', 'test_gcd.py']
 - Mode: s
 - Excluded files: []
 - N locations input: 10
 - Random seed: None

Random sample details
---------------------
 - Total locations mutated: 1
 - Total locations identified: 1
 - Location sample coverage: 100.00 %


Running time details
--------------------
 - Clean trial 1 run time: 0:00:00.126233
 - Clean trial 2 run time: 0:00:00.114678
 - Mutation trials total run time: 0:00:00.740828

Overall mutation trial summary
==============================
 - DETECTED: 6
 - TOTAL RUNS: 6
 - RUN DATETIME: 2026-05-21 23:16:46.448384


Mutations by result status
==========================


DETECTED
--------
 - gcd.py: (l: 1, c: 21) - mutation from <class 'ast.Add'> to <class 'ast.Mod'>
 - gcd.py: (l: 1, c: 21) - mutation from <class 'ast.Add'> to <class 'ast.Div'>
 - gcd.py: (l: 1, c: 21) - mutation from <class 'ast.Add'> to <class 'ast.Pow'>
 - gcd.py: (l: 1, c: 21) - mutation from <class 'ast.Add'> to <class 'ast.FloorDiv'>
 - gcd.py: (l: 1, c: 21) - mutation from <class 'ast.Add'> to <class 'ast.Sub'>
 - gcd.py: (l: 1, c: 21) - mutation from <class 'ast.Add'> to <class 'ast.Mult'>