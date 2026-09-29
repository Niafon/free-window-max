"""Reproducible PDF deck. Requires reportlab, Pillow; --private embeds local secrets.
Public: python scripts/build-presentation.py
Private: python scripts/build-presentation.py --private (only after HTTPS is configured)
"""
from pathlib import Path
import argparse, os, subprocess, html
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.lib.utils import ImageReader
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
args = argparse.ArgumentParser()
args.add_argument('--private', action='store_true')
args.add_argument('--commit', default='')
opts = args.parse_args()
env = {}
if opts.private:
    for line in (ROOT / '.env').read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1); env[key] = value.strip().strip('"')
    if not env.get('PUBLIC_URL', '').startswith('https://') or '.example.' in env['PUBLIC_URL']:
        raise SystemExit('Configure a real HTTPS PUBLIC_URL first. No private PDF created.')
    if not env.get('BOT_TOKEN'):
        raise SystemExit('BOT_TOKEN missing. No private PDF created.')
commit = opts.commit or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
out = ROOT / ('private/reviewer-presentation.pdf' if opts.private else 'docs/presentation.pdf')
out.parent.mkdir(parents=True, exist_ok=True)
font_candidates = [(Path('C:/Windows/Fonts/arial.ttf'), Path('C:/Windows/Fonts/arialbd.ttf')),
                   (Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))]
regular, bold = next((a,b) for a,b in font_candidates if a.exists() and b.exists())
pdfmetrics.registerFont(TTFont('UI', str(regular))); pdfmetrics.registerFont(TTFont('UIBold', str(bold)))
pdfmetrics.registerFontFamily('UI', normal='UI', bold='UIBold')
W, H = 960, 540
ink, purple, muted = '#29243D', '#6B50D8', '#716A81'
paper, pale, mint = '#FAF9FC', '#EEE8FC', '#DEF0D7'
c = canvas.Canvas(str(out), pagesize=(W,H))
c.setTitle('ОКНО — Свободное окно в MAX'); c.setAuthor('Niafon')
page = 0
def rect(x,y,w,h,color,r=14):
    c.setFillColor(HexColor(color)); c.roundRect(x,H-y-h,w,h,r,stroke=0,fill=1)
def text(value,x,y,w=860,size=18,color=ink,bold=False,leading=None):
    style=ParagraphStyle('p',fontName='UIBold' if bold else 'UI',fontSize=size,leading=leading or size*1.32,textColor=HexColor(color))
    p=Paragraph(value,style); _,height=p.wrap(w,H)
    if y+height>(532 if y>=514 else 507): raise ValueError(f'Overflow on slide {page}: {value[:70]}')
    p.drawOn(c,x,H-y-height); return height
def begin(label,title,dark=False):
    global page
    page+=1; rect(0,0,W,H,purple if dark else paper,0)
    text(label.upper(),44,24,820,10,'#DBD1FF' if dark else purple,True)
    if title: text(title,44,63,870,32,'#FFFFFF' if dark else ink,True)
    text('ОКНО / время на своё',44,514,600,9,'#DBD1FF' if dark else muted)
    text(f'{page:02}',879,514,36,9,'#DBD1FF' if dark else muted)
def end(): c.showPage()
def card(x,y,w,title,body,color=pale):
    rect(x,y,w,160,color); text(title,x+20,y+18,w-40,21,purple,True); text(body,x+20,y+59,w-40,15)
def shot(file,box,x,y,w,h):
    path=ROOT/file
    if not path.exists(): return
    im=Image.open(path)
    if box: im=im.crop(box)
    c.drawImage(ImageReader(im),x,H-y-h,width=w,height=h,preserveAspectRatio=True,anchor='c',mask='auto')

begin('Служебный слайд · техническая проверка','Доступ и версия MVP')
text('Бот: <link href="https://max.ru/t398_hakaton_max_bot">max.ru/t398_hakaton_max_bot</link><br/>Git: <link href="https://github.com/Niafon/free-window-max">github.com/Niafon/free-window-max</link><br/>Commit реализации: '+commit,44,117,870,12)
api=env.get('PUBLIC_URL','HTTPS API: ожидает VPS; okno.example.com — плейсхолдер')
text(html.escape(api)+'<br/>Локальный вход: localhost:3000 · имена Аня и Борис в разных профилях браузера.<br/>MAX: собственные аккаунты с подписанным initData. Админская роль не нужна.',44,179,870,13)
if opts.private:
    keys=['BOT_TOKEN','BOT_USERNAME','MAX_API_URL','MAX_MODE','MAX_WEBHOOK_SECRET','YANDEX_MAPS_KEY','YANDEX_DAILY_LIMIT','DEMO_AUTH','DEMO_ACCESS_KEY']
    text('<br/>'.join(html.escape(k+'='+env.get(k,'')) for k in keys),44,253,870,9,leading=12)
    text('ЗАКРЫТЫЙ СЛАЙД: содержит секреты. Только для технических проверяющих.',44,384,870,12,purple,True)
