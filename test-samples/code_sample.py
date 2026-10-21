"""QuickPreview 代码文件预览测试样本。"""
from dataclasses import dataclass


@dataclass
class Sample:
    name: str
    size: int


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


if __name__ == "__main__":
    for s in (Sample("a.png", 1234), Sample("b.mp4", 5 * 1024 * 1024)):
        print(s.name, human(s.size))
