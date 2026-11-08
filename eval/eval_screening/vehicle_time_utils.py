"""模型篩選用評估檔（2026-11-07 建立）。

來源：vehicle_management_system/main.py
函式內容逐字複製自原始檔，未修改邏輯；只調整 import 讓檔案可獨立執行。
"""

from datetime import datetime

def format_eta_time(eta_time):
    if eta_time is None or eta_time == "":
        return ""

    try:
        eta = datetime.strptime(eta_time, "%Y-%m-%d %H:%M:%S")
        return eta.strftime("%m/%d %H:%M")
    except Exception:
        return ""


def get_remaining_text(eta_time):
    if eta_time is None or eta_time == "":
        return "", False

    try:
        eta = datetime.strptime(eta_time, "%Y-%m-%d %H:%M:%S")
        now = datetime.now()
        diff = eta - now
        total_seconds = int(diff.total_seconds())

        if total_seconds < 0:
            overdue_seconds = abs(total_seconds)
            h = overdue_seconds // 3600
            m = (overdue_seconds % 3600) // 60
            return f"超時 {h:02d}:{m:02d}", True

        h = total_seconds // 3600
        m = (total_seconds % 3600) // 60
        return f"剩餘 {h:02d}:{m:02d}", False

    except Exception:
        return "", False


def parse_actual_finish_time(value):
    value = str(value).strip()

    formats = [
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            pass

    return None


def parse_excel_datetime(value):
    """
    將 Excel A欄的出差時間轉成 datetime。
    支援 Excel 真正時間，也支援文字時間。
    """
    if value is None:
        return None

    if isinstance(value, datetime):
        return value

    if isinstance(value, str):
        value = value.strip()

        formats = [
            "%Y/%m/%d %H:%M:%S",
            "%Y/%m/%d %H:%M",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
        ]

        for fmt in formats:
            try:
                return datetime.strptime(value, fmt)
            except ValueError:
                pass

    return None
