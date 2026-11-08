"""模型篩選用評估檔（2026-11-07 建立）。

來源：validators-master/src/validators/ 的 iban.py、mac_address.py、slug.py、uuid.py
函式內容逐字複製自原始檔，未修改邏輯；只調整 import 讓檔案可獨立執行。
"""

import re
from typing import Union
from uuid import UUID

from validators_utils import validator

def _char_value(char: str):
    """A=10, B=11, ..., Z=35 (case-insensitive)."""
    return char if char.isdigit() else str(10 + ord(char.upper()) - ord("A"))


def _mod_check(value: str):
    """Check if the value string passes the mod97-test."""
    # move country code and check numbers to end
    rearranged = value[4:] + value[:4]
    return int("".join(_char_value(char) for char in rearranged)) % 97 == 1


@validator
def iban(value: str, /):
    """Return whether or not given value is a valid IBAN code.

    Examples:
        >>> iban('DE29100500001061045672')
        True
        >>> iban('123456')
        ValidationError(func=iban, args={'value': '123456'})

    Args:
        value:
            IBAN string to validate.

    Returns:
        (Literal[True]): If `value` is a valid IBAN code.
        (ValidationError): If `value` is an invalid IBAN code.
    """
    return (
        (
            re.match(r"^[a-z]{2}[0-9]{2}[a-z0-9]{11,30}$", value, re.IGNORECASE | re.ASCII)
            and _mod_check(value)
        )
        if value
        else False
    )


@validator
def mac_address(value: str, /):
    """Return whether or not given value is a valid MAC address.

    This validator is based on [WTForms MacAddress validator][1].

    [1]: https://github.com/wtforms/wtforms/blob/master/src/wtforms/validators.py#L482

    Examples:
        >>> mac_address('01:23:45:67:ab:CD')
        True
        >>> mac_address('00:00:00:00:00')
        ValidationError(func=mac_address, args={'value': '00:00:00:00:00'})

    Args:
        value:
            MAC address string to validate.

    Returns:
        (Literal[True]): If `value` is a valid MAC address.
        (ValidationError): If `value` is an invalid MAC address.
    """
    # Check for mixed separators: MAC addresses cannot use both ':' and '-' simultaneously
    if ":" in value and "-" in value:
        return False

    return re.fullmatch(r"^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$", value) if value else False


_SLUG_REGEXP = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


@validator
def slug(value: str, /):
    """Validate whether or not given value is valid slug.

    Valid slug can contain only lowercase alphanumeric characters and hyphens.
    It starts and ends with these lowercase alphanumeric characters.

    Examples:
        >>> slug('my-slug-2134')
        True
        >>> slug('my.slug')
        ValidationError(func=slug, args={'value': 'my.slug'})

    Args:
        value: Slug string to validate.

    Returns:
        (Literal[True]): If `value` is a valid slug.
        (ValidationError): If `value` is an invalid slug.
    """
    return _SLUG_REGEXP.fullmatch(value) is not None


@validator
def uuid(value: Union[str, UUID], /):
    """Return whether or not given value is a valid UUID-v4 string.

    This validator is based on [WTForms UUID validator][1].

    [1]: https://github.com/wtforms/wtforms/blob/master/src/wtforms/validators.py#L539

    Examples:
        >>> uuid('2bc1c94f-0deb-43e9-92a1-4775189ec9f8')
        True
        >>> uuid('2bc1c94f 0deb-43e9-92a1-4775189ec9f8')
        ValidationError(func=uuid, args={'value': '2bc1c94f 0deb-43e9-92a1-4775189ec9f8'})

    Args:
        value:
            UUID string or object to validate.

    Returns:
        (Literal[True]): If `value` is a valid UUID.
        (ValidationError): If `value` is an invalid UUID.
    """
    if not value:
        return False
    if isinstance(value, UUID):
        return True
    try:
        return UUID(value) or re.match(
            r"^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", value
        )
    except ValueError:
        return False
