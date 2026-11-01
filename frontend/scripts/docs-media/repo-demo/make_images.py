"""Draws the fictional Acme demo repository's images (repo-demo/acme-docs/docs/{logo,images}).

    backend/.venv/bin/python frontend/scripts/docs-media/repo-demo/make_images.py

Plain shapes only (Pillow): a logo mark, a favicon, a dashboard and a share dialog. Deterministic,
so re-running produces the same bytes.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent / "acme-docs" / "docs"
BLUE = (37, 99, 235)
INK = (17, 24, 39)
MUTED = (107, 114, 128)
LINE = (229, 231, 235)
BG = (249, 250, 251)


def font(size: int):
    for name in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def logo(path: Path, text_color, size=(360, 96)):
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((8, 8, 88, 88), radius=20, fill=BLUE)
    d.text((48, 48), "A", font=font(52), fill="white", anchor="mm")
    d.text((110, 48), "Acme", font=font(54), fill=text_color, anchor="lm")
    img.save(path, optimize=True)


def favicon(path: Path):
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, 63, 63), radius=14, fill=BLUE)
    d.text((32, 33), "A", font=font(40), fill="white", anchor="mm")
    img.save(path, optimize=True)


def dashboard(path: Path):
    w, h = 1280, 760
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, w, 64), fill="white", outline=LINE)
    d.rounded_rectangle((24, 16, 56, 48), radius=8, fill=BLUE)
    d.text((72, 32), "Growth", font=font(22), fill=INK, anchor="lm")
    for i, (label, value) in enumerate((("Signups", "1,284"), ("Revenue", "$48.2k"), ("Churn", "1.9%"))):
        x = 24 + i * 416
        d.rounded_rectangle((x, 88, x + 392, 208), radius=14, fill="white", outline=LINE)
        d.text((x + 24, 120), label, font=font(18), fill=MUTED, anchor="lm")
        d.text((x + 24, 168), value, font=font(36), fill=INK, anchor="lm")
    d.rounded_rectangle((24, 232, w - 24, 520), radius=14, fill="white", outline=LINE)
    d.text((48, 262), "Revenue, last 30 days", font=font(18), fill=INK, anchor="lm")
    pts = [(64 + i * 39, 470 - int(((i * 37) % 90) + i * 5.5)) for i in range(30)]
    d.line(pts, fill=BLUE, width=5, joint="curve")
    d.rounded_rectangle((24, 544, w - 24, h - 24), radius=14, fill="white", outline=LINE)
    for r in range(4):
        y = 580 + r * 36
        d.line((48, y + 18, w - 48, y + 18), fill=LINE, width=1)
        d.rounded_rectangle((48, y - 8, 300, y + 8), radius=8, fill=(209, 213, 219))
        d.rounded_rectangle((900, y - 8, 1000, y + 8), radius=8, fill=(191, 219, 254))
    img.save(path, optimize=True)


def share(path: Path):
    w, h = 960, 540
    img = Image.new("RGB", (w, h), (229, 231, 235))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((180, 90, 780, 450), radius=18, fill="white", outline=LINE)
    d.text((216, 136), "Share “Growth”", font=font(26), fill=INK, anchor="lm")
    d.text((216, 186), "Anyone with the link can view", font=font(18), fill=MUTED, anchor="lm")
    d.rounded_rectangle((216, 222, 744, 274), radius=10, fill=BG, outline=LINE)
    d.text((236, 248), "https://app.acme.com/s/8f2k1", font=font(18), fill=INK, anchor="lm")
    d.rounded_rectangle((216, 300, 420, 348), radius=10, fill=BLUE)
    d.text((318, 324), "Copy link", font=font(18), fill="white", anchor="mm")
    d.text((216, 396), "Expires in 30 days", font=font(16), fill=MUTED, anchor="lm")
    img.save(path, optimize=True)


if __name__ == "__main__":
    (HERE / "logo").mkdir(parents=True, exist_ok=True)
    (HERE / "images").mkdir(parents=True, exist_ok=True)
    logo(HERE / "logo" / "light.png", INK)
    logo(HERE / "logo" / "dark.png", (243, 244, 246))
    favicon(HERE / "logo" / "favicon.png")
    dashboard(HERE / "images" / "dashboard.png")
    share(HERE / "images" / "share.png")
    print("wrote", sorted(str(p.relative_to(HERE)) for p in HERE.rglob("*.png")))
