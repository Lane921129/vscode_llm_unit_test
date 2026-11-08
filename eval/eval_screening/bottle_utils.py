"""模型篩選用評估檔（2026-11-07 建立）。

來源：bottle-main/bottle.py
函式內容逐字複製自原始檔，未修改邏輯；只調整 import 讓檔案可獨立執行。
"""

import base64
import calendar
import email.utils

def tob(s, enc='utf8'):
    if isinstance(s, str):
        return s.encode(enc)
    return b'' if s is None else bytes(s)


def touni(s, enc='utf8', err='strict'):
    if isinstance(s, (bytes, bytearray)):
        return str(s, enc, err)
    return "" if s is None else str(s)


def html_escape(string):
    """ Escape HTML special characters ``&<>`` and quotes ``'"``. """
    return string.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')\
                 .replace('"', '&quot;').replace("'", '&#039;')


def html_quote(string):
    """ Escape and quote a string to be used as an HTTP attribute."""
    return '"%s"' % html_escape(string).replace('\n', '&#10;') \
        .replace('\r', '&#13;').replace('\t', '&#9;')


def parse_auth(header):
    """ Parse rfc2617 HTTP authentication header string (basic) and return (user,pass) tuple or None"""
    try:
        method, data = header.split(None, 1)
        if method.lower() == 'basic':
            user, pwd = touni(base64.b64decode(tob(data))).split(':', 1)
            return user, pwd
    except (KeyError, ValueError):
        return None


def parse_date(ims):
    """ Parse rfc1123, rfc850 and asctime timestamps and return UTC epoch. """
    try:
        ts = email.utils.parsedate_tz(ims)
        return calendar.timegm(ts[:8] + (0, )) - (ts[9] or 0)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def parse_range_header(header, maxlen=0):
    """ Yield (start, end) ranges parsed from a HTTP Range header. Skip
        unsatisfiable ranges. The end index is non-inclusive."""
    if not header or header[:6] != 'bytes=': return
    ranges = [r.split('-', 1) for r in header[6:].split(',') if '-' in r]
    for start, end in ranges:
        try:
            if not start:  # bytes=-100    -> last 100 bytes
                start, end = max(0, maxlen - int(end)), maxlen
            elif not end:  # bytes=100-    -> all but the first 99 bytes
                start, end = int(start), maxlen
            else:  # bytes=100-200 -> bytes 100-200 (inclusive)
                start, end = int(start), min(int(end) + 1, maxlen)
            if 0 <= start < end <= maxlen:
                yield start, end
        except ValueError:
            pass


def path_shift(script_name, path_info, shift=1):
    """ Shift path fragments from PATH_INFO to SCRIPT_NAME and vice versa.

        :return: The modified paths.
        :param script_name: The SCRIPT_NAME path.
        :param script_name: The PATH_INFO path.
        :param shift: The number of path fragments to shift. May be negative to
          change the shift direction. (default: 1)
    """
    if shift == 0: return script_name, path_info
    pathlist = path_info.strip('/').split('/')
    scriptlist = script_name.strip('/').split('/')
    if pathlist and pathlist[0] == '': pathlist = []
    if scriptlist and scriptlist[0] == '': scriptlist = []
    if 0 < shift <= len(pathlist):
        moved = pathlist[:shift]
        scriptlist = scriptlist + moved
        pathlist = pathlist[shift:]
    elif 0 > shift >= -len(scriptlist):
        moved = scriptlist[shift:]
        pathlist = moved + pathlist
        scriptlist = scriptlist[:shift]
    else:
        empty = 'SCRIPT_NAME' if shift < 0 else 'PATH_INFO'
        raise AssertionError("Cannot shift. Nothing left from %s" % empty)
    new_script_name = '/' + '/'.join(scriptlist)
    new_path_info = '/' + '/'.join(pathlist)
    if path_info.endswith('/') and pathlist: new_path_info += '/'
    return new_script_name, new_path_info
