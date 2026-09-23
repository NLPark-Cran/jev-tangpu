import urllib.request, json, io, os, base64
KEY = os.environ['TOKENDANCE_API_KEY']
URL = 'https://tokendance.space/gateway/ark/v3/images/generations'
OUT = os.path.join(os.path.dirname(__file__), '..', 'site', 'assets')

STYLE = ('厚涂插画风格，温暖暗调，电影感侧光，主色深褐与陶土橙，细腻质感，构图有留白，'
         '画面中不要出现任何文字、字母、数字、水印、标志或界面元素。')

JOBS = {
  'L1': '一只打开的空瓦楞纸快递箱放在小区驿站的取件柜台上，箱底躺着半包开口的猫粮，纸箱内壁有两道新鲜刀痕，夜晚驿站灯光昏黄，旁边是成排的取件货架。',
  'L2': '深夜书桌上一只不锈钢保温壶立在台灯下，旁边散落着游标卡尺和一片盐雾测试后露出底材的金属试片，窗外是凌晨的深蓝色，台灯光在壶身上切出一道亮边。',
  'L3': '深夜宿舍书桌上一把机械键盘，空格与四个常用键位的键帽缺失、露出轴体，旁边摊着写到一半的稿纸和一杯凉掉的茶，一盏小台灯压得很低。',
  'L4': '深夜的一张木质办公桌，暖黄台灯照着一把鼠标和一杯正冒热气的茶，旁边一摞整齐的白纸，电脑屏幕发出柔和的白光、看不见屏幕内容，窗外是安静的城市夜景。',
  'L5': '凌晨三点的空书桌，一部手机面朝上发出幽蓝的光、看不见屏幕内容，旁边几张被划掉的便签纸和一支旧钢笔，窗外是熄灯的城市，远处有一栋亮着灯的图书馆建筑剪影。',
  'cover': '一只戴着小围裙的知更鸟站在一口热气腾腾的砂锅后面，像一间深夜汤铺的掌柜，柜台上摆着一只空碗和一双筷子，暖黄灯笼光从上方打下来。',
}


def gen(name, prompt):
    body = json.dumps({
        'model': 'seedream-5.0-pro',
        'prompt': prompt + STYLE,
        'size': '2K',
        'output_format': 'jpeg',
        'response_format': 'url',
        'watermark': False,
    }, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(URL, data=body, headers={
        'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    r = urllib.request.urlopen(req, timeout=180)
    d = json.loads(r.read().decode())
    item = (d.get('data') or [d])[0]
    url = item.get('url') or item.get('b64_json')
    if url.startswith('http'):
        img = urllib.request.urlopen(url, timeout=120).read()
    else:
        img = base64.b64decode(url.split(',')[-1])
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name + '.jpg')
    io.open(p, 'wb').write(img)
    return len(img)


for name, prompt in [(k, v) for k, v in JOBS.items() if k == 'L4']:
    try:
        n = gen(name, prompt)
        print('OK', name, n, 'bytes', flush=True)
    except Exception as e:
        try:
            print('FAIL', name, e.read().decode('utf-8', 'replace')[:400], flush=True)
        except Exception:
            print('FAIL', name, repr(e), flush=True)
print('done')
