"""模型篩選用評估檔（2026-11-07 建立）。

來源：vehicle_management_system/config.py
函式內容逐字複製自原始檔，未修改邏輯；只調整 import 讓檔案可獨立執行。
"""

from pathlib import Path
import sys

def get_app_dir():
    """
    開發階段：回傳 .py 所在資料夾
    打包成 exe 後：回傳 VMS.exe 所在資料夾
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent

    return Path(__file__).resolve().parent