else:
    rect(44,253,872,126,pale)
    text('Секреты передаются отдельно',61,268,820,18,purple,True)
    text('BOT_TOKEN, YANDEX_MAPS_KEY, MAX_WEBHOOK_SECRET — только локальный .env.<br/>На публичном демо дополнительно DEMO_ACCESS_KEY. Обычному демо ключи не нужны.<br/>После VPS: scripts/build-presentation.py --private → закрытая версия вне Git.',61,299,820,12)
text('Проверка: вход → окно 18:30–21:30 → 1 000 ₽ / 30 мин → подбор → выбор.<br/>Компания: приглашение → второй участник с бюджетом 500 ₽ → общий результат.<br/>Контракт: OpenAPI 3.0.3 + DATA-API.yaml. Привязка HTTPS к боту и MAX E2E — после VPS.',44,407,870,13)
end()

begin('MVP для MAX · Москва','',True)
text('ОКНО.',44,114,760,80,'#FFFFFF',True)
text('Есть свободное время.<br/>Есть выполнимый план.',49,223,810,37,'#FFFFFF',True)
text('Досуг с учётом бюджета, дороги и возвращения.<br/>Для одного человека и компании до пяти друзей.',49,340,760,20,'#EEE7FF')
text('Владелец репозитория: Niafon. Состав команды уточняется владельцем.',49,455,820,12,'#DBD1FF')
end()

begin('Проблема и аудитория','Свободное окно уходит на поиск')
card(44,135,270,'Афиша','Найти событие, цену и подходящий сеанс.')
card(345,135,270,'Карты','Проверить, успеешь ли туда и обратно.')
card(646,135,270,'Переписка','Согласовать время и ограничения друзей.')
text('Первый сегмент: студенты МИРЭА 18–24 лет,<br/>Москва, 1–4 часа после занятий.',44,326,520,24,ink,True)
rect(629,318,287,145,mint)
text('41%',651,328,244,44,purple,True)
text('россиян говорят, что свободного<br/>времени достаточно. ВЦИОМ, 2025.',651,390,243,14)
text('Опрос 11.04.2025: n=1600, 18+, телефон; погрешность ≤2,5 п.п. при 95%. Это общий контекст, не исследование студентов.',44,482,870,9,muted)
end()

begin('Основной сценарий','От времени — к конкретному плану')
for x,n,title,body in [(44,'01','Задать окно','Дата, время, бюджет,<br/>точка старта и интересы.'),(270,'02','Сравнить варианты','Цена, дорога, возврат<br/>и причины рекомендации.'),(496,'03','Выбрать план','Карточка доступна<br/>по ссылке 24 часа.'),(722,'04','Пойти вместе','Приглашение в MAX<br/>или маршрут в Картах.')]:
    rect(x,145,194,205,pale); text(n,x+19,162,155,36,purple,True); text(title,x+19,221,157,19,ink,True); text(body,x+19,280,157,13)
text('Результат — несколько вариантов, в которые пользователь успевает.<br/>Если вариантов нет, ОКНО объясняет причину и предлагает посчитанный компромисс.',44,390,860,21)
end()

begin('Интерфейс MVP','Все ограничения — в одной форме')
shot(Path('docs/assets/desktop.png'),(263,410,1405,1065),44,124,872,358)
text('Снимок работающего интерфейса. Деморежим подписан; реальные данные включаются отдельным действием.',44,483,870,10,muted)
end()

begin('Логика выбора','Сначала проверяем. Потом рекомендуем.')
card(44,135,420,'Жёсткие условия','Бюджет + проезд · время · возраст<br/>дорога в обе стороны · исключения<br/>10 минут запаса в каждую сторону')
card(495,135,421,'Мягкий рейтинг','Интересы 35% · дорога 25%<br/>цена 15% · запас времени 15%<br/>полнота данных 10%',mint)
text('Для компании проходит только то, что подходит каждому.',44,329,870,25,ink,True)
text('Групповой балл = 70% среднего + 30% минимального.<br/>Неизвестная цена или неполное расписание не превращаются в вымышленные числа.<br/>Высокий балл никогда не отменяет обязательные условия.',44,383,860,18)
end()

begin('Совместное планирование','Разные ограничения. Один общий вариант.')
card(44,139,270,'Аня','18:30–21:30<br/>до 1 000 ₽ · дорога 30 мин')
card(345,139,270,'Борис','18:30–21:30<br/>до 500 ₽ · дорога 30 мин',mint)
card(646,139,270,'Общий план','450 ₽ на человека<br/>с возвратом в общее окно')
text('Приглашение через MAX → отдельные параметры → готовность участников → подбор.',44,338,870,21,ink,True)
text('Пример на учебных данных. До 5 участников, общий выбор делает создатель.<br/>Изменились параметры — старый результат сбрасывается.<br/>Точные точки старта другим участникам не раскрываются.',44,405,870,17)
end()

