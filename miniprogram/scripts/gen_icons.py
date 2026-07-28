"""生成 tabBar 图标（普通态灰色 + 选中态微信绿），输出至 assets/tabbar/。"""
from PIL import Image, ImageDraw
import os

SIZE = 81
GRAY = (138, 138, 138, 255)   # 对应 tabBar color #888888
GREEN = (7, 193, 96, 255)     # 对应 selectedColor #07c160
WHITE = (255, 255, 255, 255)


def canvas():
    return Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))


def draw_home(d, c):
    # 定位 pin：头部圆 + 下方尖角 + 中心镂空
    d.ellipse([27, 10, 54, 37], fill=c)
    d.polygon([(27, 33), (54, 33), (40, 71)], fill=c)
    d.ellipse([35, 18, 46, 29], fill=WHITE)


def draw_feedback(d, c):
    # 对话气泡：圆角矩形 + 左下小尾巴 + 三个白点
    d.rounded_rectangle([14, 16, 67, 52], radius=11, fill=c)
    d.polygon([(22, 48), (37, 48), (22, 67)], fill=c)
    for cx in (28, 40, 52):
        d.ellipse([cx - 3, 31, cx + 3, 37], fill=WHITE)


def draw_about(d, c):
    # 信息 i：圆环 + 顶部圆点 + 竖线
    d.ellipse([20, 20, 61, 61], outline=c, width=5)
    d.ellipse([37, 27, 45, 35], fill=c)
    d.rectangle([38, 40, 42, 55], fill=c)


icons = {
    'home': draw_home,
    'feedback': draw_feedback,
    'about': draw_about,
}

out = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'assets', 'tabbar'))
os.makedirs(out, exist_ok=True)

for name, fn in icons.items():
    for suffix, color in (('', GRAY), ('_active', GREEN)):
        img = canvas()
        fn(ImageDraw.Draw(img), color)
        path = os.path.join(out, f'{name}{suffix}.png')
        img.save(path)
        print('wrote', path)

print('files:', sorted(os.listdir(out)))
