"""模型篩選用評估檔（2026-11-07 建立）。

來源：vehicle_management_system/database.py（原本的 DB_NAME 來自 config.DB_PATH，此處改為同資料夾下的 vms_eval.db，匯入時不建立任何檔案）
函式內容逐字複製自原始檔，未修改邏輯；只調整 import 讓檔案可獨立執行。
"""

import sqlite3
from pathlib import Path

DB_NAME = str(Path(__file__).resolve().parent / "vms_eval.db")

def _connect():
    return sqlite3.connect(DB_NAME)


def authenticate_user(login_account, password):
    conn = _connect()
    cur = conn.cursor()

    cur.execute("""
        SELECT login_account, display_name, role
        FROM users
        WHERE login_account = ?
          AND password = ?
          AND is_active = 1
    """, (str(login_account).strip(), str(password).strip()))

    row = cur.fetchone()
    conn.close()

    if row is None:
        return None

    return {
        "login_account": row[0],
        "display_name": row[1],
        "role": row[2],
    }


def get_destination_minutes(destination_name):
    conn = _connect()
    cur = conn.cursor()

    cur.execute("""
        SELECT hours
        FROM destinations
        WHERE destination_name = ?
          AND enabled = 1
    """, (str(destination_name).strip(),))

    row = cur.fetchone()
    conn.close()

    if row is None:
        return None

    return float(row[0]) * 60


def is_car_allowed_for_destination(destination_name, car_no):
    """
    有勾選才回傳 True；沒勾選、沒設定、非白名單都回傳 False。
    """
    conn = _connect()
    cur = conn.cursor()

    cur.execute("""
        SELECT COUNT(*)
        FROM destination_car_whitelist
        WHERE destination_name = ?
          AND car_no = ?
          AND enabled = 1
    """, (str(destination_name).strip(), str(car_no).strip()))

    count = cur.fetchone()[0]
    conn.close()
    return count > 0