begin('Техническая реализация','Один сервис. Понятные границы.')
for x,title,body in [(44,'React + MAX UI','Mini App · Bridge<br/>Zustand · Query'),(345,'Fastify / Node 22','Zod · алгоритм<br/>MAX Bot SDK'),(646,'PostgreSQL 17','PostGIS · Drizzle<br/>компании · планы · квота')]: card(x,140,270,title,body)
text('KudaGo → события и источники. Яндекс Matrix → реальное время пути.<br/>Docker Compose → воспроизводимый запуск. Caddy → HTTPS на будущей VPS.',44,343,870,22)
text('HMAC initData · секрет webhook · ограничения доступа · TTL · ключи вне Git.<br/>Без LLM, оплаты и продажи билетов; основной сценарий не зависит от генерации текста.',44,431,870,16,muted)
end()

begin('Источники и честность','Демо и реальные данные различимы')
card(44,133,420,'Демо без внешних вызовов','10 учебных событий Москвы.<br/>Таблица маршрутов для 4 точек.<br/>События и цены явно смоделированы.')
card(495,133,421,'KudaGo + Яндекс Matrix','Точные цена и расписание.<br/>Источник и время получения в карточке.<br/>Наличие билетов уточняется у организатора.',mint)
text('Ключ Яндекса: 100 запросов в сутки.<br/>Защитный предел приложения: 80. Тесты не расходуют квоту.',44,328,870,23,ink,True)
text('До 20 запросов на человека за один реальный подбор; выбор и открытие плана без новых запросов.<br/>Реальные маршруты в БД не сохраняются. Недостаток данных может дать пустой результат.',44,420,870,16,muted)
end()

begin('Проверка версии','Сценарии проверены локально')
for x,num,title in [(44,'40','unit / integration'),(345,'4','браузерных сценария'),(646,'19','DATA-API проверок')]:
    rect(x,145,270,165,pale); text(num,x+20,159,230,60,purple,True); text(title,x+20,257,235,18,ink,True)
text('Два независимых пользователя · desktop и mobile viewport<br/>Подпись, права доступа, бюджет, возвращение и сбои источников.',44,345,870,23)
text('Подключения MAX / KudaGo / Яндекс проверены отдельно. Реальных вызовов Matrix — один.<br/>Docker в GitHub Actions: сборка 22 секунды; полный стек и API-проверки проходят.<br/>Проверки в установленных MAX-клиентах ещё нужны после подключения VPS.',44,428,870,14,muted)
end()

begin('Пилот и масштабирование','Сначала доказать пользу в одном кампусе')
card(44,139,270,'Неделя 1','10–15 интервью.<br/>Наблюдение за выбором досуга.')
card(345,139,270,'Недели 2–3','30–50 добровольцев.<br/>Одиночные и групповые задания.',mint)
card(646,139,270,'Неделя 4','Разбор пустых выдач.<br/>Решение о следующем пилоте.')
text('Цель-гипотеза: медиана выбора меньше 3 минут.',44,337,870,27,purple,True)
text('Измерить конверсию поиска в выбор, пустые результаты и время согласования.<br/>Затем другие кампусы Москвы; новый город — после проверки источников и тарифа.<br/>Интервью и пилот ещё не проведены. Партнёрство с МИРЭА не заявляется.',44,398,870,18)
end()

begin('Ограничения и завершение запуска','Что требуется перед сдачей')
for y,num,title,body in [(131,'01','VPS и домен','Заполнить шаблон, получить HTTPS, привязать Mini App и webhook MAX.'),(217,'02','Реальная приёмка','Пройти solo/group в MAX mobile и web. Docker build в CI уже уложился в 22 секунды.'),(303,'03','Закрытая передача','Дать проверяющим доступ к private Git, сформировать служебный слайд с ключами.'),(389,'04','Фиксация версии','Указать команду и commit. После дедлайна не менять переданные материалы.')]:
    text(num,44,y,68,30,purple,True); text(title,120,y,760,21,ink,True); text(body,120,y+34,770,15)
end()

begin('Материалы и источники','Проверяемые основания решения')
sources=[('Бриф «Досуг и развлечения»','PDF заказчика: требования, формат сдачи и критерии оценки.'),('MAX: Bridge, проверка подписи, Bot API','https://dev.max.ru/docs/webapps/validation'),('KudaGo API','https://docs.kudago.com/api/'),('Яндекс Matrix и коммерческие условия','https://yandex.ru/dev/distance_matrix/doc/ru/request'),('ВЦИОМ: «Досуг: хорошо, но мало!», 05.05.2025','https://wciom.ru/analytical-reviews/analiticheskii-obzor/dosug-khorosho-no-malo')]
for i,(title,url) in enumerate(sources):
    y=128+i*61; text(title,44,y,870,17,ink,True); text(html.escape(url),44,y+26,870,12,muted)
text('Гипотезы пилота, реальные ограничения и полный порядок проверки — в README и docs/.',44,462,870,16,purple)
end()
c.save()
print(f'Created {out.name}: {page} slides. Private={opts.private}')
