from core import process, Engine


def handle():
    e = Engine()
    return e.run() + process(2)
