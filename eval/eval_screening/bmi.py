def calculate_bmi(weight_kg, height_cm):
    """計算並回傳 BMI 指數與對應的體重狀態

    :param weight_kg: 體重（公斤）
    :param height_cm: 身高（公分）
    """
    # 將身高由公分換算為公尺
    height_m = height_cm / 100

    # 計算 BMI（保留小數點後兩位）
    bmi = round(weight_kg / (height_m**2), 2)

    # 判斷體重狀態（依據台灣衛福部標準）
    if bmi < 18.5:
        status = "體重過輕"
    elif 18.5 <= bmi < 24:
        status = "健康體位"
    elif 24 <= bmi < 27:
        status = "體重過重"
    else:
        status = "肥胖"

    return bmi, status