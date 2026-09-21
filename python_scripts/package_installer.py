"""Run the selected interpreter's pip without importing a project-local pip.py."""
import runpy


if __name__ == '__main__':
    runpy.run_module('pip', run_name='__main__', alter_sys=True)
