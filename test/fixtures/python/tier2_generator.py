def every_second(values):
    for index, value in enumerate(values):
        if index % 2 == 0:
            yield value
